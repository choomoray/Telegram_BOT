// utils/chatIdConverter.js
/**
 * Telegram chat_id 转换工具
 * 
 * 机器人收到的 chat_id：
 * - 私聊/群组：原始数字 ID（如 -1001234567890）
 * - 频道/超级群组：通常是 -100 开头的长整型
 * 
 * 用于 https://t.me/c/xxxx/yyyy 链接的 chat_id 转换规则：
 * 1. 去掉前缀 -100，取剩余部分
 * 2. 正数直接使用
 * 
 * 例如：
 *   chat_id = -1001234567890  → 链接中的 chat_id = 1234567890
 *   chat_id = 123456789      → 链接中的 chat_id = 123456789
 */

/**
 * 将机器人接收到的 chat_id 转换为可在 t.me/c/ 链接中使用的格式
 * @param {number|string} chatId - 机器人接收到的 chat_id
 * @returns {string} - 转换后的 chat_id（不带负号）
 */
function convertToLinkChatId(chatId) {
    // 转换为字符串处理
    let idStr = String(chatId);

    // 如果是超级群组/频道（通常以 -100 开头），去掉前缀
    if (idStr.startsWith('-100')) {
        return idStr.substring(4); // 去掉 "-100" 四个字符
    }

    // 如果是普通群组/私聊，直接返回正数形式（去掉负号）
    if (idStr.startsWith('-')) {
        return idStr.substring(1);
    }

    // 已经是正数，直接返回
    return idStr;
}

/**
 * 生成 Telegram 消息跳转链接
 * @param {number|string} chatId - 机器人接收到的原始 chat_id
 * @param {number|string} messageId - 消息 ID
 * @returns {string} - 格式如 https://t.me/c/1234567890/123
 */
function generateMessageLink(chatId, messageId) {
    const linkChatId = convertToLinkChatId(chatId);
    return `https://t.me/c/${linkChatId}/${messageId}`;
}

module.exports = {
    convertToLinkChatId,
    generateMessageLink
};