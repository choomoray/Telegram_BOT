// handlers/commands/messageReply.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    getUserState,
    setUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { insertLog } = require('../../db/log');
const { clearUserContext } = require('../modes/messageReplyMode');
const { repeatModeMsg } = require('../../utils/reply');

async function handleMessageReplyCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'message_reply') {
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 重复发送 /message_reply，仅重置活动时间`);
        await bot.sendMessage(userId, repeatModeMsg('消息回复'))
            .catch(err => logger.error('发送消息失败:', err.message));
        return;
    }

    await cleanPreviousMode(userId);

    setUserState(userId, {
        mode: 'message_reply',
        lastActivity: Date.now(),
        step: 'waiting_for_target',
        targetGroupId: null,
        targetChatId: null,
        targetMessageId: null,
        processingMsgId: null,
        hintMsgInfo: null,
        _onExit: async (uid) => {
            // 清理上下文和可能的群组提示消息
            const rawState = require('../../states').getRawUserState(uid);
            if (rawState && rawState.hintMsgInfo) {
                try {
                    await bot.deleteMessage(rawState.hintMsgInfo.chat_id, rawState.hintMsgInfo.message_id);
                } catch (err) {
                    logger.warn(`退出时删除群组提示消息失败: ${err.message}`);
                }
            }
            clearUserContext(uid);
        }
    });

    logger.info(`用户 ${userId} 进入消息回复模式`);

    const welcomeMsg = `✅ 已进入消息回复模式\n\n请发送需要回复的媒体消息：`;
    await bot.sendMessage(userId, welcomeMsg, {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
    }).catch(err => logger.error('发送消息失败:', err.message));

    insertLog(13, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
}

module.exports = handleMessageReplyCommand;