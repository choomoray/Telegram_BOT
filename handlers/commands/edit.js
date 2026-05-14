// handlers/commands/edit.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    getUserState,
    setUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');

async function handleEditCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'edit') {
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 重复发送 /edit，仅重置活动时间`);
        await bot.sendMessage(userId, '您已经在编辑模式中，请发送想要编辑的媒体。')
            .catch(err => logger.error('发送消息失败:', err.message));
        return;
    }

    await cleanPreviousMode(userId);

    setUserState(userId, {
        mode: 'edit',
        step: 'waiting_for_media',
        lastActivity: Date.now(),
        _onExit: async () => { }
    });

    logger.info(`用户 ${userId} 进入编辑模式`);

    await bot.sendMessage(userId, '✏️ 请发送想要编辑的媒体', {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
    }).catch(err => logger.error('发送进入提示失败:', err.message));
}

module.exports = handleEditCommand;