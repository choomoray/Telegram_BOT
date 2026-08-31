// utils/tagSync.js
/**
 * 标签按 message 独立时的同步工具：
 * 文本新增/修改后，把该 message 的标签重算为"文本自动匹配出的标签"（只替换它自己的，不影响组内其他 message）。
 * 供发送/回复自动打标签、编辑 caption（私聊 edit、群内直接编辑、回复 /edit）共用。
 */
const logger = require('../logger');
const { getMessageTags, removeTagFromMessage, addTagToMessage } = require('../db/message');
const { getTags, tagUsed } = require('../db/tags');
const { matchTagsInText } = require('./tagUi');

/**
 * 按新文本重算某条 message 的标签（先清空它原有的，再按文本自动匹配打上）
 * @param {string} fileUniqueId
 * @param {string} text - 新的媒体文本
 */
async function reMatchMessageTags(fileUniqueId, text) {
    if (!fileUniqueId) return;
    try {
        const allTags = await getTags();
        const matched = matchTagsInText(text || '', allTags);
        const prev = await getMessageTags(fileUniqueId);
        for (const tag of prev) {
            await removeTagFromMessage(fileUniqueId, tag);
            await tagUsed(tag, -1);
        }
        for (const tag of matched) {
            await addTagToMessage(fileUniqueId, tag);
            await tagUsed(tag, 1);
        }
        logger.info(`标签重算: file_unique_id=${fileUniqueId}, [${prev.join('、') || '无'}] -> [${matched.join('、') || '无'}]`);
    } catch (err) {
        logger.error(`标签重算失败: ${err.message}`);
    }
}

/**
 * 清空某条 message 的全部标签
 * @param {string} fileUniqueId
 */
async function clearMessageTags(fileUniqueId) {
    if (!fileUniqueId) return;
    try {
        const prev = await getMessageTags(fileUniqueId);
        for (const tag of prev) {
            await removeTagFromMessage(fileUniqueId, tag);
            await tagUsed(tag, -1);
        }
        logger.info(`标签清空: file_unique_id=${fileUniqueId}, [${prev.join('、') || '无'}]`);
    } catch (err) {
        logger.error(`标签清空失败: ${err.message}`);
    }
}

module.exports = { reMatchMessageTags, clearMessageTags };
