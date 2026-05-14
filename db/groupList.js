// db/groupList.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

/**
 * 原子性地增加 group_list 的 is_group 计数，若不存在则创建
 * @param {string} groupId - 媒体组ID
 */
async function upsertGroupList(groupId) {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        const result = await col.updateOne(
            { group_id: groupId },
            {
                $inc: { is_group: 1 },
                $setOnInsert: {
                    group_id: groupId,
                    is_delete: null,      // 🔁 默认 null，表示“未确定状态”
                    mark: 0
                }
            },
            { upsert: true }
        );

        if (result.upsertedCount > 0) {
            logger.info(`group_list 创建: group_id=${groupId}, is_group=1, is_delete=null`);
        } else {
            const updated = await col.findOne({ group_id: groupId });
            logger.info(`group_list 更新: group_id=${groupId}, +1, is_group now=${updated?.is_group || 'unknown'}`);
        }
        return result;
    } catch (err) {
        logger.error(`group_list upsert 失败: ${err.message}`);
        throw err;
    }
}

/**
 * 设置 group_list 的 is_delete 字段
 * @param {string} groupId 
 * @param {number|null} deleteTimestamp - 时间戳（毫秒）或0/null
 */
async function setGroupDelete(groupId, deleteTimestamp) {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        const result = await col.updateOne(
            { group_id: groupId },
            { $set: { is_delete: deleteTimestamp } }
        );
        logger.info(`group_list 设置删除标记: group_id=${groupId}, is_delete=${deleteTimestamp}`);
        return result;
    } catch (err) {
        logger.error(`设置 group_list 删除标记失败: ${err.message}`);
        throw err;
    }
}

/**
 * 查询 group_list
 */
async function findGroupList(groupId) {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        return await col.findOne({ group_id: groupId });
    } catch (err) {
        logger.error(`查询 group_list 失败: ${err.message}`);
        return null;
    }
}

/**
 * 删除 group_list 记录（用于回滚）
 */
async function deleteGroupList(groupId) {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        const result = await col.deleteOne({ group_id: groupId });
        logger.info(`group_list 删除: group_id=${groupId}, deleted=${result.deletedCount}`);
        return result;
    } catch (err) {
        logger.error(`删除 group_list 失败: ${err.message}`);
        throw err;
    }
}

module.exports = {
    upsertGroupList,
    setGroupDelete,
    findGroupList,
    deleteGroupList
};