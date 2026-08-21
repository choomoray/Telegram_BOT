// handlers/queryHandler.js
const bot = require('../bot');
const logger = require('../logger');
const { isAdmin } = require('../utils/permissions');
const { getCollection, COLLECTIONS } = require('../db/getCollection');
const { getSettings } = require('../db/settings');
const { parseQuery } = require('../utils/queryParser');
const { formatQueryResults, buildFoldKeyboard, buildNumberKeyboard } = require('../utils/queryFormatter');
const { createSession } = require('../utils/queryCache');
const { insertLog } = require('../db/log');

function buildQuery(parsed) {
    const { keyword, tags, tagsAll } = parsed;
    const query = {};

    if (keyword) {
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        query.text = { $regex: escaped, $options: 'i' };
    }

    // 宽松标签：命中任一标签即可（大小写不敏感）
    if (tags && tags.length > 0) {
        query.tags = {
            $in: tags.map(t => new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'))
        };
    }

    // 严格标签：必须同时包含 -- 后面的所有标签（大小写不敏感）
    if (tagsAll && tagsAll.length > 0) {
        query.$and = tagsAll.map(t => ({
            tags: new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
        }));
    }

    return query;
}

function getSortRules(settings) {
    const sort = [];
    if (settings.search_random === 1) {
        sort.push(['$sample', 1]);
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
        // 白名单用户（非管理员）允许基础查询（与 README 权限模型一致）
        const { isUserAllowed } = require('../db/users');
        const allowed = await isUserAllowed(userId);
        if (!allowed) {
            logger.info(`用户 ${userId} 非管理员且不在白名单，查询请求已忽略`);
            return;
        }
    }

    const parsed = parseQuery(text);
    const { keyword } = parsed;

    if (!keyword && parsed.tags.length === 0 && parsed.tagsAll.length === 0) {
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
                { query, sortRules, parsed, settings, pageSize: 15 }
            );

            const pageSize = 15;
            const totalPages = Math.ceil(total / pageSize);
            const pageResults = allResults.slice(0, pageSize);

            const formattedText = formatQueryResults(pageResults, total, keyword, 1, totalPages, pageSize);

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