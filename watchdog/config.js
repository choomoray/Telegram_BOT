// watchdog/config.js
/**
 * 看门狗配置：只依赖 Node 内置模块与 .env，**不 require 项目里的任何模块**，
 * 这样 bot 侧的故障（语法错误、依赖问题、循环引用）不会把看门狗一起带走。
 *
 * 启动方式：看门狗是唯一入口，参数照搬（与直接启动 bot 完全一致）
 *   node watchdog.js             -> node index.js
 *   node watchdog.js webui       -> node index.js webui
 *   node watchdog.js test        -> node index.js test
 *   node watchdog.js --test      -> node index.js --test
 * 崩溃后会用**同一份参数**重新拉起，保证「按用户的启动方式重启」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 极简 .env 读取（与 config.js 逻辑一致，但不引入项目模块） */
function loadEnv() {
    const envPath = path.join(ROOT, '.env');
    const out = {};
    try {
        if (!fs.existsSync(envPath)) return out;
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            if (!line || line.trimStart().startsWith('#')) continue;
            const idx = line.indexOf('=');
            if (idx <= 0) continue;
            const key = line.slice(0, idx).trim();
            if (!key) continue;
            out[key] = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        }
    } catch {
        // 读不到就用环境变量 / 默认值
    }
    return out;
}

const fileEnv = loadEnv();

/** 取值优先级：真实环境变量 > .env > 默认值 */
function envValue(key, fallback) {
    const fromEnv = process.env[key];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    const fromFile = fileEnv[key];
    if (fromFile !== undefined && fromFile !== '') return fromFile;
    return fallback;
}

function envInt(key, fallback) {
    const raw = envValue(key, null);
    if (raw === null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * 把用户传给看门狗的参数翻译成「bot 的启动参数」。
 * 看门狗接受与直接启动 bot 完全相同的写法，因此这里基本是原样透传：
 *   []            -> []
 *   ['webui']     -> ['webui']
 *   ['test']      -> ['test']
 *   ['--test']    -> ['--test']
 *   ['webui','x'] -> ['webui','x']
 */
function normalizeBotArgs(argv) {
    return argv.filter(a => typeof a === 'string' && a.length > 0);
}

/** 可读的启动方式描述（通知里显示用） */
function describeMode(botArgs) {
    if (botArgs.includes('test') || botArgs.includes('--test')) return 'test';
    if (botArgs.includes('webui')) return 'webui';
    return 'normal';
}

function buildConfig(argv = [], { platform = process.platform } = {}) {
    const botArgs = normalizeBotArgs(argv);
    return {
        root: ROOT,
        entry: path.join(ROOT, 'index.js'),
        botArgs,
        mode: describeMode(botArgs),

        // 崩溃后多久重启
        restartDelayMs: envInt('WATCHDOG_RESTART_DELAY', 30000),
        // 健康轮询
        healthIntervalMs: envInt('WATCHDOG_HEALTH_INTERVAL', 30000),
        healthTimeoutMs: envInt('WATCHDOG_HEALTH_TIMEOUT', 5000),
        healthPort: envInt('HEALTH_PORT', 9699),
        healthShutdownToken: envValue('HEALTH_SHUTDOWN_TOKEN', ''),
        // 连续多少次探测无响应才算"卡死"
        healthFailThreshold: envInt('WATCHDOG_HEALTH_FAILS', 3),
        // 子进程启动后多久才开始健康探测
        healthStartupGraceMs: envInt('WATCHDOG_HEALTH_STARTUP_GRACE', 60000),

        // 重启风暴保护
        maxRestarts: envInt('WATCHDOG_MAX_RESTARTS', 5),
        restartWindowMs: envInt('WATCHDOG_RESTART_WINDOW', 600000),
        // 存活满多久算稳定（重置连续崩溃计数）
        stableMs: envInt('WATCHDOG_STABLE_MS', 60000),

        // 优雅关闭：先请求 /shutdown，最多等这么久，再强杀
        gracefulTimeoutMs: envInt('WATCHDOG_GRACEFUL_TIMEOUT', 15000),

        // 通知
        notifyMode: envValue('WATCHDOG_NOTIFY_MODE', 'crash'), // crash | after_restart | off
        restartGraceMs: envInt('NODE_RESTART_GRACE_MS', 90000),
        // 短命通知进程存活上限（发完即退；到点强制结束）
        notifyTtlMs: envInt('WATCHDOG_NOTIFY_TTL', 5000),
        // 崩溃 / 重启报告里最多列几条 warn/erro
        reportTailLimit: envInt('WATCHDOG_REPORT_LINES', 10),
        // 重启后健康持续多久才发「重启成功」报告
        restartReportAfterMs: envInt('WATCHDOG_RESTART_REPORT_AFTER', 30000),

        // 日志
        logFile: path.join(ROOT, 'watchdog', 'watchdog.log'),
        markerFile: path.join(ROOT, 'watchdog', 'crash-marker.json'),
        consoleTailLines: envInt('WATCHDOG_LOG_TAIL', 30),

        telegramToken: envValue('TELEGRAM_BOT_TOKEN', ''),
        adminChatIds: String(envValue('ADMIN_CHAT_ID', ''))
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .map(Number)
            .filter(n => Number.isFinite(n)),

        platform
    };
}

module.exports = { buildConfig, normalizeBotArgs, describeMode, loadEnv };
