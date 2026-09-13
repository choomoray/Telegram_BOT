// watchdog.js
/**
 * Bot 看门狗（唯一入口）
 *
 * 用法（参数与直接启动 bot 完全一致，崩溃后用同一份参数重启）：
 *   node watchdog.js            -> node index.js
 *   node watchdog.js webui      -> node index.js webui
 *   node watchdog.js test       -> node index.js test
 *
 * 它做四件事：
 *   1. 以子进程方式拉起 bot，转发它的 stdout/stderr（并保留尾部日志作为崩溃现场）；
 *   2. 进程退出（真崩溃 / 被 OOM / 未捕获致命错误）→ 记录原因，等 WATCHDOG_RESTART_DELAY
 *      毫秒后用**同样的启动参数**重新拉起；
 *   3. 健康轮询 /health，连续多次无响应 → 判定软卡死（进程活着但已不工作），走软重启；
 *   4. 崩溃 / 重启失败时用独立通道通知管理员（见 watchdog/notify.js）。
 *
 * 本文件只依赖 Node 内置模块，不 require 项目代码：bot 侧的语法错误、依赖问题、
 * 循环引用都不应该把看门狗一起带走。
 *
 * 优雅关闭：重启前先 POST /shutdown 请求 bot 自己收尾（Windows 上无法跨进程发信号，
 * 见 healthServer.js 注释），超时未退出再强杀进程树。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { buildConfig, describeMode } = require('./watchdog/config');
const notify = require('./watchdog/notify');
const shutdown = require('./shutdown');

const cfg = buildConfig(process.argv.slice(2));

// ---------------- 看门狗自己的日志（独立文件，不混进 bot 日志） ----------------

let logStream = null;
function ensureLogDir() {
    try {
        fs.mkdirSync(path.dirname(cfg.logFile), { recursive: true });
    } catch { }
}
function wlog(level, message) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = `[${ts}] [${level}] ${message}`;
    // eslint-disable-next-line no-console
    console.log(`\x1b[35m[看门狗]\x1b[0m ${line}`);
    try {
        if (!logStream) {
            ensureLogDir();
            logStream = fs.createWriteStream(cfg.logFile, { flags: 'a' });
        }
        logStream.write(line + '\n');
    } catch { }
}

// ---------------- 子进程状态 ----------------

let child = null;
let childStartedAt = 0;
let intentionalStop = false;      // 看门狗主动要求子进程退出（不重启）
let restartTimer = null;
let healthTimer = null;
let healthInFlight = false;
let healthFailStreak = 0;
let healthFirstOk = false;
let lastUptime = null;
let exited = false;               // 看门狗自身是否正在退出
let restartCount = 0;             // 当前窗口内重启次数
let restartWindowStart = null;    // 当前统计窗口起始（null = 尚未开始）
let lastCrash = null;             // 最近一次崩溃现场

const recentOutput = [];          // 环形缓冲：最近 N 行输出（崩溃现场）
function pushOutput(chunk) {
    const text = chunk.toString();
    const parts = text.split(/\r?\n/);
    for (const line of parts) {
        if (!line.trim()) continue;
        recentOutput.push(line);
        if (recentOutput.length > cfg.consoleTailLines) recentOutput.shift();
    }
}
const tailLines = () => recentOutput.slice(-cfg.consoleTailLines);

// ---------------- 工具 ----------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function timeText(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function uptimeText(ms) {
    if (!ms || ms < 0) return '';
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h} 小时 ${m} 分` : (m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`);
}

/** 把崩溃现场写到 marker 文件：重启后的 bot 会读取它并向管理员播报 */
function writeCrashMarker(crash) {
    try {
        ensureLogDir();
        fs.writeFileSync(cfg.markerFile, JSON.stringify({
            ...crash,
            mode: cfg.mode,
            botArgs: cfg.botArgs,
            consecutive: restartCount,
            maxRestarts: cfg.maxRestarts
        }, null, 2));
    } catch (err) {
        wlog('WARN', `写崩溃标记失败: ${err.message}`);
    }
}

