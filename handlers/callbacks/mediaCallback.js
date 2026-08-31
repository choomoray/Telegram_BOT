// handlers/callbacks/mediaCallback.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getSession, getPageResults } = require('../../utils/queryCache');
const { findMediaByFileUniqueId } = require('../../db/media');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { sendMediaGroup } = require('../../media');
const { generateMessageLink } = require('../../utils/chatIdConverter');
const { removeLevelSuffix } = require('../../utils/levelExtractor');
const { escapeHTML } = require('../../utils/sanitize');

async function handleMediaCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 4 || parts[0] !== 'qmedia') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const sessionId = parts[1];
    const currentPage = parseInt(parts[2], 10);
    const itemIndex = parseInt(parts[3], 10) - 1;

    const session = getSession(sessionId);
    if (!session) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 会话已过期，请重新搜索' });
        return;
    }

    const pageData = getPageResults(sessionId, currentPage);
    if (!pageData || !pageData.pageResults || itemIndex < 0 || itemIndex >= pageData.pageResults.length) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 数据错误' });
        return;
    }

    const selected = pageData.pageResults[itemIndex];
    const targetFileUniqueId = selected.file_unique_id;

    const mediaDoc = await findMediaByFileUniqueId(targetFileUniqueId);
    if (!mediaDoc) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 媒体数据不存在' });
        return;
    }

    const groupId = mediaDoc.group_id;

    // 检查媒体组大小，超过阈值时询问用户
    const mediaCol = getCollection(COLLECTIONS.MEDIA);
    const messageCol = getCollection(COLLECTIONS.MESSAGE);

    const totalMedia = await mediaCol.countDocuments({ group_id: groupId });
    const subgroups = await mediaCol.distinct('subgroup', { group_id: groupId });
    const subgroupCount = subgroups.length;

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

        // 媒体描述 + 标签展示在询问界面（描述在上，标签在下；标签与显示的文本配对）
        const desc = firstMessage && firstMessage.text ? removeLevelSuffix(firstMessage.text) : '';
        const tags = (firstMessage && Array.isArray(firstMessage.tags) && firstMessage.tags.length) ? firstMessage.tags : [];
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
        await bot.answerCallbackQuery(query.id, { text: '📤 正在发送...' });

        try {
            await sendMediaGroup(query.from.id, groupId);
            logger.info(`用户 ${query.from.id} 通过数字按钮查看整个 group_id=${groupId}`);
        } catch (err) {
            logger.error(`发送媒体失败: ${err.message}`);
            await bot.sendMessage(query.from.id, `❌ 发送失败: ${err.message}`);
        }
    }
}

module.exports = handleMediaCallback;