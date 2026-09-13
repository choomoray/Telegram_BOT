// shutdown.js
/**
 * 进程停机状态 + 信号处理（集中管理，避免"每个启动阶段各注册一个 SIGINT"）
 *
 * 背景：Node 的默认 Ctrl+C 立即退出行为，只要有**任何一个** SIGINT listener 就会被取消。
 * 而 `index.js` 的优雅关闭 handler 是在 `start()` 之后才注册的，因此在此之前
 * Ctrl+C 会被静默吞掉 —— 最典型的场景是启动阶段卡在 `connectDB()` 的 30 秒重试里，
 * 用户按 Ctrl+C 毫无反应，只能等重试跑完。
 *
 * 职责划分：
 *   - 本模块在 require 时**立即**接管 SIGINT/SIGTERM，覆盖整个启动期；
 *   - `isStartupComplete()` 为 false（启动期）时收到信号 → 刷新日志后直接退出（130 = 128+SIGINT）；
 *   - 启动完成后收到信号 → 只置中止标记，交给 `index.js` 的 gracefulShutdown 慢慢收尾；
 *   - 关机过程中再按一次 Ctrl+C → 立即强制退出（不再等优雅关闭）。
 *
 * `abortSignal` 供 connectDB() 等可能长时间阻塞的启动步骤检查，实现"按了就能停"。
 */
const logger = require('./logger');

const abortController = new AbortController();
let startupComplete = false;
let shutdownRequested = false;
let handlerInstalled = false;
let forceExitCode = 1;
let onGracefulCallback = null;

/**
 * 允许调用方（watchdog.js）定制停机行为，仍复用同一套信号语义。
 * @param {Object} opts
 * @param {number} [opts.forceExitCode] - 重复按 Ctrl+C 时的强制退出码
 * @param {Function} [opts.onGraceful] - 启动完成后收到信号时的回调（置位停机标记后调用）。
 *        不传则由 index.js 的 gracefulShutdown 自己监听信号（原有行为）。
 */
function configure(opts = {}) {
    if (Number.isInteger(opts.forceExitCode)) forceExitCode = opts.forceExitCode;
    if (typeof opts.onGraceful === 'function') onGracefulCallback = opts.onGraceful;
}

/** 传给可取消的启动步骤（如 connectDB），用于在收到停机信号时中止等待 */
function getAbortSignal() {
    return abortController.signal;
}

/** 是否已请求停机（收到 SIGINT/SIGTERM 或被显式调用） */
function isShuttingDown() {
    return shutdownRequested;
}

/** 启动是否已完成：完成后信号改由 gracefulShutdown 接管 */
function isStartupComplete() {
    return startupComplete;
}

/**
 * 标记启动完成（Telegram 轮询已开始、健康服务已监听）。
 * 从这一刻起，信号不再触发"立即退出"，而是走优雅关闭。
 */
function markStartupComplete() {
    startupComplete = true;
}

/**
 * 请求停机：置位中止标记 + 唤醒所有 abort 等待者。
 * 可重复调用（幂等）。
 * @returns {boolean} 本次调用是否首次请求（false 表示此前已请求过）
 */
function requestShutdown() {
    if (shutdownRequested) return false;
    shutdownRequested = true;
    abortController.abort();
    return true;
}

/**
 * 退出前的最后动作：尽力把日志刷盘，但不阻塞超过 `timeoutMs`。
 * 启动期日志是异步队列写的，被杀进程时最后几行最容易丢。
 */
async function flushLogsQuietly(timeoutMs = 1500) {
    try {
        const { flushLogs } = require('./logger');
        await Promise.race([
            flushLogs(),
            new Promise(resolve => setTimeout(resolve, timeoutMs))
        ]);
    } catch {
        // 刷盘失败不影响退出
    }
}

/** 立即退出：先尽力刷日志，再由调用方决定退出码 */
async function exitNow(code, message) {
    if (message) logger.warn(message);
    await flushLogsQuietly();
    process.exit(code);
}

