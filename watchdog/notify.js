// watchdog/notify.js
/**
 * 独立 Telegram 通知：直接用 Node 内置 https 调 Bot API。
 *
 * 为什么不 require 项目的 bot.js / node-telegram-bot-api：
 *   - 崩溃瞬间 bot 是死的，通知必须由看门狗自己发；
 *   - 也不希望 bot 侧的依赖问题（语法错误 / 依赖损坏 / 循环引用）把看门狗一起拖垮。
 *
 * 两个层次：
 *   1. `sendToAdmins` / `formatCrashReport` 等：在**看门狗进程内**直接发；
 *   2. `spawnNotifier`：起一个**只负责发消息、短时间后自行结束**的短命进程
 *      （watchdog/notify-bot.js）。这样崩溃播报与主 bot 的生命周期完全解耦：
 *      即使主 bot 还没起来、或起来后又立刻崩，这条崩溃消息也已经发出去了。
 */
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const { URLSearchParams } = require('url');

/** 去掉 ANSI 颜色转义（终端输出带色，写进通知里会变成乱码） */
function stripAnsi(text) {
    // eslint-disable-next-line no-control-regex
    return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * 崩溃 / 重启报告里最多列几条 warn/erro（用户要求：只展示**最近 3 条**）
 * 看门狗侧可用 WATCHDOG_REPORT_LINES 覆盖；bot 侧读崩溃标记里的 reportLimit。
 */
const DEFAULT_REPORT_LIMIT = 3;

/**
 * 从 bot 输出里筛选"最近的 warn / erro"行，转成通知用的简洁格式
 *
 * 输入是子进程原始输出（带时间戳与级别），输出形如：
 *   ['[warn] 会话超时', '[erro] ETELEGRAM: 400 Bad Request ...']
 * 只保留 warn 与 erro；其他级别（info/succ）不进报告——只报问题。
 *
 * @param {string[]} lines - 原始输出行（环形缓冲）
 * @param {number} limit - 最多保留多少条（取最近的，默认 3）
 * @returns {string[]}
 */
function pickWarnErrorLines(lines, limit = DEFAULT_REPORT_LIMIT) {
    const out = [];
    for (const raw of lines || []) {
        const line = stripAnsi(raw).trim();
        if (!line) continue;
        // 形如：[2026-09-13 21:30:00] [WARN] 正文（时间戳/颜色已去掉）
        const m = line.match(/\[(WARN|ERRO|ERROR)\]\s*(.*)$/i);
        if (!m) continue;
        const level = m[1].toUpperCase() === 'WARN' ? 'warn' : 'erro';
        const text = m[2].trim();
        if (!text) continue;
        const entry = `[${level}] ${text}`;
        // 同一错误连续刷屏时只保留一条
        if (out.length && out[out.length - 1] === entry) continue;
        out.push(entry);
    }
    return out.slice(-limit);
}

/**
 * 报告正文（用户指定的格式：**标题首尾各一次**，中间是崩溃信息）
 *
 *   ⚠️ BOT出现意外崩溃，稍后尝试重启
 *
 *   崩溃信息：
 *   [erro] xxx
 *
 *   ⚠️ BOT出现意外崩溃，稍后尝试重启
 */
function buildReport({ title, tail, limit = DEFAULT_REPORT_LIMIT }) {
    const lines = [title, ''];
    const picked = pickWarnErrorLines(tail, limit);
    if (picked.length) {
        lines.push('崩溃信息：', ...picked);
    } else {
        lines.push('崩溃信息：（崩溃前没有 warn / erro 日志）');
    }
    lines.push('', title);
    return lines.join('\n');
}

/** 崩溃通知文案 */
function formatCrashReport(info) {
    return buildReport({
        title: '⚠️ BOT出现意外崩溃，稍后尝试重启',
        tail: info.tail,
        limit: info.limit
    });
}

/**
 * 重启结果通知文案
 *
 * 现在由**主 bot 自己**在重启成功、连上数据库后第一时间发出
 * （见 utils/crashNotify.js: reportRestartFromWatchdog），看门狗不再等健康确认后补发。
 * @param {Object} info
 *   - ok: true = 重启成功；false = 重启后仍未就绪 / 反复崩溃
 *   - tail: 崩溃前的原始输出行
 */
function formatRestartReport(info) {
    const title = info.ok === false
        ? '🚨 BOT重启后仍未就绪，请人工检查'
        : '♻️ BOT重启成功';
    return buildReport({ title, tail: info.tail, limit: info.limit });
}

/** 达到重启上限、停止自动重启的通知文案 */
function formatGiveUpReport(info) {
    const lines = [
        '🛑 BOT反复崩溃，看门狗已停止自动重启，请人工介入',
        '',
        `启动方式：node index.js${info.botArgs && info.botArgs.length ? ' ' + info.botArgs.join(' ') : ''}（${info.mode}）`,
        `时间窗口：${Math.round((info.restartWindowMs || 600000) / 60000)} 分钟内崩溃 ${info.consecutive} 次（上限 ${info.maxRestarts}）`
    ];
    const picked = pickWarnErrorLines(info.tail, info.limit);
    if (picked.length) lines.push('', '崩溃信息：', ...picked);
    lines.push('', `排查后可重新启动：node watchdog.js${info.botArgs && info.botArgs.length ? ' ' + info.botArgs.join(' ') : ''}`);
    return lines.join('\n');
}

/**
 * 发送一条 Telegram 消息
 * @param {string} token
 * @param {number|string} chatId
 * @param {string} text
 */
function sendMessage(token, chatId, text) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            chat_id: String(chatId),
            text,
            disable_web_page_preview: 'true'
        }).toString();

        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${token}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
                reject(new Error(`HTTP ${res.statusCode} ${String(data).slice(0, 200)}`));
            });
        });

        req.on('timeout', () => { req.destroy(new Error('请求超时')); });
        req.on('error', reject);
        req.end(body);
    });
}

