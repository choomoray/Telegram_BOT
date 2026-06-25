// handlers/commands/mark.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    getUserState,
    setUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { repeatModeMsg } = require('../../utils/reply');

async function handleMarkCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'mark') {
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 重复发送 /mark，仅重置活动时间`);
        await bot.sendMessage(userId, repeatModeMsg('标记', '请发送要标记的媒体'))
            .catch(err => logger.error('发送消息失败:', err.message));
        return;
    }

    await cleanPreviousMode(userId);

    setUserState(userId, {
        mode: 'mark',
        lastActivity: Date.now(),
        _onExit: async () => { }
    });

    logger.info(`用户 ${userId} 进入标记模式`);

    await bot.sendMessage(userId, '✅ 已进入标记模式\n请发送要标记的媒体（支持媒体组，仅处理第一条媒体）。', {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
    }).catch(err => logger.error('发送标记模式提示失败:', err.message));

    insertLog(20, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
}

module.exports = handleMarkCommand;