/**
 * 收到停机信号时应采取的动作（纯函数，便于测试）
 *
 * 规则：
 *   - 已在关机流程中又收到一次（用户连按 Ctrl+C）→ `force`：立即强制退出，
 *     避免优雅关闭卡住时进程永远挂着；
 *   - 启动已完成 → `graceful`：只置中止标记，交给调用方（index.js 的 gracefulShutdown）收尾；
 *   - 仍在启动期（典型：正卡在 connectDB 的 30 秒重试里）→ `abort`：立即中止并退出。
 *
 * @param {boolean} alreadyShuttingDown - 此前是否已请求过停机
 * @param {boolean} startupDone - 启动是否已完成
 * @returns {'force'|'graceful'|'abort'}
 */
function decideOnSignal(alreadyShuttingDown, startupDone) {
    if (alreadyShuttingDown) return 'force';
    return startupDone ? 'graceful' : 'abort';
}

/**
 * 安装信号处理器（幂等）。在模块加载时自动调用一次。
 */
function installSignalHandlers() {
    if (handlerInstalled) return;
    handlerInstalled = true;

    const onSignal = (signal) => {
        const action = decideOnSignal(shutdownRequested, startupComplete);

        if (action === 'force') {
            logger.error(`再次收到 ${signal}，强制退出`);
            exitNow(forceExitCode, null);
            return;
        }

        if (action === 'graceful') {
            requestShutdown();
            logger.info(`收到 ${signal}，准备优雅关闭...`);
            // 回调由调用方提供（watchdog.js：转去关子进程）；index.js 不提供，
            // 它自己监听 SIGINT/SIGTERM 走 gracefulShutdown
            if (onGracefulCallback) {
                try {
                    onGracefulCallback(signal);
                } catch (err) {
                    logger.error(`停机回调异常: ${err.message}`);
                }
            }
            return;
        }

        // abort：启动期（可能正卡在 connectDB 重试里）立即中止并退出
        requestShutdown();
        logger.warn(`启动过程中收到 ${signal}，已中止启动并退出`);
        exitNow(130, null);
    };

    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
}

installSignalHandlers();

/**
 * 父进程存活看护：父进程（看门狗）消失时请求停机，避免自己变成孤儿进程。
 *
 * 为什么要这个：看门狗负责重启 bot，但如果**看门狗自己**被硬杀
 * （任务管理器结束进程、`taskkill /F`、系统关机等，Windows 上被杀方收不到任何信号），
 * bot 子进程会活下来继续跑 —— 下次再启动看门狗就会出现两个实例抢轮询（Telegram 409）。
 *
 * 父进程 pid 由看门狗通过 `BOT_PARENT_PID` 注入；没有该变量时本函数不做任何事
 * （直接 `node index.js` 启动的场景不受影响）。
 *
 * @param {Object} [opts]
 * @param {number} [opts.intervalMs] - 检查间隔
 * @param {Function} [opts.onParentGone] - 父进程消失时的回调（默认 requestShutdown）
 * @param {string} [opts.envVar] - 承载父进程 pid 的环境变量名
 * @returns {NodeJS.Timeout|null}
 */
function watchParentProcess(opts = {}) {
    const intervalMs = opts.intervalMs
        || parseInt(process.env.BOT_PARENT_CHECK_INTERVAL, 10)
        || 10000;
    const envVar = opts.envVar || 'BOT_PARENT_PID';
    const raw = process.env[envVar];
    const parentPid = parseInt(raw, 10);
    if (!Number.isInteger(parentPid) || parentPid <= 0) return null;

    const onGone = typeof opts.onParentGone === 'function'
        ? opts.onParentGone
        : () => requestShutdown();

    const timer = setInterval(() => {
        let alive = true;
        try {
            // 信号 0 = 只探测存在性，不真的发信号
            process.kill(parentPid, 0);
        } catch (err) {
            // EPERM 表示进程存在但没有权限（仍算存活）；ESRCH 才是真的没了
            alive = err && err.code === 'EPERM';
        }
        if (!alive) {
            clearInterval(timer);
            logger.warn(`父进程（看门狗 pid=${parentPid}）已消失，自身退出以避免成为孤儿进程`);
            try {
                onGone('parent-gone');
            } catch (err) {
                logger.error(`父进程消失处理异常: ${err.message}`);
            }
        }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

module.exports = {
    getAbortSignal,
    isShuttingDown,
    isStartupComplete,
    markStartupComplete,
    requestShutdown,
    installSignalHandlers,
    decideOnSignal,
    configure,
    watchParentProcess,
    flushLogsQuietly
};
