// utils/groupGenerator.js
/**
 * 媒体组 ID (group_id) 生成器
 * 
 * 规则：
 * 1. 单一媒体消息（无 media_group_id）：
 *    group_id = `${chatId}_${messageId}`
 * 
 * 2. 媒体组消息（有 media_group_id）：
 *    group_id = `${chatId}_${mediaGroupId}`
 * 
 * 保证在同一个 chat 内唯一，且媒体组内所有媒体共享同一个 group_id
 */

/**
 * 为单一媒体消息生成 group_id
 * @param {number|string} chatId - 消息所在的 chat_id
 * @param {number|string} messageId - 消息的 message_id
 * @returns {string} - group_id
 */
function generateSingleGroupId(chatId, messageId) {
    return `${chatId}_${messageId}`;
}

/**
 * 为媒体组消息生成 group_id
 * @param {number|string} chatId - 消息所在的 chat_id
 * @param {string} mediaGroupId - 消息的 media_group_id
 * @returns {string} - group_id
 */
function generateMediaGroupId(chatId, mediaGroupId) {
    return `${chatId}_${mediaGroupId}`;
}

/**
 * 根据消息对象自动判断并生成 group_id
 * @param {Object} msg - Telegram 消息对象
 * @returns {string|null} - group_id，如果不是媒体消息则返回 null
 */
function generateGroupIdFromMessage(msg) {
    // 检查是否包含支持的媒体类型
    const supportedTypes = ['photo', 'video', 'audio', 'document'];
    const hasMedia = supportedTypes.some(type => msg[type]);
    if (!hasMedia) {
        return null;
    }

    const chatId = msg.chat.id;

    // 优先使用 media_group_id（媒体组）
    if (msg.media_group_id) {
        return generateMediaGroupId(chatId, msg.media_group_id);
    }

    // 单一媒体
    return generateSingleGroupId(chatId, msg.message_id);
}

module.exports = {
    generateSingleGroupId,
    generateMediaGroupId,
    generateGroupIdFromMessage
};