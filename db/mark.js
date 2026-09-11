// db/mark.js
/**
 * 标记记录（mark 集合）——记录每次「标记 / 仅记录」是谁在什么时候做了、针对哪个媒体/媒体组。
 *
 * 文档结构：
 *   mode='mark'   （正常标记，媒体/媒体组存在于媒体库）：
 *     { userId, mode:'mark', isGroup, group_id, file_unique_id, media_type, time, date }
 *   mode='record' （仅记录：不标记任何媒体/媒体组）
 *     { userId, mode:'record', time, date }
 *     —— 仅记录时**不写** group_id / file_unique_id / media_type（没有媒体组这项就不该出现在库里）
 *
 * 说明：group_list.mark（被标记次数）与 last_mark_time 的语义不变，仅由正常标记路径维护；
 * 本集合只是"标记历史"，不参与 mark 计数。
 */
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

/**
 * 写入一条标记记录
 * @param {Object} data
 * @param {number} data.userId - 操作者
 * @param {'mark'|'record'} [data.mode='mark'] - mark=正常标记；record=仅记录（不标记任何媒体/媒体组）
 * @param {string} [data.groupId] - 媒体组 ID（mode='mark' 时写）
 * @param {string} [data.fileUniqueId] - 媒体 file_unique_id（mode='mark' 时写）
 * @param {string} [data.mediaType] - 媒体类型（mode='mark' 时写）
 * @param {boolean} [data.isGroup] - 是否来自媒体组（相册）
 * @returns {Promise<Object|null>} 写入的文档（失败返回 null，不影响业务流程）
 */
async function insertMarkRecord({ userId, mode = 'mark', groupId, fileUniqueId, mediaType, isGroup } = {}) {
    try {
        const col = getCollection(COLLECTIONS.MARK);
        const now = Date.now();
        const doc = {
            userId: userId !== undefined && userId !== null ? userId : null,
            mode: mode === 'record' ? 'record' : 'mark',
            time: now,
            date: new Date(now)
        };
        // 仅记录：没有任何媒体/媒体组，不带这些字段
        if (doc.mode === 'mark') {
            doc.isGroup = !!isGroup;
            if (groupId) doc.group_id = groupId;
            if (fileUniqueId) doc.file_unique_id = fileUniqueId;
            if (mediaType) doc.media_type = mediaType;
        }
        await col.insertOne(doc);
        logger.info(`标记记录写入: mode=${doc.mode}, userId=${doc.userId}${doc.group_id ? `, group_id=${doc.group_id}` : ''}${doc.file_unique_id ? `, file_unique_id=${doc.file_unique_id}` : ''}`);
        return doc;
    } catch (err) {
        logger.error(`标记记录写入失败: ${err.message}`);
        return null;
    }
}

/**
 * 查询标记记录（按时间倒序）
 * @param {Object} [filter] - 额外过滤条件（如 { userId } / { group_id } / { mode }）
 * @param {number} [limit=50]
 * @returns {Promise<Array>}
 */
async function findMarkRecords(filter = {}, limit = 50) {
    try {
        const col = getCollection(COLLECTIONS.MARK);
        return await col.find(filter).sort({ time: -1 }).limit(limit).toArray();
    } catch (err) {
        logger.error(`查询标记记录失败: ${err.message}`);
        return [];
    }
}

module.exports = { insertMarkRecord, findMarkRecords };
