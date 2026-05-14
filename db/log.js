// db/log.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

const LOG_TYPES = {
    BOT_START: 0,
    MEDIA_SAVE: 1,
    MEDIA_EDIT: 2,
    MEDIA_DELETE: 3,
    RANDOM_VIDEO: 11,
    RANDOM_PICTURE: 12,
    MESSAGE_REPLY: 13,
    MEDIA_MERGE: 14,
    MEDIA_HIDE: 15,
    HELP: 16,
    SEARCH: 17,
    CLEAN: 18,
    DELETE_MODE: 19,
    MARK: 20,
    MEDIA_UNHIDE: 21,
    KEYWORD_QUERY: 22,
    EDIT_TEXT: 23,
    SETTING_UPDATE: 24// 新增
};

/**
 * 插入操作日志
 * @param {number} type - 操作类型编码
 * @param {number} [userId] - 可选，仅私聊操作记录用户ID
 * @param {Object} [extra] - 可选附加字段，如查询文本等
 */
async function insertLog(type, userId, extra = {}) {
    try {
        const col = getCollection(COLLECTIONS.LOG);
        const logEntry = {
            type,
            time: Date.now()
        };
        if (userId !== undefined) {
            logEntry.userId = userId;
        }
        // 合并附加字段
        Object.assign(logEntry, extra);
        await col.insertOne(logEntry);
        logger.info(`操作日志已记录: type=${type}${userId !== undefined ? ` userId=${userId}` : ''}${extra.queryText ? ` query="${extra.queryText}"` : ''}`);
    } catch (err) {
        logger.error(`插入操作日志失败: ${err.message}`);
    }
}

module.exports = { insertLog };