// handlers/commands/edit.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    getUserState,
    setUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { repeatModeMsg, entryMsg } = require('../../utils/reply');

async function handleEditCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'edit') {
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 重复发送 /edit，仅重置活动时间`);
        await bot.sendMessage(userId, repeatModeMsg('编辑', '请发送要编辑的媒体（图片/视频/音频/文档），或粘贴消息链接 / 转发该消息'))
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

    // 文本消息（机器人 /send、/reply 发出的纯文本）同样可编辑：给消息链接或转发来源即可定位
    await bot.sendMessage(userId, entryMsg('编辑模式', '请发送要编辑的媒体（图片/视频/音频/文档），或粘贴消息链接 / 转发该消息'), {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
    }).catch(err => logger.error('发送进入提示失败:', err.message));
}

module.exports = handleEditCommand;