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
const { clearUserContext, buildReplyModeExitHandler } = require('../modes/messageReplyMode');
const { repeatModeMsg } = require('../../utils/reply');
const { getClampedNumberArg } = require('../../utils/commandArgs');

/**
 * 进入消息回复模式
 * @param {number} userId - 用户ID
 * @param {Object} msg - Telegram 消息
 * @param {string|null} replyTarget - 指定回复位置：
 *   null    = 定位后询问（频道转发消息时询问群组/频道）
 *   'group' = 直接回复在群组（/message_reply_group）
 *   'channel' = 直接回复在频道（/message_reply_channel）
 */
async function enterMessageReplyMode(userId, msg, replyTarget) {
    const state = getUserState(userId);
    if (state && state.mode === 'message_reply') {
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 重复发送 /message_reply，仅重置活动时间`);
        await bot.sendMessage(userId, repeatModeMsg('消息回复'))
            .catch(err => logger.error('发送消息失败:', err.message));
        return;
    }

    await cleanPreviousMode(userId);

    // /message_reply N：N >= 2 时进入打包模式，用户发送的媒体按 N 个为一组打包为媒体组回复
    const packSize = getClampedNumberArg(msg, 1, 10);

    setUserState(userId, {
        mode: 'message_reply',
        lastActivity: Date.now(),
        step: 'waiting_for_target',
        replyTarget: replyTarget || null,   // null=定位后询问, 'group'/'channel'=直接指定
        packSize: packSize || null,         // /message_reply N 的打包数量（1 视为不打包）
        targetGroupId: null,
        targetChatId: null,
        targetMessageId: null,
        processingMsgId: null,
        hintMsgInfo: null,
        _onExit: buildReplyModeExitHandler()
    });

    logger.info(`用户 ${userId} 进入消息回复模式${replyTarget ? `（回复位置: ${replyTarget}）` : ''}${packSize && packSize >= 2 ? `（打包: 每组 ${packSize} 个）` : ''}`);

    const targetHint = replyTarget === 'group'
        ? '\n回复位置：👥 群组'
        : (replyTarget === 'channel' ? '\n回复位置：📢 频道' : '');
    const packHint = packSize && packSize >= 2 ? `\n📦 媒体将以 ${packSize} 个为一组打包回复` : '';
    const welcomeMsg = `✅ 已进入消息回复模式${targetHint}${packHint}\n\n请发送需要回复的媒体消息：`;
    await bot.sendMessage(userId, welcomeMsg, {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
    }).catch(err => logger.error('发送消息失败:', err.message));

    insertLog(13, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
}

// /message_reply：定位后询问回复位置（频道转发消息时）
module.exports = (userId, msg) => enterMessageReplyMode(userId, msg, null);
module.exports.enterMessageReplyMode = enterMessageReplyMode;
