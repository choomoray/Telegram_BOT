// handlers/modes/chatMode/dbOperations.js
const { getCollection, COLLECTIONS } = require('../../../db/getCollection');
const logger = require('../../../logger');

/**
 * 执行数据库查询
 */
async function executeQuery(collectionName, queryStr) {
    try {
        let queryObj;
        try {
            queryObj = JSON.parse(queryStr);
        } catch (e) {
            return `❌ 查询条件格式错误，必须是有效的 JSON 字符串。错误: ${e.message}`;
        }

        const allowedCollections = {
            'message': COLLECTIONS.MESSAGE,
            'media': COLLECTIONS.MEDIA,
            'group_list': COLLECTIONS.GROUP_LIST,
            'user_setting': COLLECTIONS.USER_SETTING,
            'log': COLLECTIONS.LOG,
            'settings': 'settings'
        };
        const realColName = allowedCollections[collectionName];
        if (!realColName) {
            return `❌ 不允许查询集合 "${collectionName}"。允许的集合: ${Object.keys(allowedCollections).join(', ')}`;
        }

        const col = getCollection(realColName);
        logger.info(`[查询] 开始查询集合 ${realColName}，条件: ${JSON.stringify(queryObj)}`);

        const safeQuery = { ...queryObj };
        const forbiddenOps = ['$where', '$function', '$eval', '$regex', '$text'];
        const checkObj = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            for (const key in obj) {
                if (forbiddenOps.some(op => key.startsWith(op))) {
                    throw new Error(`查询条件包含禁止的操作符: ${key}`);
                }
                if (typeof obj[key] === 'object') checkObj(obj[key]);
            }
        };
        checkObj(safeQuery);

        let limit = safeQuery.limit;
        if (limit === undefined) {
            limit = 10;
        } else {
            limit = parseInt(limit);
            if (isNaN(limit) || limit <= 0) limit = 10;
        }
        delete safeQuery.limit;

        const queryCursor = col.find(safeQuery).limit(limit);
        const results = await queryCursor.toArray();
        logger.info(`[查询] 返回 ${results.length} 条记录`);

        if (results.length === 0) {
            return `查询结果为空。`;
        }

        let resultText = `找到 ${results.length} 条记录（最多显示前 ${limit} 条）:\n`;
        for (let i = 0; i < results.length; i++) {
            const doc = results[i];
            const { _id, ...rest } = doc;
            let docStr = JSON.stringify(rest);
            if (docStr.length > 500) {
                docStr = docStr.substring(0, 500) + '...';
            }
            resultText += `${i + 1}. ${docStr}\n`;
            if (resultText.length > 3000) {
                resultText += '...(结果过长，已截断)';
                break;
            }
        }
        return resultText;
    } catch (err) {
        logger.error(`[查询] 执行失败: ${err.message}`);
        return `❌ 查询失败: ${err.message}`;
    }
}

module.exports = { executeQuery };