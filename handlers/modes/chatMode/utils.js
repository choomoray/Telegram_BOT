// handlers/modes/chatMode/utils.js
const bot = require('../../../bot');
const logger = require('../../../logger');

/**
 * 安全编辑消息，忽略 "message is not modified" 错误
 */
async function safeEditMessage(thinkingMsg, userId, text, replyMarkup = null) {
    try {
        const options = {
            chat_id: userId,
            message_id: thinkingMsg.message_id,
            parse_mode: 'HTML'
        };
        if (replyMarkup) options.reply_markup = replyMarkup;
        await bot.editMessageText(text, options);
        return thinkingMsg;
    } catch (err) {
        if (err.description && err.description.includes('message is not modified')) {
            return thinkingMsg;
        }
        logger.error(`编辑消息失败: ${err.message}`);
        return null;
    }
}

/**
 * 清理模型回复中的无关内容
 */
function cleanReply(raw) {
    let cleaned = raw;
    cleaned = cleaned.replace(/^SEARCH\s*\n?/, '');
    cleaned = cleaned.replace(/\n?\*\*引用来源：\*\*[\s\S]*$/, '');
    cleaned = cleaned.replace(/\[citation:\d+\]/g, '');
    cleaned = cleaned.replace(/\n{3,}/g, '\n');
    return cleaned.trim();
}

/**
 * 解析 AI 回复，提取 @bot、@ai、@user 部分
 */
function parseAIReply(text) {
    const blocks = [];
    const regex = /@(bot|ai|user):?(\d*)\s*([\s\S]*?)(?=\s*@(?:bot|ai|user)|\s*$)/gs;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const type = match[1];
        const round = match[2] ? parseInt(match[2]) : null;
        const content = match[3].trim();
        if (content) {
            blocks.push({ type, round, content });
        }
    }
    if (blocks.length === 0 && text.trim()) {
        blocks.push({ type: 'user', round: null, content: text.trim() });
    }
    return blocks;
}

module.exports = { safeEditMessage, cleanReply, parseAIReply };