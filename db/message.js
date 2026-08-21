// db/message.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

/**
 * 新增或更新 message 记录
 * @param {Object} data - { message_id, chat_id, text, file_unique_id, media_type, group_id }
 */
async function upsertMessage(data) {
    try {
        const col = getCollection(COLLECTIONS.MESSAGE);
        const { file_unique_id, ...rest } = data;
        const result = await col.updateOne(
            { file_unique_id },
            { $set: { ...rest } },
            { upsert: true }
        );
        logger.info(`message 记录 upsert: file_unique_id=${file_unique_id}, upserted=${result.upsertedCount}`);
        return result;
    } catch (err) {
        logger.error(`message 记录 upsert 失败: ${err.message}`);
        throw err;
    }
}

/**
 * 根据 file_unique_id 查询 message
 */
async function findMessageByFileUniqueId(fileUniqueId) {
    try {
        const col = getCollection(COLLECTIONS.MESSAGE);
        return await col.findOne({ file_unique_id: fileUniqueId });
    } catch (err) {
        logger.error(`查询 message 失败: ${err.message}`);
        return null;
    }
}

/**
 * 根据 file_unique_id 删除 message
 */
async function deleteMessageByFileUniqueId(fileUniqueId) {
    try {
        const col = getCollection(COLLECTIONS.MESSAGE);
        const result = await col.deleteOne({ file_unique_id: fileUniqueId });
        logger.info(`message 删除: file_unique_id=${fileUniqueId}, deleted=${result.deletedCount}`);
        return result;
    } catch (err) {
        logger.error(`删除 message 失败: ${err.message}`);
        throw err;
    }
}

/**
 * 根据 group_id 查询 message 列表
 */
async function findMessagesByGroupId(groupId) {
    try {
        const col = getCollection(COLLECTIONS.MESSAGE);
        return await col.find({ group_id: groupId }).toArray();
    } catch (err) {
        logger.error(`查询 group_id message 失败: ${err.message}`);
        return [];
    }
}

// ---------------- 标签操作 ----------------

/**
 * 给媒体组的所有 message 添加标签（去重）
 * @returns {Promise<number>} 修改的文档数
 */
async function addTagToGroup(groupId, tag) {
    try {
        const col = getCollection(COLLECTIONS.MESSAGE);
        const result = await col.updateMany({ group_id: groupId }, { $addToSet: { tags: tag } });
        logger.info(`标签添加: group_id=${groupId}, tag=${tag}, modified=${result.modifiedCount}`);
        return result.modifiedCount;
    } catch (err) {
        logger.error(`添加组标签失败: ${err.message}`);
        return 0;
    }
}

/**
 * 移除媒体组所有 message 中的指定标签
 * @returns {Promise<number>} 修改的文档数
 */
async function removeTagFromGroup(groupId, tag) {
    try {
        const col = getCollection(COLLECTIONS.MESSAGE);
        const result = await col.updateMany({ group_id: groupId }, { $pull: { tags: tag } });
        logger.info(`标签移除: group_id=${groupId}, tag=${tag}, modified=${result.modifiedCount}`);
        return result.modifiedCount;
    } catch (err) {
        logger.error(`移除组标签失败: ${err.message}`);
        return 0;
    }
}

/**
 * 获取媒体组的全部标签（组内所有 message 的 tags 并集）
 * @returns {Promise<string[]>}
 */
async function getGroupTags(groupId) {
    try {
        const col = getCollection(COLLECTIONS.MESSAGE);
        const docs = await col.find({ group_id: groupId, tags: { $exists: true, $ne: [] } }).toArray();
        const set = new Set();
        for (const d of docs) {
            if (Array.isArray(d.tags)) {
                for (const t of d.tags) set.add(t);
            }
        }
        return [...set];
    } catch (err) {
        logger.error(`获取组标签失败: ${err.message}`);
        return [];
    }
}

/**
 * 全库重命名标签（编辑标签改名时同步）
 * @returns {Promise<number>} 修改的文档数
 */
async function renameTagInMessages(oldName, newName) {
    try {
        const col = getCollection(COLLECTIONS.MESSAGE);
        const result = await col.updateMany(
            { tags: oldName },
            { $set: { 'tags.$': newName } }
        );
        logger.info(`标签全库重命名: ${oldName} -> ${newName}, modified=${result.modifiedCount}`);
        return result.modifiedCount;
    } catch (err) {
        logger.error(`标签重命名同步失败: ${err.message}`);
        return 0;
    }
}

/**
 * 全库移除标签（编辑标签删除时同步）
 * @returns {Promise<number>} 修改的文档数
 */
async function removeTagFromAllMessages(tag) {
    try {
        const col = getCollection(COLLECTIONS.MESSAGE);
        const result = await col.updateMany({}, { $pull: { tags: tag } });
        logger.info(`标签全库移除: ${tag}, modified=${result.modifiedCount}`);
        return result.modifiedCount;
    } catch (err) {
        logger.error(`标签全库移除失败: ${err.message}`);
        return 0;
    }
}

module.exports = {
    upsertMessage,
    findMessageByFileUniqueId,
    deleteMessageByFileUniqueId,
    findMessagesByGroupId,
    addTagToGroup,
    removeTagFromGroup,
    getGroupTags,
    renameTagInMessages,
    removeTagFromAllMessages
};