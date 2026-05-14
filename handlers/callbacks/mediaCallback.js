// handlers/callbacks/mediaCallback.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getSession, getPageResults } = require('../../utils/queryCache');
const { findMediaByFileUniqueId } = require('../../db/media');
const { sendMediaGroup } = require('../../media');

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

    await bot.answerCallbackQuery(query.id, { text: '📤 正在发送...' });

    try {
        await sendMediaGroup(query.from.id, groupId);
        logger.info(`用户 ${query.from.id} 通过数字按钮查看整个 group_id=${groupId}`);
    } catch (err) {
        logger.error(`发送媒体失败: ${err.message}`);
        await bot.sendMessage(query.from.id, `❌ 发送失败: ${err.message}`);
    }
}

module.exports = handleMediaCallback;