/** 请求 bot 优雅退出：先 HTTP /shutdown，再等，最后强杀进程树 */
async function stopChildGracefully(reason) {
    if (!child || child.exitCode !== null || child.killed) return true;
    const pid = child.pid;
    intentionalStop = true;

    wlog('INFO', `请求 bot 优雅退出（pid=${pid}，原因：${reason}）`);
    const exitPromise = new Promise(resolve => {
        if (!child) return resolve(true);
        child.once('exit', () => resolve(true));
    });

    // 1) HTTP 出口（Windows 上唯一可行的优雅关闭途径）
    let requested = false;
    try {
        requested = await requestShutdownEndpoint();
    } catch (err) {
        wlog('WARN', `/shutdown 请求失败: ${err.message}`);
    }
    if (requested) {
        const done = await Promise.race([
            exitPromise.then(() => true),
            sleep(cfg.gracefulTimeoutMs).then(() => false)
        ]);
        if (done) {
            wlog('INFO', 'bot 已优雅退出');
            return true;
        }
        wlog('WARN', `等待优雅退出超时（${cfg.gracefulTimeoutMs}ms），改为强杀`);
    } else {
        wlog('WARN', '未拿到 /shutdown 响应，直接强杀进程树');
    }

    // 2) 强杀进程树（Windows 用 taskkill /T /F 连同子进程一起收掉）
    hardKillTree(pid);
    const killed = await Promise.race([
        exitPromise.then(() => true),
        sleep(5000).then(() => false)
    ]);
    if (!killed) wlog('ERROR', `强杀后仍未确认退出（pid=${pid}）`);
    return killed;
}

/** POST http://127.0.0.1:<port>/shutdown（仅本机，可选共享密钥） */
function requestShutdownEndpoint() {
    return new Promise((resolve) => {
        const http = require('http');
        const headers = { 'Content-Length': 0 };
        if (cfg.healthShutdownToken) headers['X-Shutdown-Token'] = cfg.healthShutdownToken;
        const req = http.request({
            hostname: '127.0.0.1',
            port: cfg.healthPort,
            path: '/shutdown',
            method: 'POST',
            headers,
            timeout: cfg.healthTimeoutMs
        }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
        });
        req.on('timeout', () => { req.destroy(new Error('超时')); });
        req.on('error', () => resolve(false));
        req.end();
    });
}

function hardKillTree(pid) {
    try {
        if (cfg.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
        }
    } catch (err) {
        wlog('ERROR', `强杀失败: ${err.message}`);
    }
}

// ---------------- 健康轮询 ----------------

function pingHealth() {
    return new Promise((resolve) => {
        const http = require('http');
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const req = http.get({
            hostname: '127.0.0.1',
            port: cfg.healthPort,
            path: '/health',
            timeout: cfg.healthTimeoutMs
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) return finish({ ok: false, reason: `HTTP ${res.statusCode}` });
                try {
                    finish({ ok: true, body: JSON.parse(data) });
                } catch {
                    finish({ ok: false, reason: 'health 响应不是 JSON' });
                }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('超时')); });
        req.on('error', (err) => finish({ ok: false, reason: err.message }));
    });
}

async function checkHealthTick() {
    if (healthInFlight || exited) return;
    if (!child || child.exitCode !== null) return;
    // 刚启动的一段时间内不做健康判定：连库/建索引本来就慢
    if (Date.now() - childStartedAt < cfg.healthStartupGraceMs) return;

    healthInFlight = true;
    try {
        const r = await pingHealth();
        if (r.ok) {
            const up = r.body && typeof r.body.uptime === 'number' ? r.body.uptime : null;
            // event loop 卡死检测：/health 能回，但 uptime 不增长（理论上前置条件已满足）
            if (up !== null && lastUptime !== null && up <= lastUptime && !healthFirstOk) {
                wlog('WARN', `健康探测异常：uptime 未增长（${lastUptime} -> ${up}）`);
            }
            lastUptime = up;
            healthFirstOk = true;
            if (healthFailStreak > 0) {
                wlog('INFO', `健康探测恢复正常（此前连续失败 ${healthFailStreak} 次）`);
            }
            healthFailStreak = 0;
            return;
        }

        healthFailStreak++;
        wlog('WARN', `健康探测失败 ${healthFailStreak}/${cfg.healthFailThreshold}：${r.reason}`);
        if (healthFailStreak >= cfg.healthFailThreshold) {
            const reason = `健康探测连续失败 ${healthFailStreak} 次（最后原因：${r.reason}）`;
            wlog('ERROR', `判定 bot 软卡死：${reason}`);
            healthFailStreak = 0;
            await recordAndRestart({ kind: 'unhealthy', reason });
        }
    } finally {
        healthInFlight = false;
    }
}

// ---------------- 崩溃处理 + 重启 ----------------

