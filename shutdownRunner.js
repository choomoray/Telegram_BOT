// shutdownRunner.js
/**
 * 优雅关闭入口的「注册点」（避免循环依赖）
 *
 * `gracefulShutdown` 定义在 index.js 里（它需要 index.js 的 webServer 等模块内状态），
 * 而 `handlers/commands/restart.js` 又需要主动触发它。
 * 直接 `require('../index')` 会造成循环依赖（index → commands/index → restart → index），
 * 因此这里只放一个可注册的引用：index.js 启动时把自己的 gracefulShutdown 注册进来，
 * 其它模块通过 `runGracefulShutdown()` 调用。
 */
let handler = null;

/** 由 index.js 注册实际的优雅关闭实现 */
function registerGracefulShutdown(fn) {
    handler = typeof fn === 'function' ? fn : null;
}

/** 是否已注册（启动早期为 false） */
function hasGracefulShutdown() {
    return !!handler;
}

/**
 * 触发优雅关闭
 * @param {string} reason - 触发原因（会出现在日志里）
 * @returns {Promise<boolean>} 是否成功调用到实现
 */
async function runGracefulShutdown(reason) {
    if (!handler) return false;
    await handler(reason);
    return true;
}

module.exports = { registerGracefulShutdown, hasGracefulShutdown, runGracefulShutdown };
