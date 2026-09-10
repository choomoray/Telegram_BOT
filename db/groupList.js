// db/groupList.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

/**
 * 原子性地增加 group_list 的 is_group 计数，若不存在则创建
 * @param {string} groupId - 媒体组ID
 * @param {number} [count=1] - 一次增加的数量（媒体组批量落库时一次 +N，避免 N 次串行往返；
 *                             也避免同一 group_id 的并发 upsert 触发唯一索引冲突）
 */
async function upsertGroupList(groupId, count = 1) {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        const result = await col.updateOne(
            { group_id: groupId },
            {
                $inc: { is_group: count },
                $setOnInsert: {
                    group_id: groupId,
                    is_delete: null,      // 🔁 默认 null，表示“未确定状态”
                    mark: 0,
                    last_mark_time: null // ⏱ 最后标记时间（毫秒时间戳）
                }
            },
            { upsert: true }
        );

        if (result.upsertedCount > 0) {
            logger.info(`group_list 创建: group_id=${groupId}, is_group=${count}, is_delete=null`);
        } else {
            const updated = await col.findOne({ group_id: groupId });
            logger.info(`group_list 更新: group_id=${groupId}, +${count}, is_group now=${updated?.is_group || 'unknown'}`);
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
 * 按「组内是否还有文本消息」重算 is_delete（全项目唯一判定入口）：
 *   - 组内还有 message 记录（= 仍有文本媒体） → 0，表示无需清理
 *   - 组内已无 message 记录（= 空描述媒体组） → 当前时间戳，表示可被 /clean 清理
 *
 * 任何会改变「组内文本」的写路径（收录 / 发送 / 回复 / 编辑 / 清空描述 / 删除）
 * 都应调用本函数，而不是各自判断后写死 0 或时间戳：这样后续补文本、改文本会变 0，
 * 清空文本又会变回时间戳，且与媒体组内各条消息的到达顺序无关。
 *
 * @param {string} groupId - 媒体组 ID
 * @returns {Promise<number>} 写入的 is_delete 值（0 或时间戳）
 */
async function syncGroupDeleteByText(groupId) {
    try {
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const textCount = await messageCol.countDocuments({ group_id: groupId });
        const deleteTimestamp = textCount > 0 ? 0 : Date.now();
        await setGroupDelete(groupId, deleteTimestamp);
        return deleteTimestamp;
    } catch (err) {
        logger.error(`按文本重算 is_delete 失败: group_id=${groupId}, ${err.message}`);
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

/**
 * 标记次数 +1，并记录最后标记时间
 * @param {string} groupId - 媒体组ID
 * @returns {Promise<number|null>} 更新后的 mark 值（未匹配到则返回 null）
 */
async function incrementMark(groupId) {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        const result = await col.updateOne(
            { group_id: groupId },
            { $inc: { mark: 1 }, $set: { last_mark_time: Date.now() } }
        );
        if (result.matchedCount === 0) {
            logger.error(`incrementMark: group_list 未找到 group_id=${groupId}`);
            return null;
        }
        const updated = await col.findOne({ group_id: groupId }, { projection: { mark: 1 } });
        return updated ? updated.mark : null;
    } catch (err) {
        logger.error(`incrementMark 失败: ${err.message}`);
        throw err;
    }
}

/**
 * 获取所有标记次数大于 0 的媒体组（按标记次数降序）
 * @returns {Promise<Array>} group_list 文档数组
 */
async function getMarkedGroups() {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        return await col.find({ mark: { $gt: 0 } }).sort({ mark: -1 }).toArray();
    } catch (err) {
        logger.error(`查询已标记媒体组失败: ${err.message}`);
        return [];
    }
}

module.exports = {
    upsertGroupList,
    setGroupDelete,
    syncGroupDeleteByText,
    findGroupList,
    deleteGroupList,
    incrementMark,
    getMarkedGroups
};