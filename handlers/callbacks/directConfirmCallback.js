// handlers/callbacks/directConfirmCallback.js
const bot = require('../../bot');
const logger = require('../../logger');
const { sendMediaGroup } = require('../../media');

async function handleDirectConfirmCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 2 || parts[0] !== 'qdirect_confirm') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const groupId = parts[1];
    await bot.answerCallbackQuery(query.id, { text: '📤 正在发送...' });

    try {
        await sendMediaGroup(query.from.id, groupId);
        await bot.editMessageText('✅ 已发送所有媒体', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
        }).catch(() => { });
    } catch (err) {
        logger.error(`直接确认发送失败: ${err.message}`);
        await bot.sendMessage(query.from.id, `❌ 发送失败: ${err.message}`);
    }
}

module.exports = handleDirectConfirmCallback;