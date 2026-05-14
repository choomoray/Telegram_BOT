// handlers/queryHandler.js
const bot = require('../bot');
const logger = require('../logger');
const { ADMIN_CHAT_IDS } = require('../config');
const { getCollection, COLLECTIONS } = require('../db/getCollection');
const { getSettings } = require('../db/settings');
const { parseQuery } = require('../utils/queryParser');
const { formatQueryResults, buildFoldKeyboard, buildNumberKeyboard } = require('../utils/queryFormatter');
const { createSession } = require('../utils/queryCache');
const { insertLog } = require('../db/log');

const LEVELS = ['S', 'A', 'B', 'C', 'D'];

function isAdmin(userId) {
    return ADMIN_CHAT_IDS.includes(userId);
}

function buildQuery(parsed) {
    const { types, specifiedLevels, levelGTE, levelLTE, keyword } = parsed;
    const query = {};

    if (types.length > 0) {
        query.media_type = { $in: types };
    }

    const levelConditions = [];

    if (specifiedLevels.length > 0) {
        levelConditions.push({ level: { $in: specifiedLevels } });
    }

    for (const level of levelGTE) {
        const idx = LEVELS.indexOf(level);
        levelConditions.push({ level: { $in: LEVELS.slice(0, idx + 1) } });
    }

    for (const level of levelLTE) {
        const idx = LEVELS.indexOf(level);
        levelConditions.push({ level: { $in: LEVELS.slice(idx) } });
    }

    if (levelConditions.length > 0) {
        query.$or = levelConditions;
    }

    if (keyword) {
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        query.text = { $regex: escaped, $options: 'i' };
    }

    return query;
}

function getSortRules(settings) {
    const sort = [];
    if (settings.search_level === 1) {
        sort.push(['level', -1]);
        if (settings.search_random === 1) {
            sort.push(['$sample', 1]);
        }
    } else {
        if (settings.search_random === 1) {
            sort.push(['$sample', 1]);
        }
    }
    return sort;
}

async function executeQuery(query, sortRules) {
    const col = getCollection(COLLECTIONS.MESSAGE);

    const useSample = sortRules.some(rule => rule[0] === '$sample');

    let cursor;
    if (useSample) {
        const pipeline = [
            { $match: query },
            { $sample: { size: 10000 } }
        ];
        const hasLevelSort = sortRules.some(rule => rule[0] === 'level');
        if (hasLevelSort) {
            pipeline.push({ $sort: { level: -1 } });
        }
        cursor = col.aggregate(pipeline);
    } else {
        cursor = col.find(query);
        const mongoSort = {};
        for (const [field, order] of sortRules) {
            if (field !== '$sample') {
                mongoSort[field] = order;
            }
        }
        if (Object.keys(mongoSort).length > 0) {
            cursor = cursor.sort(mongoSort);
        }
    }

    return await cursor.toArray();
}

async function handleQuery(msg) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const text = msg.text || '';

    if (!isAdmin(userId)) {
        logger.info(`用户 ${userId} 非管理员，查询请求已忽略`);
        return;
    }

    const parsed = parseQuery(text);
    const { keyword } = parsed;

    if (!keyword && parsed.types.length === 0 && parsed.specifiedLevels.length === 0 &&
        parsed.levelGTE.length === 0 && parsed.levelLTE.length === 0) {
        logger.info(`用户 ${userId} 发送空查询，已忽略`);
        return;
    }

    logger.info(`用户 ${userId} 发起查询: "${text}" -> 解析:`, parsed);

    let processingMsg;
    try {
        processingMsg = await bot.sendMessage(chatId, '♻️ 查询中，请稍等...', {
            reply_to_message_id: messageId,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送查询中消息失败: ${err.message}`);
        return;
    }

    (async () => {
        try {
            const settings = await getSettings();
            const sortRules = getSortRules(settings);

            const query = buildQuery(parsed);
            logger.info(`查询条件:`, query);

            const allResults = await executeQuery(query, sortRules);
            const total = allResults.length;
            logger.info(`查询到 ${total} 条数据`);

            insertLog(22, userId, { queryText: text }).catch(err => logger.error(`记录日志失败: ${err.message}`));

            if (total === 0) {
                await bot.editMessageText(`🔍 没有找到匹配的数据`, {
                    chat_id: chatId,
                    message_id: processingMsg.message_id,
                    parse_mode: 'HTML'
                });
                return;
            }

            const sessionId = createSession(
                userId,
                text,
                allResults,
                total,
                keyword,
                { query, sortRules, parsed, settings }
            );

            const pageSize = 15;
            const totalPages = Math.ceil(total / pageSize);
            const pageResults = allResults.slice(0, pageSize);

            const formattedText = formatQueryResults(pageResults, total, keyword, 1, totalPages);

            let keyboard;
            if (totalPages === 1) {
                keyboard = {
                    inline_keyboard: [[
                        { text: '查看', callback_data: `rshow:${sessionId}` }
                    ]]
                };
            } else {
                keyboard = buildFoldKeyboard(totalPages, 1, sessionId);
            }

            await bot.editMessageText(formattedText, {
                chat_id: chatId,
                message_id: processingMsg.message_id,
                parse_mode: 'HTML',
                reply_markup: keyboard
            });

            logger.success(`用户 ${userId} 查询结果已发送，共 ${total} 条，会话ID: ${sessionId}`);
        } catch (err) {
            logger.error(`查询处理失败: ${err.message}`);
            try {
                await bot.editMessageText('❌ 查询失败，请稍后重试', {
                    chat_id: chatId,
                    message_id: processingMsg.message_id
                });
            } catch (editErr) {
                logger.error(`编辑错误消息失败: ${editErr.message}`);
            }
        }
    })();
}

module.exports = {
    handleQuery,
    isAdmin
};