/**
 * 重启风暴计数的真实规则（抽成纯函数，watchdog.js 与测试共用同一份实现）
 *
 * 语义：`count` = 当前统计窗口内**已经发生**的崩溃（即已重启）次数，本次调用累加 1。
 *   - `windowStart === null` 表示窗口尚未开始 → 本次开窗；
 *   - 距窗口开始超过 `windowMs` → 另开新窗口并重新计数；
 *   - 累计超过 `maxRestarts` 时置 `giveUp`（调用方据此停止自动重启并提醒人工介入）。
 *
 * `windowStart` 用 `null` 而不是 `0` 表示"未开始"：时间戳 0 是合法值，
 * 用 0 当哨兵会把"第一个窗口"误判为"没开窗"。
 *
 * 用 `null` 哨兵 + 每次累加，避免"第一次调用不计数"的偏差。
 *
 * @param {number} count - 窗口内已发生的崩溃次数
 * @param {number|null} windowStart - 窗口起始时间戳；null = 尚未开始
 * @param {number} now - 当前时间戳
 * @param {{maxRestarts:number, windowMs:number}} cfg
 * @returns {{count:number, windowStart:number, giveUp:boolean}}
 */
function nextRestartState(count, windowStart, now, cfg) {
    let nextCount = count;
    let nextStart = windowStart;
    if (nextStart === null || now - nextStart > cfg.windowMs) {
        nextStart = now;
        nextCount = 0;
    }
    nextCount++;
    return { count: nextCount, windowStart: nextStart, giveUp: nextCount > cfg.maxRestarts };
}

/**
 * 子进程退出后是否应当重启（纯函数）
 * 看门狗主动要求退出（人工关闭 / 自己在退出）→ 不重启，否则一律视为崩溃。
 * @param {{intentionalStop:boolean, exited:boolean}} state
 * @returns {'stop'|'restart'}
 */
function decideAfterExit(state) {
    if (state.intentionalStop || state.exited) return 'stop';
    return 'restart';
}

/** 窗口内计数：超过 maxRestarts 就停止自动重启 */
function registerRestart() {
    const next = nextRestartState(restartCount, restartWindowStart, Date.now(), cfg);
    restartCount = next.count;
    restartWindowStart = next.windowStart;
    return restartCount;
}

async function recordAndRestart(crash) {
    // 软卡死：先让旧进程退干净，再走重启
    if (crash.kind === 'unhealthy') {
        await stopChildGracefully('软卡死重启');
    }

    lastCrash = crash;
    const n = registerRestart();
    const info = {
        ...crash,
        mode: cfg.mode,
        botArgs: cfg.botArgs,
        consecutive: n,
        maxRestarts: cfg.maxRestarts,
        restartDelayMs: cfg.restartDelayMs,
        tail: tailLines()
    };

    wlog('ERROR', `崩溃 #${n}/${cfg.maxRestarts}：${crash.reason}`);
    writeCrashMarker(info);

    // 达到上限：停止自动重启（避免无限刷屏 / 无意义重启）
    if (n > cfg.maxRestarts) {
        wlog('ERROR', `连续崩溃已达上限（${cfg.maxRestarts}），停止自动重启，请人工介入`);
        await notify.sendToAdmins(cfg, notify.formatGiveUpReport({
            ...info,
            restartWindowMs: cfg.restartWindowMs
        }));
        exited = true;
        await shutdown.flushLogsQuietly();
        process.exit(1);
    }

    // 即时通知（可选）
    if (cfg.notifyMode === 'crash') {
        await notify.sendToAdmins(cfg, notify.formatCrashReport(info)).catch(() => { });
    }

    wlog('INFO', `等待 ${cfg.restartDelayMs}ms 后重启（按原启动方式：node index.js${cfg.botArgs.length ? ' ' + cfg.botArgs.join(' ') : ''}）`);
    restartTimer = setTimeout(() => {
        restartTimer = null;
        startChild();
    }, cfg.restartDelayMs);
}

/** 子进程退出：区分"看门狗主动停"和"真崩溃" */
function onChildExit(code, signal) {
    const ranMs = Date.now() - childStartedAt;
    const wasIntentional = intentionalStop;
    intentionalStop = false;
    child = null;

    if (decideAfterExit({ intentionalStop: wasIntentional, exited }) === 'stop') {
        wlog('INFO', `bot 已退出（code=${code}, signal=${signal}，运行 ${uptimeText(ranMs)}）`);
        return;
    }

    const reason = signal
        ? `进程被信号终止（signal=${signal}）`
        : `进程异常退出（exitCode=${code}）`;
    wlog('ERROR', `检测到 bot 已退出：${reason}，运行时长 ${uptimeText(ranMs)}`);

    recordAndRestart({
        kind: 'exit',
        reason,
        exitCode: code,
        signal: signal || null,
        timeText: timeText(),
        uptimeText: uptimeText(ranMs)
    });
}

