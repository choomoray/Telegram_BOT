// handlers/modes/manage/dashboard.js
const bot = require('../../../bot');
const logger = require('../../../logger');
const { getCollection, COLLECTIONS } = require('../../../db/getCollection');

async function showDashboard(userId, messageId) {
    try {
        const usersCol = getCollection(COLLECTIONS.USERS);
        const channelGroupCol = getCollection(COLLECTIONS.CHANNEL_GROUP);
        const mediaCol = getCollection(COLLECTIONS.MEDIA);
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const logCol = getCollection(COLLECTIONS.LOG);

        const [totalUsers, totalGroups, totalMedia, totalMessages, logCount24h] = await Promise.all([
            usersCol.countDocuments(),
            channelGroupCol.countDocuments(),
            mediaCol.countDocuments(),
            messageCol.countDocuments(),
            logCol.countDocuments({ time: { $gte: Date.now() - 24 * 60 * 60 * 1000 } })
        ]);

        const text =
            `📊 系统概览\n` +
            `👥 总用户数：${totalUsers}\n` +
            `📋 总群组/频道：${totalGroups}\n` +
            `🎬 总媒体文件：${totalMedia}\n` +
            `💬 总消息记录：${totalMessages}\n` +
            `📝 近24小时操作：${logCount24h}`;

        await bot.editMessageText(text, {
            chat_id: userId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '🔙 返回', callback_data: 'manage:back' }]] }
        });
    } catch (err) {
        logger.error(`获取系统概览失败: ${err.message}`);
        await bot.editMessageText('❌ 无法获取系统概览', {
            chat_id: userId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [[{ text: '🔙 返回', callback_data: 'manage:back' }]] }
        });
    }
}

module.exports = { showDashboard };
