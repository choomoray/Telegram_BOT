// db/message.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

/**
 * 新增或更新 message 记录
 * @param {Object} data - { message_id, chat_id, text, file_unique_id, media_type, level, group_id }
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

module.exports = {
    upsertMessage,
    findMessageByFileUniqueId,
    deleteMessageByFileUniqueId,
    findMessagesByGroupId
};