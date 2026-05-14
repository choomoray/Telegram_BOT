// handlers/callbacks/pageCallback.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getSession, getPageResults } = require('../../utils/queryCache');
const { formatQueryResults, buildFoldKeyboard, buildNumberKeyboard } = require('../../utils/queryFormatter');

async function handlePageCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 3 || parts[0] !== 'qpage') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const sessionId = parts[1];
    const targetPage = parseInt(parts[2], 10);

    const session = getSession(sessionId);
    if (!session) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 会话已过期，请重新搜索' });
        return;
    }

    const pageData = getPageResults(sessionId, targetPage);
    if (!pageData) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 页码错误' });
        return;
    }

    const { totalPages, currentPage, total, pageResults } = pageData;

    let keyboard;
    if (session.mode === 'fold') {
        keyboard = buildFoldKeyboard(totalPages, currentPage, sessionId);
    } else {
        keyboard = buildNumberKeyboard(sessionId, currentPage, totalPages, pageResults, total);
    }

    const formattedText = formatQueryResults(pageResults, total, session.keyword, currentPage, totalPages);

    try {
        await bot.editMessageText(formattedText, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
        await bot.answerCallbackQuery(query.id);
        logger.info(`用户 ${query.from.id} 翻页到 ${currentPage}/${totalPages}`);
    } catch (err) {
        logger.error(`翻页失败: ${err.message}`);
        await bot.answerCallbackQuery(query.id, { text: '❌ 翻页失败' });
    }
}

module.exports = handlePageCallback;