// utils/tagSync.js
/**
 * 标签按 message 独立时的同步工具：
 * 文本新增/修改后，把该 message 的标签**补充**为「原有标签 ∪ 新文本自动匹配出的标签」
 * ——编辑描述**不再移除已有标签**（只有清空描述时才用 clearMessageTags 清空）。
 * 供发送/回复自动打标签、编辑 caption（私聊 edit、群内直接编辑、回复 /edit、控制台改描述）共用。
 */
const logger = require('../logger');
const { getMessageTags, removeTagFromMessage, addTagToMessage } = require('../db/message');
const { getTags, tagUsed } = require('../db/tags');
const { matchTagsInText } = require('./tagUi');

/**
 * 按新文本补充某条 message 的标签：保留已有标签，只把新文本里匹配到、且尚未打上的标签补上
 * （不改动、不删除已有标签；清空描述请用 clearMessageTags）
 * @param {string} fileUniqueId
 * @param {string} text - 新的媒体文本
 */
async function reMatchMessageTags(fileUniqueId, text) {
    if (!fileUniqueId) return;
    try {
        const allTags = await getTags();
        const matched = matchTagsInText(text || '', allTags);
        const prev = await getMessageTags(fileUniqueId);
        const added = matched.filter(tag => !prev.includes(tag));
        for (const tag of added) {
            await addTagToMessage(fileUniqueId, tag);
            await tagUsed(tag, 1);
        }
        logger.info(`标签补充: file_unique_id=${fileUniqueId}, 已有[${prev.join('、') || '无'}] + [${added.join('、') || '无'}]`);
    } catch (err) {
        logger.error(`标签补充失败: ${err.message}`);
    }
}

/**
 * 清空某条 message 的全部标签（只在「清空描述」时调用；编辑描述不移除标签）
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