/**
 * 在**当前进程内**发给所有管理员
 * @param {Object} cfg - 看门狗配置（telegramToken / adminChatIds）
 * @param {string} text
 * @returns {Promise<{sent:number, failed:number, errors:string[]}>}
 */
async function sendToAdmins(cfg, text) {
    const result = { sent: 0, failed: 0, errors: [] };
    if (!cfg.telegramToken || !Array.isArray(cfg.adminChatIds) || cfg.adminChatIds.length === 0) {
        result.errors.push('缺少 TELEGRAM_BOT_TOKEN 或 ADMIN_CHAT_ID，无法发送通知');
        return result;
    }
    if (!text) return result;

    for (const chatId of cfg.adminChatIds) {
        try {
            await sendMessage(cfg.telegramToken, chatId, text);
            result.sent++;
        } catch (err) {
            result.failed++;
            result.errors.push(`chat ${chatId}: ${err.message}`);
        }
    }
    return result;
}

/**
 * 起一个「只发消息、随后自行结束」的短命通知进程。
 *
 * 设计意图：崩溃播报不依赖主 bot 的生命周期 —— 由这个进程独立完成发送，
 * **无论发送成功与否都在 ttlMs 后结束**；看门狗随即按自己的计时重启主 bot
 * （两条计时互相独立）。
 *
 * @param {Object} opts
 *   - text: 要发送的文本
 *   - ttlMs: 该进程最长存活时间（到点强制结束）
 *   - root: 项目根目录
 *   - token / adminChatIds: 收件人信息
 *   - onExit: 退出回调（便于日志）
 * @returns {import('child_process').ChildProcess|null}
 */
function spawnNotifier({ text, ttlMs = 5000, root, token, adminChatIds, onExit }) {
    if (!text) return null;
    if (!token || !Array.isArray(adminChatIds) || adminChatIds.length === 0) return null;

    const script = path.join(__dirname, 'notify-bot.js');
    let child;
    try {
        child = spawn(process.execPath, [script], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                NOTIFY_PAYLOAD: Buffer.from(JSON.stringify({
                    text, token, adminChatIds, ttlMs
                }), 'utf8').toString('base64')
            }
        });
    } catch {
        return null;
    }

    // 硬兜底：不管子进程在做什么，TTL 到了就收掉（它自身也有一份定时器）
    const killer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { }
    }, ttlMs + 3000);
    if (typeof killer.unref === 'function') killer.unref();

    child.on('error', () => { clearTimeout(killer); });
    if (typeof onExit === 'function') {
        child.on('exit', (code, signal) => {
            clearTimeout(killer);
            onExit(code, signal);
        });
    }
    return child;
}

module.exports = {
    sendToAdmins,
    sendMessage,
    spawnNotifier,
    pickWarnErrorLines,
    stripAnsi,
    formatCrashReport,
    formatRestartReport,
    formatGiveUpReport,
    DEFAULT_REPORT_LIMIT
};
