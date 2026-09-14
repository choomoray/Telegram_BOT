// utils/textMediaEdit.js
/**
 * 修改「文本媒体」（media_type='text'，/send、/reply 发出的纯文本）的正文
 *
 * 文本媒体的正文存在 `media.media_name`（"借用"文件名那个字段，见 media.recordTextMedia），
 * 与媒体消息的 caption 不是一回事 —— 所以编辑它要：
 *   1. 改写 media.media_name（格式一并写回 media_entities：**严格保留用户发送的格式**；
 *      新正文没有格式时清掉旧 entities，避免偏移量对新文本错位）；
 *   2. 若该 file_unique_id 上存在 message 记录（历史数据 / 控制台补过描述），
 *      同步它的 text 并补充标签，保持"描述 + 标签"两边一致。
 *
 * 供群组回复 /edit、私聊 /edit（消息链接 / 转发来源）、控制台改描述共用。
 */
const logger = require('../logger');
const { getCollection, COLLECTIONS } = require('../db/getCollection');
const { updateTextMediaContent } = require('../db/media');
const { findMessageByFileUniqueId } = require('../db/message');
const { reMatchMessageTags } = require('./tagSync');

/**
 * 应用文本媒体的正文修改
 * @param {string} fileUniqueId - 文本媒体的唯一 ID（text:<chatId>:<messageId>）
 * @param {string} cleanText - 新正文（已去掉等级后缀等）
 * @param {Array} [entities] - 新正文的 Telegram 富文本 entities（严格保留用户发送的格式）
 * @returns {Promise<{mediaUpdated: boolean, messageUpdated: boolean}>}
 */
async function applyTextMediaEdit(fileUniqueId, cleanText, entities) {
    const mediaUpdated = await updateTextMediaContent(fileUniqueId, cleanText, entities);
    let messageUpdated = false;
    try {
        const msgDoc = await findMessageByFileUniqueId(fileUniqueId);
        if (msgDoc) {
            await getCollection(COLLECTIONS.MESSAGE).updateOne(
                { file_unique_id: fileUniqueId },
                { $set: { text: cleanText, updated_at: Date.now() } }
            );
            await reMatchMessageTags(fileUniqueId, cleanText);
            messageUpdated = true;
        }
    } catch (err) {
        logger.error(`文本媒体同步 message 记录失败: ${err.message}`);
    }
    return { mediaUpdated, messageUpdated };
}

module.exports = { applyTextMediaEdit };
