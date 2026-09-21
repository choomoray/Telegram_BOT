// handlers/commands/send.js
/**
 * /send 指令：进入发送模式
 * 用户选择目标群组/频道后，可将消息/媒体/媒体组发送到该群组并收录
 */
const bot = require('../../bot');
const logger = require('../../logger');
const { setUserState, updateUserActivity } = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');

async function handleSendCommand(userId, msg) {
    updateUserActivity(userId);

    await cleanPreviousMode(userId);

    setUserState(userId, {
        mode: 'send',
        step: 'selecting',          // selecting: 等待选择目标群组/频道
        targetChatId: null,
        targetName: null,
        pendingMediaGroup: null,    // 媒体组暂存
        lastActivity: Date.now(),
        _onExit: async () => { }
    });

    logger.info(`用户 ${userId} 进入发送模式`);

    // 先回一条「正在获取列表」，拿到列表后就地刷新成选择面板。
    // 必须这样做：列表要查云端数据库、还要按 Telegram 真实会话类型逐个补正，
    // 这段时间里如果什么都不发，用户端完全没反馈（以为 bot 卡了 / 网不好）。
    let loadingMsg = null;
    try {
        loadingMsg = await bot.sendMessage(userId, '♻️ 正在获取频道 / 群组 列表，请稍候...', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送获取列表提示失败: ${err.message}`);
    }

    const { showGroupList } = require('../modes/sendMode');
    await showGroupList(userId, loadingMsg ? loadingMsg.message_id : null, 1);
}

module.exports = handleSendCommand;
