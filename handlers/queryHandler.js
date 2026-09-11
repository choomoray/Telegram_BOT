// handlers/queryHandler.js
const bot = require('../bot');
const logger = require('../logger');
const { isAdmin } = require('../utils/permissions');
const { getCollection, COLLECTIONS } = require('../db/getCollection');
const { getSettings } = require('../db/settings');
const { parseQuery } = require('../utils/queryParser');
const { formatQueryResults, buildFoldKeyboard, buildNumberKeyboard } = require('../utils/queryFormatter');
const { createSession } = require('../utils/queryCache');
const { logOperation } = require('../utils/opLog');

/** 正则转义 */
function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 标签搜索条件（**先查 group_list，再查 message**）：
 *
 * - 宽松标签（`-标签`）：message 与 group_list 都查 → 命中任一标签的媒体组
 *   （group_list.tags 命中整组）+ 自身 message.tags 命中的单条，两者取并集；
 * - 严格标签（`--标签`）：只查 group_list.tags 同时含全部标签的媒体组，
 *   返回这些组内的 message 数据（不再看单条 message 自己的 tags）；
 * - 命中媒体组后，组内**所有描述**都返回（满足"媒体组包含多个描述时全部显示"），
 *   带关键字时**关键字命中的描述排最前**（最符合查询的优先）。
 *
 * @param {Object} parsed - parseQuery 的结果
 * @returns {Promise<{query: Object, rankedGroups: Set<string>}>}
 *   rankedGroups：由 group_list 命中的媒体组（用于结果排序，命中组排最前）
 */
async function buildQuery(parsed) {
    const { keyword, tags, tagsAll } = parsed;
    const query = {};
    const rankedGroups = new Set();

    if (keyword) {
        query.text = { $regex: escapeRe(keyword), $options: 'i' };
    }

    const toTagRegexps = (arr) => arr.map(t => new RegExp(`^${escapeRe(t)}$`, 'i'));

    // 宽松标签：message.tags 命中任一（大小写不敏感）
    if (tags && tags.length > 0) {
        const loose = { tags: { $in: toTagRegexps(tags) } };
        // 先查 group_list：命中任一标签的媒体组
        const groupCol = getCollection(COLLECTIONS.GROUP_LIST);
        const matched = await groupCol.find({ tags: loose.tags }).toArray();
        for (const g of matched) {
            if (g && g.group_id) rankedGroups.add(String(g.group_id));
        }
        const groupIds = [...rankedGroups];
        const orBranches = [];
        if (groupIds.length) orBranches.push({ group_id: { $in: groupIds } });
        orBranches.push(loose);
        query.$or = orBranches;
    }

    // 严格标签：只查 group_list 同时含全部标签的媒体组（再取其 message 数据）
    if (tagsAll && tagsAll.length > 0) {
        const groupCol = getCollection(COLLECTIONS.GROUP_LIST);
        const regExps = toTagRegexps(tagsAll);
        const matched = await groupCol.find({ tags: { $all: regExps } }).toArray();
        const groupIds = matched.map(g => g && g.group_id).filter(Boolean).map(String);
        for (const gid of groupIds) rankedGroups.add(gid);
        // 无媒体组命中 → 返回空结果
        query.group_id = { $in: groupIds };
    }

    return { query, rankedGroups };
}

function getSortRules(settings) {
    const sort = [];
    if (settings.search_random === 1) {
        sort.push(['$sample', 1]);
    }
    return sort;
}

/**
 * 结果排序：由 group_list 命中的媒体组优先；组内/组间带关键字命中的描述再优先
 * （保持数据库返回顺序作为稳定次序）
 */
function rankResults(results, rankedGroups, keyword) {
    if ((!rankedGroups || rankedGroups.size === 0) && !keyword) return results;
    const kw = keyword ? String(keyword).toLowerCase() : null;
    const score = (doc) => {
        let s = 0;
        if (rankedGroups && rankedGroups.size && rankedGroups.has(String(doc.group_id))) s += 2;
        if (kw && doc.text && String(doc.text).toLowerCase().includes(kw)) s += 1;
        return s;
    };
    return results
        .map((doc, idx) => ({ doc, idx, s: score(doc) }))
        .sort((a, b) => (b.s - a.s) || (a.idx - b.idx))
        .map(item => item.doc);
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

            // 先查 group_list（标签汇总）再查 message：宽松=并集，严格=仅命中组内数据
            const buildQueryResult = await buildQuery(parsed);
            const query = buildQueryResult.query;
            logger.info(`查询条件:`, query);

            const rawResults = await executeQuery(query, sortRules);
            const allResults = rankResults(rawResults, buildQueryResult.rankedGroups, keyword);
            const total = allResults.length;
            logger.info(`查询到 ${total} 条数据`);

            // 查询完成留痕（命中 0 条也照记；0 会被 counts 过滤，故同时写入 detail.results）
            const queryDetail = {
                query: text,
                parseMode: parsed.tagsAll && parsed.tagsAll.length ? 'strict' : (parsed.tags && parsed.tags.length ? 'loose' : 'keyword'),
                keywords: keyword || undefined,
                tags: parsed.tags && parsed.tags.length ? parsed.tags : undefined,
                strictTags: parsed.tagsAll && parsed.tagsAll.length ? parsed.tagsAll : undefined,
                random: sortRules.some(rule => rule[0] === '$sample')
            };

            if (total === 0) {
                logOperation({
                    action: 'query_keyword',
                    source: 'private',
                    userId,
                    chatId,
                    messageId,
                    counts: { queries: 1 },
                    detail: { ...queryDetail, results: 0 }
                }).catch(() => { });
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
                { query, sortRules, parsed, settings, pageSize: 15, rankedGroups: [...buildQueryResult.rankedGroups] }
            );

            logOperation({
                action: 'query_keyword',
                source: 'private',
                userId,
                chatId,
                messageId,
                counts: { queries: 1, results: total },
                detail: { ...queryDetail, results: total, sessionId }
            }).catch(() => { });

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
    isAdmin,
    // 导出供单元测试（标签查询：先 group_list 再 message）
    buildQuery,
    rankResults
};