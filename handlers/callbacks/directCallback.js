// handlers/callbacks/directCallback.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { generateMessageLink } = require('../../utils/chatIdConverter');
const { getGroupTags } = require('../../db/message');
const { removeLevelSuffix } = require('../../utils/levelExtractor');
const { escapeHTML } = require('../../utils/sanitize');

async function handleDirectCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 2 || parts[0] !== 'qdirect') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const groupId = parts[1];
    await bot.answerCallbackQuery(query.id, { text: '⏳ 正在检查...' });

    try {
        const mediaCol = getCollection(COLLECTIONS.MEDIA);
        const messageCol = getCollection(COLLECTIONS.MESSAGE);

        const totalMedia = await mediaCol.countDocuments({ group_id: groupId });
        const subgroups = await mediaCol.distinct('subgroup', { group_id: groupId });
        const subgroupCount = subgroups.length;

        logger.info(`直接查看 group_id=${groupId}，总媒体数=${totalMedia}，subgroup 数=${subgroupCount}`);

        // 阈值：总媒体 >20 或 subgroup 数 >2 时询问
        if (totalMedia > 20 || subgroupCount > 2) {
            const firstMessage = await messageCol.findOne(
                { group_id: groupId },
                { sort: { message_id: 1 } }
            );
            let jumpLink = '';
            if (firstMessage) {
                jumpLink = generateMessageLink(firstMessage.chat_id, firstMessage.message_id);
            }

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '📤 直接查看', callback_data: `qdirect_confirm:${groupId}` },
                        ...(jumpLink ? [{ text: '🔗 跳转查看', url: jumpLink }] : [])
                    ]
                ]
            };

            // 媒体描述 + 标签展示在询问界面（描述在上，标签在下）
            const desc = firstMessage && firstMessage.text ? removeLevelSuffix(firstMessage.text) : '';
            const tags = await getGroupTags(groupId);
            const tagLine = tags.length > 0 ? `\n📌 标签：${escapeHTML(tags.join('、'))}` : '';

            let promptText = `该组共有 ${totalMedia} 个媒体，分为 ${subgroupCount} 组。`;
            if (desc) {
                promptText += `\n\n${escapeHTML(desc)}`;
            }
            promptText += `${tagLine}\n请选择查看方式：`;

            await bot.editMessageText(promptText, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                reply_markup: keyboard
            });
            await bot.answerCallbackQuery(query.id);
        } else {
            const { sendMediaGroup } = require('../../media');
            await sendMediaGroup(query.from.id, groupId);
            await bot.answerCallbackQuery(query.id, { text: '📤 正在发送...' });
        }
    } catch (err) {
        logger.error(`直接查看处理失败: ${err.message}`);
        await bot.answerCallbackQuery(query.id, { text: '❌ 操作失败' });
    }
}

module.exports = handleDirectCallback;