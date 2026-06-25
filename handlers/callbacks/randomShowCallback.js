// handlers/callbacks/randomShowCallback.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getSession, getPageResults, setSessionMode } = require('../../utils/queryCache');
const { formatQueryResults, buildNumberKeyboard } = require('../../utils/queryFormatter');

async function handleRandomShowCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 2 || parts[0] !== 'rshow') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const sessionId = parts[1];
    const session = getSession(sessionId);
    if (!session) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 会话已过期，请重新生成' });
        return;
    }

    setSessionMode(sessionId, 'number');

    const pageData = getPageResults(sessionId, 1);
    if (!pageData) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 数据错误' });
        return;
    }

    const { totalPages, currentPage, total, pageResults } = pageData;
    const pageSize = session.pageSize || 15;

    const keyboard = buildNumberKeyboard(sessionId, currentPage, totalPages, pageResults, total, pageSize);
    const formattedText = formatQueryResults(pageResults, total, session.keyword, currentPage, totalPages, pageSize);

    try {
        await bot.editMessageText(formattedText, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
        await bot.answerCallbackQuery(query.id);
        logger.info(`用户 ${query.from.id} 展开随机视频数字键盘`);
    } catch (err) {
        logger.error(`展开数字键盘失败: ${err.message}`);
        await bot.answerCallbackQuery(query.id, { text: '❌ 展开失败' });
    }
}

module.exports = handleRandomShowCallback;