// handlers/callbacks/toggleCallback.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getSession, getPageResults, setSessionMode } = require('../../utils/queryCache');
const { formatQueryResults, buildFoldKeyboard, buildNumberKeyboard } = require('../../utils/queryFormatter');

async function handleToggleCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 3 || parts[0] !== 'qtoggle') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const sessionId = parts[1];
    const currentPage = parseInt(parts[2], 10);

    const session = getSession(sessionId);
    if (!session) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 会话已过期，请重新搜索' });
        return;
    }

    const newMode = session.mode === 'fold' ? 'number' : 'fold';
    setSessionMode(sessionId, newMode);

    const pageData = getPageResults(sessionId, currentPage);
    if (!pageData) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 数据错误' });
        return;
    }

    const { totalPages, total, pageResults } = pageData;
    const pageSize = session.pageSize || 15;

    let keyboard;
    if (newMode === 'fold') {
        keyboard = buildFoldKeyboard(totalPages, currentPage, sessionId);
    } else {
        keyboard = buildNumberKeyboard(sessionId, currentPage, totalPages, pageResults, total, pageSize);
    }

    const formattedText = formatQueryResults(pageResults, total, session.keyword, currentPage, totalPages, pageSize);

    try {
        await bot.editMessageText(formattedText, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
        await bot.answerCallbackQuery(query.id, { text: `已切换至${newMode === 'fold' ? '折叠' : '数字'}模式` });
        logger.info(`用户 ${query.from.id} 切换模式至 ${newMode}`);
    } catch (err) {
        logger.error(`切换模式失败: ${err.message}`);
        await bot.answerCallbackQuery(query.id, { text: '❌ 切换失败' });
    }
}

module.exports = handleToggleCallback;