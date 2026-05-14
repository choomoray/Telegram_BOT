// handlers/callbacks/cleanContinueCallback.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getRawUserState, setUserState } = require('../../states');
const { sendNextBatch } = require('../cleanHelpers');

async function handleCleanContinueCallback(query) {
    const data = query.data;
    if (data !== 'clean_continue') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    const state = getRawUserState(userId);
    if (!state || state.mode !== 'clean' || state.step !== 'custom' || !state.awaitingContinue) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 会话已过期或状态错误' });
        return;
    }

    // 删除询问消息
    try {
        await bot.deleteMessage(chatId, messageId);
    } catch (err) {
        logger.warn(`删除继续询问消息失败: ${err.message}`);
    }

    // 清除等待状态
    state.awaitingContinue = false;
    state.continueMsgId = null;
    setUserState(userId, state);

    await bot.answerCallbackQuery(query.id, { text: '继续发送...' });

    // 继续发送下一批
    await sendNextBatch(userId, chatId);
}

module.exports = handleCleanContinueCallback;