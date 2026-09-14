// handlers/commands/restart.js
/**
 * /restart —— 手动重启 bot（仅管理员）
 *
 * 行为：
 *   1. 回一条"正在重启"的提示（先把消息发出去，再开始收尾，否则用户看不到反馈）；
 *   2. 置位"重启意图"（shutdown.requestRestart）并走既有的优雅关闭流程
 *      （停轮询 → 关 Web UI → 关数据库 → 日志落盘）；
 *   3. 以退出码 75 结束 —— 看门狗把 75 解释为"要求重启"，
 *      于是**按首次启动时的启动方式**（如 webui / test，参数原样）重新拉起，
 *      且不会把它当成崩溃、也不会当成人工关闭。
 *
 * 权限：只有管理员能执行（见 handlers/commands/index.js 的 executeCommand 权限校验，
 * /restart 不在白名单里，因此非管理员会直接被拦下）。
 *
 * 未被看门狗托管时（直接 node index.js 启动）：进程会正常退出而不会自己再起来，
 * 提示文案里会说明这一点。
 */
const bot = require('../../bot');
const logger = require('../../logger');
const { logOperation } = require('../../utils/opLog');
const { requestRestart, isStartupComplete } = require('../../shutdown');
const { safeApiCall } = require('../../utils/safeApiCall');

/** 托管标志：由 watchdog.js 通过 BOT_PARENT_PID 注入 */
function isSupervised() {
    const pid = parseInt(process.env.BOT_PARENT_PID, 10);
    return Number.isInteger(pid) && pid > 0;
}

async function handleRestartCommand(userId, msg) {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const mode = process.argv.includes('test') ? 'test'
        : (process.argv.includes('webui') ? 'webui' : 'normal');

    const supervised = isSupervised();
    const tip = supervised
        ? `♻️ 正在重启 bot（启动方式：${mode}）…\n看门狗会按原启动方式重新拉起，稍等片刻即可。`
        : `♻️ 正在退出 bot（启动方式：${mode}）…\n⚠️ 当前**没有**看门狗托管，进程退出后不会自动起来，请手动启动。`;

    try {
        await safeApiCall(() => bot.sendMessage(chatId, tip, {
            reply_to_message_id: messageId,
            allow_sending_without_reply: true
        }), 1);
    } catch (err) {
        logger.warn(`/restart 发送提示失败（继续重启）: ${err.message}`);
    }

    logOperation({
        action: 'bot_restart',
        source: 'private',
        userId,
        chatId,
        detail: { mode, supervised, trigger: 'command' }
    }).catch(() => { });

    logger.warn(`管理员 ${userId} 执行 /restart，准备重启（启动方式：${mode}，看门狗托管：${supervised}）`);

    // 置位重启意图；随后由 index.js 里既有的优雅关闭流程收尾并以 75 退出。
    // 未启动完成时（理论上到不了这里）直接同步触发关闭。
    requestRestart();

    // 给"重启提示"与日志一点发出去的时间，再进入收尾
    setTimeout(async () => {
        try {
            if (!isStartupComplete()) {
                logger.warn('/restart：启动尚未完成，直接退出');
            }
            const { runGracefulShutdown } = require('../../shutdownRunner');
            const ok = await runGracefulShutdown('RESTART_COMMAND');
            if (!ok) {
                // 优雅关闭尚未注册（启动早期）：直接按"请求重启"的退出码结束
                logger.warn('/restart：优雅关闭未就绪，直接退出');
                process.exit(75);
            }
        } catch (err) {
            logger.error(`/restart 触发关闭失败: ${err.message}`);
            process.exit(75);
        }
    }, 600).unref?.();
}

module.exports = handleRestartCommand;
