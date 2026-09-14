// handlers/queryHandler.js
const bot = require('../bot');
const logger = require('../logger');
const { isAdmin } = require('../utils/permissions');
const { getCollection, COLLECTIONS } = require('../db/getCollection');
const { getSettings } = require('../db/settings');
const { parseQuery, QUERY_SYNTAX_HINT } = require('../utils/queryParser');
const { formatQueryResults, buildFoldKeyboard, buildNumberKeyboard } = require('../utils/queryFormatter');
const { createSession } = require('../utils/queryCache');
const { resolveMediaPosition } = require('../db/media');
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
 * - 类型标记（`+d` / `+a` / `+p` / `+v` / `+t`）：message.media_type 限定在给定类型内；
 * - 命中媒体组后，组内**所有描述**都返回（满足"媒体组包含多个描述时全部显示"），
 *   带关键字时**关键字命中的描述排最前**（最符合查询的优先）。
 *
 * @param {Object} parsed - parseQuery 的结果
 * @returns {Promise<{query: Object, rankedGroups: Set<string>}>}
 *   rankedGroups：由 group_list 命中的媒体组（用于结果排序，命中组排最前）
 */
async function buildQuery(parsed) {
    const { keyword, tags, tagsAll, types } = parsed;
    const query = {};
    const rankedGroups = new Set();

    if (keyword) {
        query.text = { $regex: escapeRe(keyword), $options: 'i' };
    }

    // 类型标记：只保留这些 media_type 的记录
    if (Array.isArray(types) && types.length > 0) {
        query.media_type = { $in: types };
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

/**
 * 第二个数据源：media 库的**名称**（`media_name`）
 *
 * 收录时文件/音乐的名称写在 media.media_name（文本类型则是文本内容），
 * message 库里没有对应描述的媒体（例如只发了文件、没写描述）只能靠它找到，
 * 因此关键字查询要"先查 message 的描述、再查 media 的名称"。
 *
 * @param {string} keyword - 关键字（可为空：只按类型列出）
 * @param {string[]} types - media_type 限定（可为空）
 * @returns {Promise<Object[]>} media 文档数组
 */
async function searchMediaByName(keyword, types = []) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        const filter = {};
        // 与 message.text 的查询写法保持一致（$regex + $options；测试用的内存库桩也支持这两个操作符）
        if (keyword) filter.media_name = { $regex: escapeRe(keyword), $options: 'i' };
        else filter.media_name = { $exists: true, $ne: '' };   // 只按类型列时也要求有名称
        if (Array.isArray(types) && types.length) filter.media_type = { $in: types };
        return await col.find(filter).limit(2000).toArray();
    } catch (err) {
        logger.error(`按名称搜索 media 失败: ${err.message}`);
        return [];
    }
}

/**
 * 把 media 命中转成与 message 结果同构的行
 * （结果列表 / 分页 / 「查看」按钮都按 message 行的形状消费：需要 group_id + file_unique_id + 位置）
 */
function mediaHitToResultRow(mediaDoc) {
    const pos = resolveMediaPosition(mediaDoc);
    return {
        group_id: mediaDoc.group_id,
        file_unique_id: mediaDoc.file_unique_id,
        media_type: mediaDoc.media_type,
        // 结果行显示的文本：文件/音乐名或文本内容本身（命中的就是它，必须看得见）
        text: mediaDoc.media_name || '',
        media_name: mediaDoc.media_name || '',
        chat_id: pos ? pos.chatId : undefined,
        message_id: pos ? pos.messageId : undefined,
        matched_by_name: true
    };
}

/**
 * 合并两个数据源：message 描述命中 + media 名称命中，**两边都有的按 file_unique_id 去重**
 * （同一条媒体既有描述又命中文件名时只显示一次，且保留信息更全的 message 行）
 */
function mergeNameHits(messageResults, mediaHits) {
    if (!mediaHits || mediaHits.length === 0) return messageResults;
    const seen = new Set(messageResults.map(r => r && r.file_unique_id).filter(Boolean));
    const extra = [];
    for (const doc of mediaHits) {
        if (!doc || !doc.file_unique_id) continue;
        if (seen.has(doc.file_unique_id)) continue;
        seen.add(doc.file_unique_id);
        extra.push(mediaHitToResultRow(doc));
    }
    return messageResults.concat(extra);
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

    // 段落顺序不对（例如 `+d 关键字` / `-标签 +d`）：不予查询，只回一条语法提示
    if (!parsed.valid) {
        logger.info(`用户 ${userId} 查询格式错误，已拒绝: "${text}"`);
        await bot.sendMessage(chatId, QUERY_SYNTAX_HINT, {
            reply_to_message_id: messageId,
            allow_sending_without_reply: true
        }).catch(err => logger.error(`发送查询语法提示失败: ${err.message}`));
        return;
    }

    const hasTypes = Array.isArray(parsed.types) && parsed.types.length > 0;
    if (!keyword && parsed.tags.length === 0 && parsed.tagsAll.length === 0 && !hasTypes) {
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
            const messageResults = rankResults(rawResults, buildQueryResult.rankedGroups, keyword);

            // 第二个数据源：media 的名称（文件/音乐名、文本内容）——
            // 先查 message 的描述，再查 media 的名称，两边都命中的按 file_unique_id 去重。
            // 只在"有关键字"或"有类型标记"时才查：纯标签查询（`-JK`）不该把全库文件都带出来。
            const mediaHits = (keyword || hasTypes) ? await searchMediaByName(keyword, parsed.types) : [];
            const allResults = mergeNameHits(messageResults, mediaHits);
            const total = allResults.length;
            logger.info(`查询到 ${total} 条数据（描述命中 ${messageResults.length} 条，名称命中补充 ${total - messageResults.length} 条）`);

            // 查询完成留痕（命中 0 条也照记；0 会被 counts 过滤，故同时写入 detail.results）
            const queryDetail = {
                query: text,
                parseMode: parsed.tagsAll && parsed.tagsAll.length ? 'strict' : (parsed.tags && parsed.tags.length ? 'loose' : 'keyword'),
                keywords: keyword || undefined,
                tags: parsed.tags && parsed.tags.length ? parsed.tags : undefined,
                strictTags: parsed.tagsAll && parsed.tagsAll.length ? parsed.tagsAll : undefined,
                types: parsed.types && parsed.types.length ? parsed.types : undefined,
                byName: (total - messageResults.length) || undefined,
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
    // 导出供单元测试（标签查询：先 group_list 再 message；关键字查询：先 message 描述再 media 名称）
    buildQuery,
    rankResults,
    searchMediaByName,
    mediaHitToResultRow,
    mergeNameHits
};