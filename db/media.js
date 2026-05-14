// db/media.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

/**
 * 新增 media 记录
 * @param {Object} data - { group_id, subgroup, file_id, file_unique_id, media_type, message_id, video_time (optional) }
 */
async function insertMedia(data) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        const doc = {
            group_id: data.group_id,
            subgroup: data.subgroup !== undefined ? data.subgroup : 1,
            file_id: data.file_id,
            file_unique_id: data.file_unique_id,
            media_type: data.media_type,
            message_id: data.message_id
            // 不再添加 pwd 字段，只有通过 /password 设置的才有
        };
        if (data.media_type === 'video' && data.video_time !== undefined && data.video_time !== null) {
            doc.video_time = data.video_time;
        }
        logger.info(`准备插入 media: ${JSON.stringify(doc)}`);
        const result = await col.insertOne(doc);
        const inserted = await col.findOne({ _id: result.insertedId });
        logger.info(`media 插入成功，存储的文档: ${JSON.stringify(inserted)}`);
        return result;
    } catch (err) {
        if (err.code === 11000) {
            logger.warn(`media 重复插入: ${data.file_unique_id}`);
            return null;
        }
        logger.error(`media 插入失败: ${err.message}`);
        throw err;
    }
}

/**
 * 根据 file_unique_id 查询 media
 */
async function findMediaByFileUniqueId(fileUniqueId) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        return await col.findOne({ file_unique_id: fileUniqueId });
    } catch (err) {
        logger.error(`查询 media 失败: ${err.message}`);
        return null;
    }
}

/**
 * 根据 group_id 查询 media 列表，按 subgroup, message_id 升序排序
 */
async function findMediaByGroupId(groupId) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        return await col.find({ group_id: groupId }).sort({ subgroup: 1, message_id: 1 }).toArray();
    } catch (err) {
        logger.error(`查询 group_id media 失败: ${err.message}`);
        return [];
    }
}

/**
 * 根据 group_id 和 subgroup 查询 media 列表，按 message_id 升序排序
 */
async function findMediaByGroupIdAndSubgroup(groupId, subgroup) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        return await col.find({ group_id: groupId, subgroup: subgroup }).sort({ message_id: 1 }).toArray();
    } catch (err) {
        logger.error(`查询 group_id 和 subgroup media 失败: ${err.message}`);
        return [];
    }
}

/**
 * 获取指定 group_id 的最大 subgroup 值
 */
async function getMaxSubgroup(groupId) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        const result = await col.find({ group_id: groupId }).sort({ subgroup: -1 }).limit(1).toArray();
        return result.length > 0 ? result[0].subgroup : 0;
    } catch (err) {
        logger.error(`获取最大 subgroup 失败: ${err.message}`);
        return 0;
    }
}

/**
 * 根据 file_unique_id 删除 media 记录
 */
async function deleteMediaByFileUniqueId(fileUniqueId) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        const result = await col.deleteOne({ file_unique_id: fileUniqueId });
        logger.info(`media 删除: file_unique_id=${fileUniqueId}, deleted=${result.deletedCount}`);
        return result;
    } catch (err) {
        logger.error(`删除 media 失败: ${err.message}`);
        throw err;
    }
}

/**
 * 更新媒体的密码
 * @param {string} fileUniqueId - 文件的唯一ID
 * @param {string} password - 新密码（如果为空字符串或 null，则删除 pwd 字段）
 * @returns {Promise<boolean>} 是否更新成功
 */
async function updateMediaPassword(fileUniqueId, password) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        let updateDoc;
        if (!password || password === '') {
            // 清除密码字段
            updateDoc = { $unset: { pwd: "" } };
        } else {
            updateDoc = { $set: { pwd: password } };
        }
        const result = await col.updateOne(
            { file_unique_id: fileUniqueId },
            updateDoc
        );
        return result.matchedCount > 0;
    } catch (err) {
        logger.error(`更新媒体密码失败: ${err.message}`);
        return false;
    }
}

module.exports = {
    insertMedia,
    findMediaByFileUniqueId,
    findMediaByGroupId,
    findMediaByGroupIdAndSubgroup,
    getMaxSubgroup,
    deleteMediaByFileUniqueId,
    updateMediaPassword
};