// ---------------- 启动子进程 ----------------

function startChild() {
    if (exited) return;
    const args = cfg.entry ? [cfg.entry, ...cfg.botArgs] : cfg.botArgs;
    wlog('INFO', `启动 bot：node ${path.relative(cfg.root, cfg.entry)}${cfg.botArgs.length ? ' ' + cfg.botArgs.join(' ') : ''}`);

    child = spawn(process.execPath, args, {
        cwd: cfg.root,
        stdio: ['inherit', 'pipe', 'pipe'],
        // BOT_PARENT_PID 让 bot 能发现"看门狗被硬杀"并自行退出，避免变成孤儿进程
        // （Windows 上被杀方收不到任何信号，只能靠主动探测父进程；见 shutdown.watchParentProcess）
        env: { ...process.env, BOT_PARENT_PID: String(process.pid) }
    });
    childStartedAt = Date.now();
    healthFailStreak = 0;
    healthFirstOk = false;
    lastUptime = null;

    child.stdout.on('data', (c) => { process.stdout.write(c); pushOutput(c); });
    child.stderr.on('data', (c) => { process.stderr.write(c); pushOutput(c); });
    child.on('exit', onChildExit);
    child.on('error', (err) => {
        wlog('ERROR', `子进程启动失败: ${err.message}`);
        onChildExit(null, null);
    });

    // 稳定运行满 stableMs → 重置连续崩溃计数
    const stableTimer = setTimeout(() => {
        if (child && Date.now() - childStartedAt >= cfg.stableMs && restartCount > 0) {
            wlog('INFO', `bot 已稳定运行 ${uptimeText(Date.now() - childStartedAt)}，重置连续崩溃计数（此前 ${restartCount} 次）`);
            restartCount = 0;
            restartWindowStart = null;
        }
    }, cfg.stableMs);
    if (typeof stableTimer.unref === 'function') stableTimer.unref();

    // 重启若在宽限期内又崩，视为重启失败（由下一次崩溃逻辑继续处理）
    setTimeout(() => {
        if (!exited && child && Date.now() - childStartedAt >= Math.min(cfg.restartGraceMs, cfg.healthStartupGraceMs)) {
            wlog('INFO', 'bot 已度过启动宽限期');
        }
    }, Math.min(cfg.restartGraceMs, cfg.healthStartupGraceMs)).unref?.();
}

// ---------------- 看门狗自身的信号处理（复用 shutdown.js 语义） ----------------

async function stopAllAndExit(code, signal) {
    if (exited) return;
    exited = true;
    wlog('INFO', `看门狗收到 ${signal}，正在关闭 bot...`);
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    await stopChildGracefully(`看门狗退出（${signal}）`);
    wlog('INFO', '看门狗已退出');
    await shutdown.flushLogsQuietly();
    process.exit(code);
}

// ---------------- 主流程 ----------------

function main() {
    ensureLogDir();
    wlog('INFO', `看门狗启动：pid=${process.pid}，启动方式=node index.js${cfg.botArgs.length ? ' ' + cfg.botArgs.join(' ') : ''}（${cfg.mode}）`);
    wlog('INFO', `崩溃后重启延迟=${cfg.restartDelayMs}ms，健康轮询=${cfg.healthIntervalMs}ms（失败 ${cfg.healthFailThreshold} 次判定卡死），` +
        `重启上限=${cfg.maxRestarts} 次/${Math.round(cfg.restartWindowMs / 60000)} 分钟，通知模式=${cfg.notifyMode}`);

    // 看门狗的 Ctrl+C：先关子进程再退出（第二次 Ctrl+C 直接强退，由 shutdown.js 处理）
    shutdown.configure({
        forceExitCode: 1,
        onGraceful: () => { stopAllAndExit(0, 'SIGINT/SIGTERM'); }
    });
    shutdown.markStartupComplete();

    startChild();
    healthTimer = setInterval(checkHealthTick, cfg.healthIntervalMs);

    // 自己也要盯住父进程：若被硬杀（任务管理器 / taskkill /F / 关机），
    // 子进程会靠 BOT_PARENT_PID 自行退出，不会变成孤儿实例
    shutdown.watchParentProcess();
}

// 仅在作为入口直接运行时才启动；被测试 require 时不启动任何子进程
if (require.main === module) {
    main();
}

// 导出纯规则供测试直接验证（避免测试里重写一份实现而与被测逻辑漂移）
module.exports = { nextRestartState, decideAfterExit };
