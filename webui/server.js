// webui/server.js
/**
 * Web UI 数据库控制台（零第三方依赖，Node 内置 http）
 *
 * 启动方式：node index.js webui
 * 默认地址：http://127.0.0.1:9700
 *
 * 布局：
 *   左栏上 2/3 — 后端实时运行日志（SSE 推送）
 *   左栏下 1/3 — 数据库操作（选择集合/选中态 + 自然语言输入 + AI 翻译 + 执行 + 执行结果）
 *   右栏       — 数据库数据浏览（可滚动、点击选中高亮）
 *
 * AI 辅助：DeepSeek 将自然语言翻译为完整数据库操作（增删改查），
 *          翻译结果由用户确认后手动执行（删除需二次确认），AI 不直接操作数据库。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const config = require('../config');
const logger = require('../logger');
const { getCollection, COLLECTIONS } = require('../db/getCollection');
const { callDeepSeek } = require('./ai');
const { logOperation, getCatalog, ACTION_BY_TYPE, actionLabel, categoryLabel, legacyTypeLabel, CATEGORIES } = require('../utils/opLog');
const { addTag, tagUsed } = require('../db/tags');
const {
    addTagToMessage, removeTagFromMessage, getMessageTags,
    addTagToGroup, removeTagFromGroup, getGroupTags
} = require('../db/message');
const { reMatchMessageTags, clearMessageTags } = require('../utils/tagSync');
const { removeLevelSuffix } = require('../utils/levelExtractor');
const { updateMessageDb } = require('../handlers/modes/editMode');
const { resolveEditTargets, editCaptionWithFallback } = require('../utils/editTarget');
const { sortMediaDocsByPosition, mediaPositionMessageId, resolveMediaPosition } = require('../db/media');
const { transportLinkUrl } = require('../utils/tgLink');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL = 12 * 60 * 60 * 1000; // 会话有效期 12 小时
const ALL_COLLECTIONS_KEY = '__all__';   // "全部集合" 模式
const ALL_COLLECTIONS_LIMIT = 50;        // 全部模式下每个集合最多取 50 条

// 登录会话：token -> { createdAt }
const sessions = new Map();
// 实际生效的密码（未配置时随机生成）
let effectivePassword = config.WEBUI_PASSWORD || null;
// SSE 日志流客户端
const sseClients = new Set();

// 允许操作的集合白名单
const ALLOWED_COLLECTIONS = new Set(Object.values(COLLECTIONS));

// 默认依赖（测试时可注入 stub 覆盖）
const defaultDeps = {
    getCollection,
    callAI: callDeepSeek,
    password: null, // 测试时可用固定密码
    telegramGetFile, // 缩略图代理：file_id -> 下载地址（函数声明提升，见下方定义）
    editCaption // 修改 Telegram 媒体描述（控制台改描述用）
};

// 领域接口常量
const MEDIA_TYPE_ORDER = ['photo', 'video', 'audio', 'document']; // 媒体类型稳定顺序
const RECENT_LOG_LIMIT = 15;          // 概览页最近日志条数
const LATEST_GROUP_LIMIT = 5;         // 概览页最近媒体组条数
const THUMB_CACHE_MAX = 120;          // 缩略图缓存最大条数（超出按最旧淘汰）
const THUMB_CACHE_TTL = 30 * 60 * 1000;        // 缩略图缓存有效期 30 分钟
const THUMB_CACHE_MAX_BYTES = 4 * 1024 * 1024; // 超过 4MB 的图片不写入缓存
const TELEGRAM_TIMEOUT = 8000;        // Telegram 请求超时（毫秒）

// 缩略图内存缓存：file_unique_id -> { buffer, contentType, at }
const thumbCache = new Map();
// 缩略图并发去重：file_unique_id -> Promise（并发请求共享同一次下载）
const thumbInflight = new Map();

// ---------------- 工具 ----------------

function getPassword() {
    if (effectivePassword) return effectivePassword;
    effectivePassword = crypto.randomBytes(12).toString('hex');
    logger.warn(`Web UI 未配置 WEBUI_PASSWORD，已生成随机密码: ${effectivePassword}（请用该密码登录，或配置 .env 固定密码）`);
    return effectivePassword;
}

function createToken() {
    return crypto.randomBytes(24).toString('hex');
}

function isTokenValid(token) {
    if (!token) return false;
    const session = sessions.get(token);
    if (!session) return false;
    if (Date.now() - session.createdAt > SESSION_TTL) {
        sessions.delete(token);
        return false;
    }
    return true;
}

// 定期清理过期会话
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
        if (now - session.createdAt > SESSION_TTL) sessions.delete(token);
    }
}, 60 * 60 * 1000).unref?.();

function json(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function parseUrl(req) {
    return new URL(req.url, 'http://localhost');
}

function requireAuth(req, res, url) {
    if (url.pathname === '/api/login') return true;
    if (!url.pathname.startsWith('/api/')) return true;
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!isTokenValid(token)) {
        json(res, 401, { error: '未授权或会话已过期' });
        return false;
    }
    return true;
}

function assertCollection(name) {
    if (!ALLOWED_COLLECTIONS.has(name)) {
        throw new Error(`不允许的集合: ${name}`);
    }
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * filter 中的 _id 若是 24 位 hex 字符串则转换为 ObjectId
 */
function sanitizeFilter(filter) {
    const out = { ...filter };
    if (typeof out._id === 'string' && /^[0-9a-fA-F]{24}$/.test(out._id)) {
        out._id = new ObjectId(out._id);
    }
    return out;
}

/**
 * 从 AI 回复中提取 JSON（容忍 ```json 代码块等包装）
 */
function extractJson(text) {
    const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    try {
        return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
        return null;
    }
}

/** 正则转义（用户输入拼入 $regex 前必须转义，避免正则注入） */
function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 标签置顶位置归一化（与 db/tags.js 一致：0~40 的整数，<=0 视为不置顶） */
function normalizePin(pin) {
    const num = parseInt(pin, 10);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.min(num, 40);
}

/**
 * 标签展示排序（与 db/tags.js 的 sortTags 保持一致）：
 * 置顶（pin>0）按 pin 升序在前，其余按使用次数降序，次数相同按名称
 */
function sortTags(tags) {
    const arr = tags.map(t => ({ name: t.name, pin: normalizePin(t.pin), count: t.count || 0 }));
    const pinned = arr.filter(t => t.pin > 0)
        .sort((a, b) => (a.pin - b.pin) || a.name.localeCompare(b.name, 'zh'));
    const normal = arr.filter(t => t.pin === 0)
        .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'zh'));
    return [...pinned, ...normal];
}

/** 媒体组代表媒体：subgroup、位置消息 ID 最小的一条（用于列表缩略图） */
function pickPreviewMedia(mediaDocs) {
    // 位置在 group / channel 子文档里（旧数据才是顶层 message_id），统一按解析出的位置比较
    return sortMediaDocsByPosition(mediaDocs)[0] || null;
}

/** 媒体组最新描述消息：updated_at（缺失时退回 message_id）最大的一条 */
function pickLatestMessage(messageDocs) {
    let best = null;
    for (const doc of messageDocs) {
        if (!best) { best = doc; continue; }
        const a = Number(doc.updated_at) || Number(doc.message_id) || 0;
        const b = Number(best.updated_at) || Number(best.message_id) || 0;
        if (a > b) best = doc;
    }
    return best;
}

/** 单个集合的 countDocuments，失败时回退 0（单个统计失败不影响整个概览接口） */
async function safeCount(D, collectionName, filter, label) {
    try {
        return await D.getCollection(collectionName).countDocuments(filter);
    } catch (err) {
        logger.error(`WebUI 统计失败 [${label}]: ${err.message}`);
        return 0;
    }
}

// ---------------- API 处理 ----------------

async function handleLogin(D, url, body) {
    const { password } = body;
    if (!password || password !== getPassword()) {
        logOperation({ action: 'webui_login_fail', source: 'webui', result: 'fail', error: '密码错误' }).catch(() => { });
        return { status: 401, data: { error: '密码错误' } };
    }
    const token = createToken();
    sessions.set(token, { createdAt: Date.now() });
    logOperation({ action: 'webui_login', source: 'webui' }).catch(() => { });
    return { status: 200, data: { token } };
}

async function handleCollections() {
    return { status: 200, data: { collections: [...ALLOWED_COLLECTIONS].sort() } };
}

/**
 * 查询：collection 为 '__all__' 时跨集合浏览（每集合取前 100 条），
 *        否则为指定集合的分页查询
 */
async function handleDbQuery(D, url, body) {
    const filter = isPlainObject(body.filter) ? sanitizeFilter(body.filter) : {};
    const sort = isPlainObject(body.sort) ? body.sort : { _id: -1 };
    const page = Math.max(1, parseInt(body.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(body.pageSize, 10) || 20));

    if (body.collection === ALL_COLLECTIONS_KEY || !body.collection) {
        const groups = await Promise.all([...ALLOWED_COLLECTIONS].sort().map(async (name) => {
            const col = D.getCollection(name);
            try {
                const [total, items] = await Promise.all([
                    col.countDocuments(filter),
                    col.find(filter).sort({ _id: -1 }).limit(ALL_COLLECTIONS_LIMIT).toArray()
                ]);
                return { collection: name, total, items };
            } catch (err) {
                logger.error(`WebUI 查询集合 ${name} 失败: ${err.message}`);
                return { collection: name, total: 0, items: [], error: err.message };
            }
        }));
        return { status: 200, data: { all: true, limit: ALL_COLLECTIONS_LIMIT, groups } };
    }

    assertCollection(body.collection);
    const col = D.getCollection(body.collection);
    logger.info(`WebUI 查询: collection=${body.collection}, sort=${JSON.stringify(sort)}, page=${page}, pageSize=${pageSize}`);
    const total = await col.countDocuments(filter);
    const items = await col.find(filter)
        .sort(sort)
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();
    return { status: 200, data: { all: false, collection: body.collection, total, page, pageSize, items } };
}

/**
 * 执行数据库操作（AI 翻译或手动构造的操作计划）
 * body: { operation: { action, collection, filter, data, sort, limit }, confirm }
 */
async function handleDbExecute(D, url, body) {
    const op = body.operation;
    if (!isPlainObject(op) || !op.action || !op.collection) {
        return { status: 400, data: { error: '操作格式无效（需要 action 和 collection）' } };
    }
    assertCollection(op.collection);

    const ACTIONS = ['query', 'insert', 'update', 'delete'];
    if (!ACTIONS.includes(op.action)) {
        return { status: 400, data: { error: `不支持的操作: ${op.action}` } };
    }

    const filter = isPlainObject(op.filter) ? sanitizeFilter(op.filter) : {};
    const data = isPlainObject(op.data) ? { ...op.data } : {};

    switch (op.action) {
        case 'query': {
            const sort = isPlainObject(op.sort) ? op.sort : { _id: -1 };
            const limit = Math.min(parseInt(op.limit, 10) || 50, 200);
            const col = D.getCollection(op.collection);
            const [total, items] = await Promise.all([
                col.countDocuments(filter),
                col.find(filter).sort(sort).limit(limit).toArray()
            ]);
            logger.info(`WebUI 执行查询: ${op.collection} filter=${JSON.stringify(filter)} -> ${total} 条`);
            return { status: 200, data: { type: 'query', total, limit, items } };
        }
        case 'insert': {
            if (Object.keys(data).length === 0) return { status: 400, data: { error: '新增操作缺少 data' } };
            delete data._id;
            const result = await D.getCollection(op.collection).insertOne(data);
            logger.info(`WebUI 执行新增: ${op.collection} -> ${result.insertedId}`);
            logOperation({
                action: 'webui_db_execute',
                source: 'webui',
                target: { type: 'collection', id: op.collection },
                counts: { documents: 1 },
                detail: { op: 'insert', collection: op.collection, fields: Object.keys(data).slice(0, 15) }
            }).catch(() => { });
            return { status: 200, data: { type: 'insert', insertedId: result.insertedId } };
        }
        case 'update': {
            if (Object.keys(filter).length === 0) return { status: 400, data: { error: '修改操作 filter 不能为空（需精确定位）' } };
            if (Object.keys(data).length === 0) return { status: 400, data: { error: '修改操作缺少 data' } };
            delete data._id;
            const result = await D.getCollection(op.collection).updateOne(filter, { $set: data });
            logger.info(`WebUI 执行修改: ${op.collection} matched=${result.matchedCount} modified=${result.modifiedCount}`);
            logOperation({
                action: 'webui_db_execute',
                source: 'webui',
                target: { type: 'collection', id: op.collection },
                counts: { documents: result.modifiedCount },
                detail: { op: 'update', collection: op.collection, filter: JSON.stringify(filter).slice(0, 200), fields: Object.keys(data).slice(0, 15), matched: result.matchedCount }
            }).catch(() => { });
            return { status: 200, data: { type: 'update', matchedCount: result.matchedCount, modifiedCount: result.modifiedCount } };
        }
        case 'delete': {
            if (body.confirm !== true) return { status: 400, data: { error: '删除操作需要二次确认（confirm: true）' } };
            if (Object.keys(filter).length === 0) return { status: 400, data: { error: '删除操作 filter 不能为空（禁止全表删除）' } };
            const result = await D.getCollection(op.collection).deleteOne(filter);
            logger.info(`WebUI 执行删除: ${op.collection} deleted=${result.deletedCount}`);
            logOperation({
                action: 'webui_db_execute',
                source: 'webui',
                target: { type: 'collection', id: op.collection },
                counts: { documents: result.deletedCount },
                detail: { op: 'delete', collection: op.collection, filter: JSON.stringify(filter).slice(0, 200) }
            }).catch(() => { });
            return { status: 200, data: { type: 'delete', deletedCount: result.deletedCount } };
        }
        default:
            return { status: 400, data: { error: '未知操作' } };
    }
}

/**
 * AI 翻译：自然语言 -> 完整数据库操作（不执行）
 * body: { prompt, selected?: { collection, doc } }
 */
async function handleAiPlan(D, url, body) {
    const { prompt } = body;
    if (typeof prompt !== 'string' || !prompt.trim()) {
        return { status: 400, data: { error: '缺少 prompt（自然语言操作描述）' } };
    }

    let guide = '';
    try {
        guide = await fs.promises.readFile(path.join(__dirname, 'db-guide.md'), 'utf8');
    } catch (err) {
        logger.error(`读取 db-guide.md 失败: ${err.message}`);
    }

    let system = guide;
    if (body.selected && body.selected.collection && body.selected.doc) {
        system += `\n\n用户当前已选中文档：集合=${body.selected.collection}\n文档内容：\n${JSON.stringify(body.selected.doc, null, 2)}\n如果用户说"这条/这个/它"等，通常指代该文档，请用其 _id 或业务唯一字段作为 filter 精确定位。`;
    }

    // 用明确的分隔与复述要求收束模型输出：避免它忽略本次需求、套用上一次/示例的答案
    const userContent = [
        '用户这一次的需求如下（只针对它生成操作计划，不要沿用示例或上一次的回答）：',
        '"""',
        String(prompt).trim(),
        '"""',
        '要求：先判断该需求对应哪个集合，再决定 action；explain 必须写明集合名与关键条件；只输出 JSON。'
    ].join('\n');

    const content = await D.callAI([
        { role: 'system', content: system },
        { role: 'user', content: userContent }
    ], { temperature: 0.2, maxTokens: 2048 });

    const parsed = extractJson(content);
    if (!parsed || !isPlainObject(parsed.operation)) {
        logger.error(`AI 返回无法解析: ${String(content).slice(0, 300)}`);
        return {
            status: 502,
            data: { error: 'AI 返回格式无效，请重试', raw: String(content).slice(0, 600) }
        };
    }

    // 校验动作与集合：模型偶尔会输出占位文字或白名单外的集合
    const op = parsed.operation;
    const ALLOWED_ACTIONS = ['query', 'insert', 'update', 'delete'];
    if (!ALLOWED_ACTIONS.includes(op.action)) {
        logger.error(`AI 返回非法 action: ${JSON.stringify(op.action)}`);
        return {
            status: 502,
            data: { error: `AI 返回的 action 非法（${String(op.action).slice(0, 40)}），请换一种说法重试`, raw: String(content).slice(0, 600) }
        };
    }
    if (!op.collection || !ALLOWED_COLLECTIONS.has(op.collection)) {
        logger.error(`AI 返回非法集合: ${JSON.stringify(op.collection)}`);
        return {
            status: 502,
            data: { error: `AI 返回的集合不在白名单内（${String(op.collection).slice(0, 40)}），请重试`, raw: String(content).slice(0, 600) }
        };
    }

    logger.info(`WebUI AI 翻译: prompt="${prompt}" -> ${JSON.stringify(op)}`);
    return { status: 200, data: { explain: parsed.explain || '', operation: op } };
}

// ---------------- 领域接口（媒体/清理/标签/用户/聊天） ----------------

/**
 * 概览：GET /api/overview
 * 约 20 个计数并发执行，任一计数失败仅回退 0，不影响整体返回
 */
async function handleOverview(D) {
    const C = COLLECTIONS;
    const [
        media, message, groupList, cleanable, kept, pending,
        users, banned, whitelist, tags, chats, channels, groups, bound, logs,
        photo, video, audio, documentMedia
    ] = await Promise.all([
        safeCount(D, C.MEDIA, {}, 'media'),
        safeCount(D, C.MESSAGE, {}, 'message'),
        safeCount(D, C.GROUP_LIST, {}, 'groupList'),
        safeCount(D, C.GROUP_LIST, { is_delete: { $gt: 0 } }, 'cleanable'),
        safeCount(D, C.GROUP_LIST, { is_delete: 0 }, 'kept'),
        safeCount(D, C.GROUP_LIST, { is_delete: null }, 'pending'),
        safeCount(D, C.USERS, {}, 'users'),
        safeCount(D, C.USERS, { state: 0 }, 'banned'),
        safeCount(D, C.USERS, { white: 1 }, 'whitelist'),
        safeCount(D, C.TAGS, {}, 'tags'),
        safeCount(D, C.CHANNEL_GROUP, {}, 'chats'),
        safeCount(D, C.CHANNEL_GROUP, { type: 'channel' }, 'channels'),
        safeCount(D, C.CHANNEL_GROUP, { type: 'group' }, 'groups'),
        safeCount(D, C.CHANNEL_GROUP, { is_bound: true }, 'bound'),
        safeCount(D, C.LOG, {}, 'logs'),
        safeCount(D, C.MEDIA, { media_type: 'photo' }, 'photo'),
        safeCount(D, C.MEDIA, { media_type: 'video' }, 'video'),
        safeCount(D, C.MEDIA, { media_type: 'audio' }, 'audio'),
        safeCount(D, C.MEDIA, { media_type: 'document' }, 'document')
    ]);

    // 最近日志（仅取少量字段；新版含 action/category/result，便于控制台直接展示语义）
    let recent = [];
    try {
        const docs = await D.getCollection(C.LOG).find({}).sort({ time: -1 }).limit(RECENT_LOG_LIMIT).toArray();
        recent = docs.map(doc => ({
            _id: String(doc._id),
            type: doc.type,
            action: doc.action || (ACTION_BY_TYPE[doc.type] || null),
            actionLabel: doc.actionLabel || actionLabel(doc.action || ACTION_BY_TYPE[doc.type]) || legacyTypeLabel(doc.type) || null,
            category: doc.category || null,
            result: doc.result || 'ok',
            source: doc.source || null,
            counts: doc.counts || null,
            time: doc.time,
            userId: doc.userId ?? null,
            query: (doc.detail && doc.detail.query) || doc.query || null
        }));
    } catch (err) {
        logger.error(`WebUI 概览最近日志读取失败: ${err.message}`);
    }

    // 最新媒体组（仅取 3 个字段）
    let latestGroupList = [];
    try {
        const docs = await D.getCollection(C.GROUP_LIST).find({}).sort({ _id: -1 }).limit(LATEST_GROUP_LIMIT).toArray();
        latestGroupList = docs.map(doc => ({
            group_id: doc.group_id,
            is_group: doc.is_group ?? 0,
            is_delete: doc.is_delete ?? null
        }));
    } catch (err) {
        logger.error(`WebUI 概览最新媒体组读取失败: ${err.message}`);
    }

    return {
        status: 200,
        data: {
            counts: {
                media, message, groupList, cleanable, kept, pending,
                users, banned, whitelist, tags, chats, channels, groups, bound, logs
            },
            mediaByType: { photo, video, audio, document: documentMedia },
            recent,
            latestGroupList,
            serverTime: Date.now()
        }
    };
}

/**
 * 媒体组列表：GET /api/media?scope=all|cleanable|kept&q=&page=1&pageSize=24
 * 说明：不使用 aggregate（测试注入的假集合不支持），改为分批 find 后在 JS 中归组
 */
async function handleMediaList(D, url) {
    const scope = url.searchParams.get('scope') || 'all';
    const q = (url.searchParams.get('q') || '').trim();
    const tag = normalizeTagName(url.searchParams.get('tag') || '');
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize'), 10) || 24));

    let groupFilter;
    if (scope === 'cleanable') groupFilter = { is_delete: { $gt: 0 } };
    else if (scope === 'kept') groupFilter = { is_delete: 0 };
    else if (scope === 'all') groupFilter = {};
    else return { status: 400, data: { error: `不支持的 scope: ${scope}` } };

    // 关键词搜索：先在 message 中匹配文本，得到候选 group_id 集合
    if (q) {
        const docs = await D.getCollection(COLLECTIONS.MESSAGE)
            .find({ text: { $regex: escapeRegex(q), $options: 'i' } })
            .limit(5000)
            .toArray();
        const ids = [...new Set(docs.map(doc => doc.group_id).filter(id => id !== undefined && id !== null))];
        if (ids.length === 0) {
            return { status: 200, data: { total: 0, page, pageSize, items: [] } };
        }
        groupFilter = { ...groupFilter, group_id: { $in: ids } };
    }

    // 标签筛选：组内任意一条 message 带该标签即命中（标签按 message 独立存储）
    if (tag) {
        const docs = await D.getCollection(COLLECTIONS.MESSAGE).find({ tags: tag }).limit(5000).toArray();
        const ids = [...new Set(docs.map(doc => doc.group_id).filter(id => id !== undefined && id !== null))];
        if (ids.length === 0) {
            return { status: 200, data: { total: 0, page, pageSize, items: [] } };
        }
        const existing = groupFilter.group_id && groupFilter.group_id.$in;
        const finalIds = existing ? ids.filter(id => existing.includes(id)) : ids;
        groupFilter = { ...groupFilter, group_id: { $in: finalIds } };
    }

    const groupCol = D.getCollection(COLLECTIONS.GROUP_LIST);
    const total = await groupCol.countDocuments(groupFilter);
    const groupDocs = await groupCol.find(groupFilter)
        .sort({ _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();

    const groupIds = groupDocs.map(doc => doc.group_id);
    let mediaDocs = [];
    let messageDocs = [];
    if (groupIds.length > 0) {
        [mediaDocs, messageDocs] = await Promise.all([
            D.getCollection(COLLECTIONS.MEDIA).find({ group_id: { $in: groupIds } }).limit(3000).toArray(),
            D.getCollection(COLLECTIONS.MESSAGE)
                .find({ group_id: { $in: groupIds }, text: { $exists: true, $ne: '' } })
                .limit(3000)
                .toArray()
        ]);
    }

    // 按 group_id 归组（JS 侧完成，避免 aggregate）
    const mediaByGroup = new Map();
    for (const doc of mediaDocs) {
        if (!mediaByGroup.has(doc.group_id)) mediaByGroup.set(doc.group_id, []);
        mediaByGroup.get(doc.group_id).push(doc);
    }
    const messageByGroup = new Map();
    for (const doc of messageDocs) {
        if (!messageByGroup.has(doc.group_id)) messageByGroup.set(doc.group_id, []);
        messageByGroup.get(doc.group_id).push(doc);
    }

    const items = groupDocs.map(group => {
        const list = mediaByGroup.get(group.group_id) || [];
        const msg = pickLatestMessage(messageByGroup.get(group.group_id) || []);
        const preview = pickPreviewMedia(list);
        const updatedAt = msg && (msg.updated_at || 0) > 0 ? msg.updated_at : null;
        return {
            group_id: group.group_id,
            is_group: group.is_group ?? 0,
            is_delete: group.is_delete ?? null,
            cleanable: (group.is_delete || 0) > 0,
            mark: group.mark || 0,
            mediaCount: list.length > 0 ? list.length : (group.is_group || 0),
            subgroups: new Set(list.map(m => m.subgroup)).size,
            types: MEDIA_TYPE_ORDER.filter(t => list.some(m => m.media_type === t)),
            preview: preview ? {
                file_unique_id: preview.file_unique_id ?? null,
                media_type: preview.media_type ?? null,
                thumbable: !!(preview.media_type === 'photo' || preview.thumb_file_id)
            } : null,
            text: msg ? (msg.text || '') : '',
            tags: msg && Array.isArray(msg.tags) ? msg.tags : [],
            group: preview ? (preview.group ?? null) : null,
            channel: preview ? (preview.channel ?? null) : null,
            updatedAt
        };
    });

    return { status: 200, data: { total, page, pageSize, items } };
}

/**
 * 媒体组详情：GET /api/media/detail?groupId=xxx
 */
async function handleMediaDetail(D, url) {
    const groupId = url.searchParams.get('groupId');
    if (!groupId) return { status: 400, data: { error: '缺少 groupId' } };

    const groupCol = D.getCollection(COLLECTIONS.GROUP_LIST);
    const mediaCol = D.getCollection(COLLECTIONS.MEDIA);
    const [groupDoc, mediaDocsRaw] = await Promise.all([
        groupCol.findOne({ group_id: groupId }),
        // 只按 subgroup 取（位置消息 ID 在 group / channel 子文档里，取回后在内存里按位置排）
        mediaCol.find({ group_id: groupId }).sort({ subgroup: 1 }).limit(500).toArray()
    ]);
    const mediaDocs = sortMediaDocsByPosition(mediaDocsRaw);
    if (!groupDoc && mediaDocs.length === 0) {
        return { status: 404, data: { error: '未找到该媒体组' } };
    }

    const messageDocs = await D.getCollection(COLLECTIONS.MESSAGE)
        .find({ group_id: groupId })
        .sort({ updated_at: -1, message_id: -1 })
        .limit(200)
        .toArray();

    return {
        status: 200,
        data: {
            group: {
                group_id: groupDoc ? groupDoc.group_id : groupId,
                is_group: groupDoc ? (groupDoc.is_group ?? 0) : mediaDocs.length,
                is_delete: groupDoc ? (groupDoc.is_delete ?? null) : null,
                cleanable: !!(groupDoc && (groupDoc.is_delete || 0) > 0),
                mark: groupDoc ? (groupDoc.mark || 0) : 0,
                last_mark_time: groupDoc && groupDoc.last_mark_time !== undefined ? groupDoc.last_mark_time : null
            },
            media: mediaDocs.map(doc => ({
                _id: String(doc._id),
                subgroup: doc.subgroup ?? null,
                media_type: doc.media_type ?? null,
                file_unique_id: doc.file_unique_id ?? null,
                file_id: doc.file_id ?? null,
                // 位置消息 ID：解析 group / channel 子文档（旧数据兜底顶层 message_id）
                message_id: mediaPositionMessageId(doc) || null,
                video_time: doc.video_time ?? null,
                group: doc.group ?? null,
                channel: doc.channel ?? null,
                thumbable: !!(doc.media_type === 'photo' || doc.thumb_file_id)
            })),
            messages: messageDocs.map(doc => ({
                _id: String(doc._id),
                file_unique_id: doc.file_unique_id ?? null,
                text: doc.text ?? '',
                tags: Array.isArray(doc.tags) ? doc.tags : [],
                chat_id: doc.chat_id ?? null,
                message_id: doc.message_id ?? null,
                updated_at: doc.updated_at ?? null
            }))
        }
    };
}

/**
 * 清理空数据：POST /api/clean { scope, confirm }
 * 未带 confirm: true 时只预览（返回将要清理的组数与媒体数，不删除）
 */
/** 随机推荐的时长档位（与机器人 /random_videos 的 TIME_FILTERS 一致） */
const RANDOM_DURATION_FILTERS = {
    all: null,
    '<1min': { $lt: 60 },
    '<3min': { $lt: 180 },
    '1-5min': { $gte: 60, $lte: 300 },
    '5-30min': { $gte: 300, $lte: 1800 },
    '>30min': { $gt: 1800 },
    '>1h': { $gt: 3600 }
};

/** 从 total 个位置里随机取 want 个不重复下标（碰撞过多时按顺序补齐） */
function pickRandomOffsets(total, want) {
    const n = Math.min(want, total);
    const picked = new Set();
    let guard = 0;
    while (picked.size < n && guard++ < n * 50) picked.add(Math.floor(Math.random() * total));
    for (let i = 0; picked.size < n && i < total; i++) picked.add(i);
    return [...picked];
}

/**
 * 随机推荐：GET /api/random
 *   比机器人上的两个随机更自由：类型 / 标签（任一·全部）/ 关键词 / 视频时长 / 范围 / 数量 都能组合
 *   - types=photo,video,audio,document（不传 = 全部类型）
 *   - tags=A,B & tagMode=any|all
 *   - q=关键词（匹配描述）
 *   - duration=all|<1min|<3min|1-5min|5-30min|>30min|>1h（只对视频有 video_time 的生效）
 *   - scope=all|kept|cleanable（按 group_list.is_delete 判定是否有描述）
 *   - count=1..100（默认 20）
 */
async function handleRandom(D, url) {
    const p = (k) => (url.searchParams.get(k) || '').trim();
    const types = p('types').split(',').map(s => s.trim().toLowerCase()).filter(t => MEDIA_TYPE_ORDER.includes(t));
    const tags = p('tags').split(',').map(s => normalizeTagName(s)).filter(Boolean);
    const tagMode = p('tagMode') === 'all' ? 'all' : 'any';
    const keyword = p('q');
    const duration = Object.prototype.hasOwnProperty.call(RANDOM_DURATION_FILTERS, p('duration')) ? p('duration') : 'all';
    const scope = ['kept', 'cleanable'].includes(p('scope')) ? p('scope') : 'all';
    const count = Math.min(100, Math.max(1, parseInt(p('count'), 10) || 20));
    const filters = { types, tags, tagMode, q: keyword, duration, scope, count };
    const empty = { status: 200, data: { total: 0, count: 0, items: [], filters } };

    const filter = {};
    if (types.length) filter.media_type = { $in: types };
    if (RANDOM_DURATION_FILTERS[duration]) filter.video_time = RANDOM_DURATION_FILTERS[duration];

    // 标签 / 关键词：先在 message 里筛出候选媒体（标签按 message 独立存储）
    if (tags.length || keyword) {
        const mFilter = {};
        // 标签是数组字段：用 $or / $and 逐标签匹配（Mongo 与测试内存集合语义一致）
        if (tags.length) mFilter[tagMode === 'all' ? '$and' : '$or'] = tags.map(t => ({ tags: t }));
        if (keyword) mFilter.text = { $regex: escapeRegex(keyword), $options: 'i' };
        const msgs = await D.getCollection(COLLECTIONS.MESSAGE).find(mFilter).limit(5000).toArray();
        const ids = [...new Set(msgs.map(m => m.file_unique_id).filter(Boolean))];
        if (!ids.length) return empty;
        filter.file_unique_id = { $in: ids };
    }

    // 范围（有没有描述）按 group_list.is_delete 判定
    if (scope !== 'all') {
        const gl = await D.getCollection(COLLECTIONS.GROUP_LIST)
            .find(scope === 'cleanable' ? { is_delete: { $gt: 0 } } : { is_delete: 0 })
            .limit(5000)
            .toArray();
        const ids = [...new Set(gl.map(g => g.group_id).filter(Boolean))];
        if (!ids.length) return empty;
        filter.group_id = { $in: ids };
    }

    const mediaCol = D.getCollection(COLLECTIONS.MEDIA);
    const total = await mediaCol.countDocuments(filter);
    const docs = [];
    for (const offset of pickRandomOffsets(total, count)) {
        const hit = await mediaCol.find(filter).sort({ _id: 1 }).skip(offset).limit(1).toArray();
        if (hit[0]) docs.push(hit[0]);
    }
    if (!docs.length) return { status: 200, data: { total, count: 0, items: [], filters } };

    const fileIds = [...new Set(docs.map(d => d.file_unique_id).filter(Boolean))];
    const groupIds = [...new Set(docs.map(d => d.group_id).filter(Boolean))];
    const [msgs, groups] = await Promise.all([
        fileIds.length ? D.getCollection(COLLECTIONS.MESSAGE).find({ file_unique_id: { $in: fileIds } }).toArray() : [],
        groupIds.length ? D.getCollection(COLLECTIONS.GROUP_LIST).find({ group_id: { $in: groupIds } }).toArray() : []
    ]);
    const msgByFile = new Map(msgs.map(m => [m.file_unique_id, m]));
    const groupById = new Map(groups.map(g => [g.group_id, g]));

    return {
        status: 200,
        data: {
            total,
            count: docs.length,
            filters,
            items: docs.map(doc => {
                const msg = msgByFile.get(doc.file_unique_id) || null;
                const g = groupById.get(doc.group_id) || null;
                const pos = resolveMediaPosition(doc);
                return {
                    group_id: doc.group_id,
                    file_unique_id: doc.file_unique_id,
                    media_type: doc.media_type ?? null,
                    subgroup: doc.subgroup ?? null,
                    video_time: doc.video_time ?? null,
                    thumbable: !!(doc.media_type === 'photo' || doc.thumb_file_id),
                    text: msg ? (msg.text || '') : '',
                    tags: msg && Array.isArray(msg.tags) ? msg.tags : [],
                    chat_id: pos ? pos.chatId : null,
                    message_id: pos ? pos.messageId : null,
                    group: doc.group ?? null,
                    channel: doc.channel ?? null,
                    cleanable: !!(g && (g.is_delete || 0) > 0),
                    mark: g ? (g.mark || 0) : 0
                };
            })
        }
    };
}

async function handleClean(D, url, body) {
    const scope = body.scope;
    const now = Date.now();
    const DAY = 24 * 3600 * 1000;
    let timeCondition;
    if (scope === 'week') timeCondition = { $gt: 0, $lte: now - 7 * DAY };
    else if (scope === 'month') timeCondition = { $gt: 0, $lte: now - 30 * DAY };
    else if (scope === 'all') timeCondition = { $gt: 0 };
    else return { status: 400, data: { error: `不支持的 scope: ${scope}` } };

    const groupCol = D.getCollection(COLLECTIONS.GROUP_LIST);
    const mediaCol = D.getCollection(COLLECTIONS.MEDIA);
    const groupDocs = await groupCol.find({ is_delete: timeCondition }).limit(5000).toArray();
    const ids = groupDocs.map(doc => doc.group_id);
    const groups = groupDocs.length;
    const media = ids.length > 0 ? await mediaCol.countDocuments({ group_id: { $in: ids } }) : 0;

    let deleted = false;
    if (body.confirm === true) {
        if (ids.length > 0) {
            await mediaCol.deleteMany({ group_id: { $in: ids } });
            await groupCol.deleteMany({ group_id: { $in: ids } });
        }
        deleted = true;
    }

    logger.info(`WebUI 清理空数据: scope=${scope}, 组=${groups}, 媒体=${media}, 已删除=${deleted}`);
    logOperation({
        action: 'media_clean_execute',
        source: 'webui',
        result: 'ok',
        counts: { groups, media },
        detail: { scope, deleted, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { scope, groups, media, deleted } };
}

/**
 * 标签列表：GET /api/tags
 * usage = 引用该标签的 message 文档数（单次 find + JS 计数，避免 aggregate）
 */
async function handleTags(D) {
    const docs = await D.getCollection(COLLECTIONS.TAGS).find({}).toArray();
    const tags = sortTags(docs.map(doc => ({
        name: String(doc.name || ''),
        pin: doc.pin,
        count: doc.count || 0
    })));

    const usageMap = new Map();
    try {
        const messageDocs = await D.getCollection(COLLECTIONS.MESSAGE)
            .find({ tags: { $exists: true, $ne: [] } })
            .limit(5000)
            .toArray();
        for (const doc of messageDocs) {
            if (!Array.isArray(doc.tags)) continue;
            for (const name of doc.tags) {
                const key = String(name).toUpperCase();
                usageMap.set(key, (usageMap.get(key) || 0) + 1);
            }
        }
    } catch (err) {
        logger.error(`WebUI 标签使用量统计失败: ${err.message}`);
    }

    return {
        status: 200,
        data: {
            tags: tags.map(t => ({ name: t.name, pin: t.pin, count: t.count, usage: usageMap.get(t.name) || 0 })),
            total: tags.length
        }
    };
}

/**
 * 用户列表：GET /api/users?scope=all|white|banned&q=&page=1&pageSize=20
 */
async function handleUsers(D, url) {
    const scope = url.searchParams.get('scope') || 'all';
    const q = (url.searchParams.get('q') || '').trim();
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize'), 10) || 20));

    let filter = {};
    if (scope === 'white') filter = { white: 1 };
    else if (scope === 'banned') filter = { state: 0 };

    if (q) {
        const or = [{ name: { $regex: escapeRegex(q), $options: 'i' } }];
        // 纯数字时才按用户 ID 精确匹配
        if (/^-?\d+$/.test(q)) or.push({ id: Number(q) });
        filter = { ...filter, $or: or };
    }

    const col = D.getCollection(COLLECTIONS.USERS);
    const total = await col.countDocuments(filter);
    const docs = await col.find(filter)
        .sort({ last_seen: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();

    return {
        status: 200,
        data: {
            total,
            page,
            pageSize,
            items: docs.map(doc => ({
                id: doc.id ?? null,
                name: doc.name ?? '',
                state: doc.state ?? 1,
                white: doc.white ?? 0,
                groups: Array.isArray(doc.group) ? doc.group.length : 0,
                last_seen: doc.last_seen ?? null,
                join_time: doc.join_time ?? null
            }))
        }
    };
}

/**
 * 聊天管理列表：GET /api/groups
 */
async function handleGroups(D) {
    const docs = await D.getCollection(COLLECTIONS.CHANNEL_GROUP).find({}).sort({ id: 1 }).toArray();
    const nameById = new Map(docs.map(doc => [doc.id, doc.name]));
    return {
        status: 200,
        data: {
            items: docs.map(doc => {
                const bindId = doc.bind_id ?? null;
                return {
                    id: doc.id,
                    name: doc.name ?? '',
                    type: doc.type ?? null,
                    bind_id: bindId,
                    is_bound: !!doc.is_bound,
                    bindName: bindId !== null && nameById.has(bindId) ? nameById.get(bindId) : null
                };
            })
        }
    };
}

// ---------------- 控制台写操作（媒体描述/标签、用户、聊天、日志报表） ----------------

/** 数字校验：返回合法数字或 null（null/空串明确视为「未设置」，不能变成 0） */
function toNumberId(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** 标签名规范化：去空白、大写、长度校验 */
function normalizeTagName(v) {
    const name = String(v === undefined || v === null ? '' : v).trim().toUpperCase();
    if (!name) return null;
    if (name.length > 20) return null;
    return name;
}

/**
 * 控制台改媒体描述：POST /api/media/description
 * body: { fileUniqueId, text, editTelegram?: boolean }
 * 顺序：先落库（描述/标签/is_delete），再尝试改 Telegram caption（失败只回报，不回滚数据库）
 */
async function handleMediaDescription(D, url, body) {
    const fileUniqueId = typeof body.fileUniqueId === 'string' ? body.fileUniqueId.trim() : '';
    if (!fileUniqueId) return { status: 400, data: { error: '缺少 fileUniqueId' } };
    if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') {
        return { status: 400, data: { error: 'text 必须是字符串' } };
    }

    const mediaDoc = await D.getCollection(COLLECTIONS.MEDIA).findOne({ file_unique_id: fileUniqueId });
    if (!mediaDoc) return { status: 404, data: { error: '未找到该媒体' } };

    const rawText = typeof body.text === 'string' ? body.text : '';
    const isClearing = !rawText.trim();
    const cleanText = isClearing ? '' : removeLevelSuffix(rawText);
    const targetGroupId = mediaDoc.group_id || null;
    // 编辑目标位置：频道源位置优先（频道 → 讨论群自动转发时改频道源消息，Telegram 自动同步到群里的副本），
    // 其次群组位置；改不了的会在调用 Telegram 时自动降级到下一个位置
    const editTargets = resolveEditTargets(mediaDoc);
    const primary = editTargets[0] || null;
    const targetChatId = primary ? primary.chatId : null;
    const targetMessageId = primary ? primary.messageId : (mediaPositionMessageId(mediaDoc) || null);

    const messageCol = D.getCollection(COLLECTIONS.MESSAGE);
    const before = await messageCol.findOne({ file_unique_id: fileUniqueId });

    // 1) 清空描述 = 移除该 message 的标签：必须先清标签（此刻记录还在，才能递减标签使用次数）
    if (isClearing && typeof clearMessageTags === 'function') {
        await clearMessageTags(fileUniqueId);
    }

    // 2) 数据库：message 记录增/改/删 + group_list.is_delete 重算（复用机器人编辑逻辑）
    await updateMessageDb(messageCol, {
        isClearing,
        targetChatId,
        targetMessageId,
        targetGroupId,
        targetFileUniqueId: fileUniqueId,
        targetMediaType: mediaDoc.media_type,
        cleanText
    });

    // 3) 标签：编辑描述**保留已有标签**，只补充新文本匹配到的（清空描述已在上一步清掉）
    if (!isClearing) {
        await reMatchMessageTags(fileUniqueId, cleanText);
    }

    // 4) 尝试同步 Telegram 描述（超 48 小时 / 消息不是机器人发送的会失败，但数据库已更新）
    let telegramEdited = false;
    let telegramError = null;
    let telegramVia = null;
    const wantTelegram = body.editTelegram !== false;
    if (wantTelegram && editTargets.length) {
        try {
            const edited = await editCaptionWithFallback(editTargets, (t) =>
                D.editCaption(t.chatId, t.messageId, isClearing ? null : cleanText)
            );
            telegramEdited = true;
            telegramVia = edited.via;
        } catch (err) {
            telegramError = err.message || '修改 Telegram 描述失败';
            logger.warn(`WebUI 修改 Telegram 描述失败 [${targetChatId}/${targetMessageId}]: ${telegramError}`);
        }
    }

    const tags = await getMessageTags(fileUniqueId);
    logOperation({
        action: 'media_edit',
        source: 'webui',
        target: { type: 'media', id: fileUniqueId },
        counts: { edits: 1 },
        detail: {
            via: 'webui',
            groupId: targetGroupId,
            mediaType: mediaDoc.media_type,
            before: before ? before.text : undefined,
            after: cleanText || undefined,
            clearing: isClearing,
            telegramEdited,
            telegramEditVia: telegramVia || undefined,
            over48h: !telegramEdited && wantTelegram ? true : undefined
        }
    }).catch(() => { });

    return { status: 200, data: { ok: true, text: isClearing ? '' : cleanText, clearing: isClearing, telegramEdited, telegramEditVia: telegramVia, telegramError, tags } };
}

/**
 * 控制台改标签：POST /api/media/tags
 * body: { fileUniqueId?, groupId?, add?: string[], remove?: string[] }
 * 同时维护 tags 集合（不存在则创建）与使用次数，语义与机器人 /tag 一致
 */
async function handleMediaTags(D, url, body) {
    const fileUniqueId = typeof body.fileUniqueId === 'string' ? body.fileUniqueId.trim() : '';
    const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';
    if (!fileUniqueId && !groupId) return { status: 400, data: { error: '需要 fileUniqueId 或 groupId' } };

    const rawAdd = Array.isArray(body.add) ? body.add : [];
    const rawRemove = Array.isArray(body.remove) ? body.remove : [];
    if (rawAdd.length === 0 && rawRemove.length === 0) {
        return { status: 400, data: { error: 'add / remove 至少提供一个标签' } };
    }
    const add = [...new Set(rawAdd.map(normalizeTagName))].filter(Boolean);
    const remove = [...new Set(rawRemove.map(normalizeTagName))].filter(Boolean);
    if (add.length === 0 && remove.length === 0) {
        return { status: 400, data: { error: '标签名无效（1-20 个字符）' } };
    }

    const createdTags = [];
    let affected = 0;

    if (fileUniqueId) {
        for (const name of add) {
            const res = await addTag(name);
            if (res && res.ok) createdTags.push(name);
            const modified = await addTagToMessage(fileUniqueId, name);
            if (modified > 0) await tagUsed(name, 1);
            affected += modified;
        }
        for (const name of remove) {
            const modified = await removeTagFromMessage(fileUniqueId, name);
            if (modified > 0) await tagUsed(name, -1);
            affected += modified;
        }
    } else {
        for (const name of add) {
            const res = await addTag(name);
            if (res && res.ok) createdTags.push(name);
            const modified = await addTagToGroup(groupId, name);
            if (modified > 0) await tagUsed(name, modified);
            affected += modified;
        }
        for (const name of remove) {
            const modified = await removeTagFromGroup(groupId, name);
            if (modified > 0) await tagUsed(name, -modified);
            affected += modified;
        }
    }

    const tags = fileUniqueId ? await getMessageTags(fileUniqueId) : await getGroupTags(groupId);
    const targetId = fileUniqueId || groupId;
    if (add.length > 0) {
        logOperation({
            action: 'tag_add',
            source: 'webui',
            target: { type: fileUniqueId ? 'media' : 'media_group', id: targetId },
            counts: { tags: add.length, messages: affected || undefined },
            detail: { tags: add, createdTags: createdTags.length ? createdTags : undefined, via: 'webui' }
        }).catch(() => { });
    }
    if (remove.length > 0) {
        logOperation({
            action: 'tag_remove',
            source: 'webui',
            target: { type: fileUniqueId ? 'media' : 'media_group', id: targetId },
            counts: { tags: remove.length, messages: affected || undefined },
            detail: { tags: remove, via: 'webui' }
        }).catch(() => { });
    }

    return { status: 200, data: { ok: true, tags, added: add, removed: remove, createdTags, affectedMessages: affected } };
}

/** 用户新增：POST /api/users/create */
async function handleUserCreate(D, url, body) {
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    const name = typeof body.name === 'string' ? body.name.slice(0, 64) : `User ${id}`;
    const state = body.state === 0 ? 0 : 1;
    const white = body.white === 1 ? 1 : 0;
    const group = Array.isArray(body.group) ? body.group.map(toNumberId).filter(v => v !== null) : [];

    const col = D.getCollection(COLLECTIONS.USERS);
    if (await col.findOne({ id })) return { status: 409, data: { error: `用户 ${id} 已存在` } };

    const now = Date.now();
    await col.insertOne({ id, name, state, white, group, last_seen: body.last_seen || now, join_time: body.join_time || now });
    logOperation({
        action: 'user_create',
        source: 'webui',
        target: { type: 'user', id },
        counts: { users: 1 },
        detail: { name, state, white, groups: group.length, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id } };
}

/** 用户修改：POST /api/users/update */
async function handleUserUpdate(D, url, body) {
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    const patch = isPlainObject(body.patch) ? body.patch : {};
    const update = {};
    if (typeof patch.name === 'string') update.name = patch.name.slice(0, 64);
    if (patch.state !== undefined) update.state = patch.state === 0 ? 0 : 1;
    if (patch.white !== undefined) update.white = patch.white === 1 ? 1 : 0;
    if (Array.isArray(patch.group)) update.group = patch.group.map(toNumberId).filter(v => v !== null);
    if (Object.keys(update).length === 0) return { status: 400, data: { error: '没有可修改的字段（name/state/white/group）' } };

    const col = D.getCollection(COLLECTIONS.USERS);
    const before = await col.findOne({ id });
    if (!before) return { status: 404, data: { error: `未找到用户 ${id}` } };
    const beforeSnapshot = { name: before.name, state: before.state, white: before.white };
    await col.updateOne({ id }, { $set: update });
    logOperation({
        action: 'user_update',
        source: 'webui',
        target: { type: 'user', id },
        counts: { users: 1 },
        detail: {
            via: 'webui',
            fields: Object.keys(update),
            before: beforeSnapshot,
            after: { state: update.state, white: update.white, name: update.name }
        }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id, patch: update } };
}

/** 用户删除：POST /api/users/delete */
async function handleUserDelete(D, url, body) {
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    if (body.confirm !== true) return { status: 400, data: { error: '删除用户需要二次确认（confirm: true）' } };
    const before = await D.getCollection(COLLECTIONS.USERS).findOne({ id });
    const result = await D.getCollection(COLLECTIONS.USERS).deleteOne({ id });
    if (result.deletedCount === 0) return { status: 404, data: { error: `未找到用户 ${id}` } };
    logOperation({
        action: 'user_delete',
        source: 'webui',
        target: { type: 'user', id },
        counts: { users: 1 },
        detail: { via: 'webui', name: before ? before.name : undefined, state: before ? before.state : undefined, white: before ? before.white : undefined }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id } };
}

/** 聊天（群组/频道）新增：POST /api/groups/create */
async function handleChatCreate(D, url, body) {
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    const type = body.type === 'channel' ? 'channel' : (body.type === 'group' ? 'group' : null);
    if (!type) return { status: 400, data: { error: 'type 必须是 channel 或 group' } };
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.slice(0, 64) : `Chat${id}`;
    const bindId = toNumberId(body.bind_id);

    const col = D.getCollection(COLLECTIONS.CHANNEL_GROUP);
    if (await col.findOne({ id })) return { status: 409, data: { error: `聊天 ${id} 已存在` } };

    await col.insertOne({ id, name, type, bind_id: bindId, is_bound: bindId !== null });
    if (bindId !== null) await syncChatBinding(D, id, bindId);
    logOperation({
        action: 'chat_create',
        source: 'webui',
        target: { type: 'chat', id },
        counts: { chats: 1 },
        detail: { name, chatType: type, bindId: bindId ?? undefined, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id } };
}

/**
 * 双向绑定：把 A.bind_id 设为 B，同时把 B.bind_id 设为 A（互相指向）
 * 对端不存在时只写 A，避免产生悬空引用。
 */
async function syncChatBinding(D, id, bindId) {
    const col = D.getCollection(COLLECTIONS.CHANNEL_GROUP);
    const counterpart = await col.findOne({ id: bindId });
    if (!counterpart) return false;
    await col.updateOne({ id: bindId }, { $set: { bind_id: id, is_bound: true } });
    return true;
}

/** 聊天修改：POST /api/groups/update */
async function handleChatUpdate(D, url, body) {
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    const patch = isPlainObject(body.patch) ? body.patch : {};
    const update = {};
    if (typeof patch.name === 'string') update.name = patch.name.slice(0, 64);
    if (patch.type !== undefined) {
        if (patch.type !== 'channel' && patch.type !== 'group') return { status: 400, data: { error: 'type 必须是 channel 或 group' } };
        update.type = patch.type;
    }
    let bindId;
    let bindChanged = false;
    if (patch.bind_id !== undefined) {
        bindId = toNumberId(patch.bind_id);
        update.bind_id = bindId;
        update.is_bound = bindId !== null;
        bindChanged = true;
    }
    if (Object.keys(update).length === 0) return { status: 400, data: { error: '没有可修改的字段（name/type/bind_id）' } };

    const col = D.getCollection(COLLECTIONS.CHANNEL_GROUP);
    const before = await col.findOne({ id });
    if (!before) return { status: 404, data: { error: `未找到聊天 ${id}` } };
    // 显式快照：不能依赖 findOne 返回副本（驱动会拷贝，但内存实现可能返回同一对象引用）
    const beforeSnapshot = { name: before.name, type: before.type, bind_id: before.bind_id ?? null };
    const oldBind = beforeSnapshot.bind_id;
    await col.updateOne({ id }, { $set: update });

    if (bindChanged) {
        // 解绑 / 改绑：先清掉旧对端指向自己的绑定，再建立新绑定
        if (oldBind !== null && oldBind !== bindId) {
            await col.updateOne({ id: oldBind, bind_id: id }, { $set: { bind_id: null, is_bound: false } });
        }
        if (bindId !== null) await syncChatBinding(D, id, bindId);
    }

    logOperation({
        action: 'chat_update',
        source: 'webui',
        target: { type: 'chat', id },
        counts: { chats: 1 },
        detail: { via: 'webui', fields: Object.keys(update), before: beforeSnapshot, after: { name: update.name, type: update.type, bind_id: update.bind_id } }
    }).catch(() => { });
    if (bindChanged) {
        logOperation({
            action: bindId === null ? 'chat_unbind' : 'chat_bind',
            source: 'webui',
            target: { type: 'chat', id },
            detail: { via: 'webui', previousBindId: oldBind, newBindId: bindId }
        }).catch(() => { });
    }
    return { status: 200, data: { ok: true, id, patch: update } };
}

/** 聊天删除：POST /api/groups/delete */
async function handleChatDelete(D, url, body) {
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    if (body.confirm !== true) return { status: 400, data: { error: '删除聊天需要二次确认（confirm: true）' } };
    const col = D.getCollection(COLLECTIONS.CHANNEL_GROUP);
    const before = await col.findOne({ id });
    const result = await col.deleteOne({ id });
    if (result.deletedCount === 0) return { status: 404, data: { error: `未找到聊天 ${id}` } };
    if (before && before.bind_id) {
        await col.updateOne({ id: before.bind_id, bind_id: id }, { $set: { bind_id: null, is_bound: false } });
    }
    logOperation({
        action: 'chat_delete',
        source: 'webui',
        target: { type: 'chat', id },
        counts: { chats: 1 },
        detail: { via: 'webui', name: before ? before.name : undefined, chatType: before ? before.type : undefined }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id } };
}

/** 旧编号 ↔ 动作键的辅助映射：某动作（或某大类）对应哪些旧 type */
function legacyTypesForAction(action) {
    return Object.entries(ACTION_BY_TYPE)
        .filter(([, act]) => act === action)
        .map(([type]) => Number(type));
}
function legacyTypesForCategory(category) {
    return getCatalog().actions.filter(a => a.category === category).map(a => a.type);
}

/** 操作日志列表（按时间倒序，支持筛选）：GET /api/oplogs */
async function handleOpLogs(D, url) {
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize'), 10) || 30));
    const category = (url.searchParams.get('category') || '').trim();
    const action = (url.searchParams.get('action') || '').trim();
    const result = (url.searchParams.get('result') || '').trim();
    const userIdRaw = (url.searchParams.get('userId') || '').trim();
    const q = (url.searchParams.get('q') || '').trim();
    const from = parseInt(url.searchParams.get('from'), 10);
    const to = parseInt(url.searchParams.get('to'), 10);

    const filter = {};
    const and = [];
    if (category && category !== 'all') {
        // 兼容历史数据：没有 category 字段时按 type 归类后匹配
        and.push({ $or: [{ category }, { category: { $exists: false }, type: { $in: legacyTypesForCategory(category) } }] });
    }
    if (action && action !== 'all') {
        and.push({ $or: [{ action }, { action: { $exists: false }, type: { $in: legacyTypesForAction(action) } }] });
    }
    if (result === 'ok' || result === 'fail') filter.result = result;
    if (userIdRaw) {
        const uid = toNumberId(userIdRaw);
        if (uid !== null) filter.userId = uid;
    }
    const range = {};
    if (Number.isFinite(from)) range.$gte = new Date(from);
    if (Number.isFinite(to)) range.$lte = new Date(to);
    if (Object.keys(range).length > 0) {
        // 兼容历史数据（无 date 字段，只有 time）
        and.push({ $or: [{ date: range }, { date: { $exists: false }, time: range }] });
    }
    if (q) {
        and.push({
            $or: [
                { action: { $regex: escapeRegex(q), $options: 'i' } },
                { actionLabel: { $regex: escapeRegex(q), $options: 'i' } },
                { error: { $regex: escapeRegex(q), $options: 'i' } }
            ]
        });
    }
    if (and.length > 0) filter.$and = and;

    const col = D.getCollection(COLLECTIONS.LOG);
    const total = await col.countDocuments(filter);
    const docs = await col.find(filter).sort({ time: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();

    const items = docs.map(doc => {
        const mappedAction = doc.action || (ACTION_BY_TYPE[doc.type] || `legacy_type_${doc.type ?? 'unknown'}`);
        const meta = getCatalog().actions.find(a => a.action === mappedAction);
        return {
            _id: String(doc._id),
            action: mappedAction,
            actionLabel: doc.actionLabel || actionLabel(doc.action || ACTION_BY_TYPE[doc.type]) || legacyTypeLabel(doc.type),
            category: doc.category || (meta ? meta.category : null),
            type: doc.type ?? null,
            result: doc.result || 'ok',
            source: doc.source || null,
            time: doc.time,
            date: doc.date || null,
            userId: doc.userId ?? null,
            chatId: doc.chatId ?? null,
            target: doc.target || null,
            counts: doc.counts || null,
            detail: doc.detail || null,
            error: doc.error || null,
            durationMs: doc.durationMs ?? null
        };
    });

    return { status: 200, data: { total, page, pageSize, items, catalog: getCatalog() } };
}

/** 北京时间某月的起止（UTC 毫秒）：period=month 用 year+month，period=year 用 year */
function periodRange(period, year, month) {
    const OFFSET = 8 * 3600 * 1000;
    if (period === 'year') {
        const from = Date.UTC(year, 0, 1) - OFFSET;
        const to = Date.UTC(year + 1, 0, 1) - OFFSET - 1;
        return { from, to, prevFrom: Date.UTC(year - 1, 0, 1) - OFFSET, prevTo: from - 1, label: `${year} 年` };
    }
    const m = Math.min(12, Math.max(1, month));
    const from = Date.UTC(year, m - 1, 1) - OFFSET;
    const to = Date.UTC(year, m, 1) - OFFSET - 1;
    const prevMonth = m === 1 ? 12 : m - 1;
    const prevYear = m === 1 ? year - 1 : year;
    const prevFrom = Date.UTC(prevYear, prevMonth - 1, 1) - OFFSET;
    return { from, to, prevFrom, prevTo: from - 1, label: `${year} 年 ${m} 月` };
}

/** 拉取时间范围内的日志（兼容无 date 的历史数据），上限保护 */
async function fetchLogsInRange(D, from, to, limit = 20000) {
    const col = D.getCollection(COLLECTIONS.LOG);
    const filter = {
        $or: [
            { date: { $gte: new Date(from), $lte: new Date(to) } },
            { date: { $exists: false }, time: { $gte: from, $lte: to } }
        ]
    };
    const docs = await col.find(filter).sort({ time: -1 }).limit(limit).toArray();
    return docs;
}

/** 把一批日志聚合为报表结构（纯 JS，便于测试与沿用假集合） */
function aggregateLogs(docs) {
    // 动作目录查表（避免在循环里反复构建）
    const actionMap = new Map(getCatalog().actions.map(a => [a.action, a]));
    const totals = { operations: 0 };
    const byDay = new Map();
    const byAction = new Map();
    const byCategory = new Map();
    const byUser = new Map();
    const byHour = new Array(24).fill(0).map((_, hour) => ({ hour, count: 0, media: 0 })); // 北京时间整点
    const failures = { count: 0, byAction: {} };
    const activeDays = new Set();

    const addCounts = (bucket, counts) => {
        if (!counts) return;
        for (const [k, v] of Object.entries(counts)) {
            const num = Number(v);
            if (Number.isFinite(num)) bucket[k] = (bucket[k] || 0) + num;
        }
    };

    for (const doc of docs) {
        const action = doc.action || (ACTION_BY_TYPE[doc.type] || `legacy_type_${doc.type ?? 'unknown'}`);
        const meta = actionMap.get(action);
        const category = doc.category || (meta ? meta.category : 'other');
        const label = doc.actionLabel || (meta ? meta.label : legacyTypeLabel(doc.type));
        const at = doc.date ? new Date(doc.date).getTime() : doc.time;
        const day = new Date(at + 8 * 3600 * 1000).toISOString().slice(0, 10); // 北京时间自然日

        totals.operations += 1;
        activeDays.add(day);
        addCounts(totals, doc.counts);

        if (!byDay.has(day)) byDay.set(day, { day, count: 0, media: 0, groups: 0, actions: {}, categories: {} });
        const dayRow = byDay.get(day);
        dayRow.count += 1;
        dayRow.media += (doc.counts && doc.counts.media) || 0;
        dayRow.groups += (doc.counts && doc.counts.groups) || 0;
        // 每日按动作 / 大类分别计数：供「每日操作量」方格图手动切换查看项（如只看「标记」）
        dayRow.actions[action] = (dayRow.actions[action] || 0) + 1;
        dayRow.categories[category] = (dayRow.categories[category] || 0) + 1;

        // 活跃时间：按北京时间整点归桶（前端画 24 小时分布）
        const hour = new Date(at + 8 * 3600 * 1000).getUTCHours();
        if (hour >= 0 && hour < 24) {
            byHour[hour].count += 1;
            byHour[hour].media += (doc.counts && doc.counts.media) || 0;
        }

        if (!byAction.has(action)) byAction.set(action, { action, label, category, count: 0, media: 0, groups: 0, fail: 0, users: new Set() });
        const row = byAction.get(action);
        row.count += 1;
        row.media += (doc.counts && doc.counts.media) || 0;
        row.groups += (doc.counts && doc.counts.groups) || 0;
        if (doc.result === 'fail') {
            row.fail += 1;
            failures.count += 1;
            failures.byAction[action] = (failures.byAction[action] || 0) + 1;
        }
        if (doc.userId !== undefined && doc.userId !== null) row.users.add(doc.userId);

        if (!byCategory.has(category)) byCategory.set(category, { category, label: categoryLabel(category), count: 0, actions: {} });
        const catRow = byCategory.get(category);
        catRow.count += 1;
        catRow.actions[action] = (catRow.actions[action] || 0) + 1;

        if (doc.userId !== undefined && doc.userId !== null) {
            byUser.set(doc.userId, (byUser.get(doc.userId) || 0) + 1);
        }
    }

    return {
        totals: { ...totals, activeDays: activeDays.size, avgPerDay: activeDays.size ? Math.round((totals.operations / activeDays.size) * 10) / 10 : 0 },
        byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
        byHour,
        byAction: [...byAction.values()]
            .map(r => ({ ...r, users: r.users.size }))
            .sort((a, b) => b.count - a.count),
        byCategory: [...byCategory.values()].sort((a, b) => b.count - a.count),
        topUsers: [...byUser.entries()].map(([userId, count]) => ({ userId, count })).sort((a, b) => b.count - a.count).slice(0, 15),
        failures
    };
}

/**
 * 统计报表：GET /api/stats?period=month|year&year=2026&month=8
 * 返回本期/上期汇总 + 每日趋势 + 按动作/大类/用户分布，供月表与年终统计使用
 */
async function handleStats(D, url) {
    const period = url.searchParams.get('period') === 'year' ? 'year' : 'month';
    const now = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
    const year = parseInt(url.searchParams.get('year'), 10) || now.getUTCFullYear();
    const month = parseInt(url.searchParams.get('month'), 10) || (now.getUTCMonth() + 1);
    if (year < 2000 || year > 2100) return { status: 400, data: { error: 'year 超出范围' } };

    const { from, to, prevFrom, prevTo, label } = periodRange(period, year, month);
    const [docs, prevDocs] = await Promise.all([
        fetchLogsInRange(D, from, to),
        fetchLogsInRange(D, prevFrom, prevTo)
    ]);
    const report = aggregateLogs(docs);
    const prev = aggregateLogs(prevDocs);

    const delta = (cur, before) => (before > 0 ? Math.round(((cur - before) / before) * 1000) / 10 : null);

    return {
        status: 200,
        data: {
            period,
            year,
            month: period === 'month' ? month : null,
            label,
            from,
            to,
            scanned: docs.length,
            truncated: docs.length >= 20000,
            ...report,
            previous: {
                label: periodRange(period, period === 'month' && month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1).label,
                totals: prev.totals,
                operationsDelta: delta(report.totals.operations, prev.totals.operations),
                mediaDelta: delta(report.totals.media || 0, prev.totals.media || 0)
            },
            catalog: { categories: CATEGORIES, actions: getCatalog().actions }
        }
    };
}

// ---------------- Telegram 缩略图代理 ----------------

/**
 * 修改 Telegram 媒体描述（控制台改描述用）
 * 文本含 HTML 特殊字符导致解析失败时降级为纯文本编辑；空文本表示清空描述。
 * @param {number} chatId
 * @param {number} messageId
 * @param {string|null} text - null/'' 表示清空
 * @returns {Promise<boolean>} 成功返回 true，失败抛错（调用方回报给前端，不回滚数据库）
 */
async function editCaption(chatId, messageId, text) {
    const bot = require('../bot');
    const clearing = text === null || text === undefined || text === '';
    if (clearing) {
        await bot.editMessageCaption('', { chat_id: chatId, message_id: messageId });
        return true;
    }
    try {
        await bot.editMessageCaption(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    } catch (err) {
        // HTML 解析失败：降级为纯文本，保证任何字符的描述都能写入
        if (String(err && err.message || '').toLowerCase().includes('parse')) {
            await bot.editMessageCaption(text, { chat_id: chatId, message_id: messageId });
        } else {
            throw err;
        }
    }
    return true;
}

/**
 * 通过 Telegram Bot API 换取文件下载地址
 * @param {string} fileId - Telegram file_id
 * @returns {Promise<string>} 文件下载 URL
 */
async function telegramGetFile(fileId) {
    const token = config.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('未配置 TELEGRAM_BOT_TOKEN，无法获取 Telegram 文件');

    const apiUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT);
    try {
        const res = await fetch(apiUrl, { signal: controller.signal });
        if (!res.ok) throw new Error(`Telegram getFile 请求失败: HTTP ${res.status}`);
        const data = await res.json();
        if (!data || data.ok !== true || !data.result || !data.result.file_path) {
            throw new Error(`Telegram getFile 返回异常: ${JSON.stringify(data)}`);
        }
        return `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
    } catch (err) {
        if (err && err.name === 'AbortError') throw new Error('Telegram getFile 请求超时');
        throw err instanceof Error ? err : new Error(String(err));
    } finally {
        clearTimeout(timer);
    }
}

/** 读取缩略图缓存（过期视为未命中；命中的条目重新插入以维持最旧优先淘汰） */
function thumbCacheGet(key) {
    const entry = thumbCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > THUMB_CACHE_TTL) {
        thumbCache.delete(key);
        return null;
    }
    thumbCache.delete(key);
    thumbCache.set(key, entry);
    return entry;
}

/** 写入缩略图缓存（超过上限时淘汰最旧条目） */
function thumbCacheSet(key, buffer, contentType) {
    thumbCache.delete(key);
    thumbCache.set(key, { buffer, contentType, at: Date.now() });
    while (thumbCache.size > THUMB_CACHE_MAX) {
        const oldest = thumbCache.keys().next().value;
        thumbCache.delete(oldest);
    }
}

/**
 * 下载缩略图：并发请求共享同一次下载；成功且不超过 4MB 时写入内存缓存
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
function loadThumbBuffer(D, fileUniqueId, fileId) {
    const cached = thumbCacheGet(fileUniqueId);
    if (cached) return Promise.resolve(cached);

    const inflight = thumbInflight.get(fileUniqueId);
    if (inflight) return inflight;

    const task = (async () => {
        const fileUrl = await D.telegramGetFile(fileId);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT);
        try {
            const res = await fetch(fileUrl, { signal: controller.signal });
            if (!res.ok) throw new Error(`缩略图下载失败: HTTP ${res.status}`);
            const contentType = res.headers.get('content-type') || 'image/jpeg';
            const buffer = Buffer.from(await res.arrayBuffer());
            if (buffer.length <= THUMB_CACHE_MAX_BYTES) thumbCacheSet(fileUniqueId, buffer, contentType);
            return { buffer, contentType };
        } catch (err) {
            if (err && err.name === 'AbortError') throw new Error('缩略图下载超时');
            throw err instanceof Error ? err : new Error(String(err));
        } finally {
            clearTimeout(timer);
        }
    })();

    thumbInflight.set(fileUniqueId, task);
    // 无论成功失败都释放并发槽位（两个回调避免未处理的 Promise 拒绝）
    task.then(() => thumbInflight.delete(fileUniqueId), () => thumbInflight.delete(fileUniqueId));
    return task;
}

/**
 * 缩略图代理：GET /api/thumb?fileUniqueId=xxx&token=xxx
 * <img> 无法携带 Authorization 头，因此在 requireAuth 之前单独处理，用 query token 校验
 */
async function handleThumb(D, req, res, url) {
    const auth = req.headers.authorization || '';
    const token = url.searchParams.get('token') || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!isTokenValid(token)) {
        json(res, 401, { error: '未授权' });
        return;
    }

    const fileUniqueId = url.searchParams.get('fileUniqueId');
    if (!fileUniqueId) {
        json(res, 400, { error: '缺少 fileUniqueId' });
        return;
    }

    try {
        const mediaDoc = await D.getCollection(COLLECTIONS.MEDIA).findOne({ file_unique_id: fileUniqueId });
        if (!mediaDoc) {
            json(res, 404, { error: '未找到该媒体' });
            return;
        }
        // 图片用自身 file_id；视频/文档/音频用收录时保存的封面 file_id（新增媒体才有）
        const thumbFileId = mediaDoc.media_type === 'photo'
            ? mediaDoc.file_id
            : (mediaDoc.thumb_file_id || null);
        if (!thumbFileId) {
            json(res, 415, { error: '该媒体没有可用缩略图' });
            return;
        }

        // 缓存键区分「封面」与「原图」，避免同一媒体两种图串味
        const cacheKey = mediaDoc.media_type === 'photo' ? fileUniqueId : `${fileUniqueId}:thumb`;
        const { buffer, contentType } = await loadThumbBuffer(D, cacheKey, thumbFileId);
        res.writeHead(200, {
            'Content-Type': contentType || 'image/jpeg',
            'Content-Length': buffer.length,
            'Cache-Control': 'private, max-age=1800'
        });
        res.end(buffer);
    } catch (err) {
        // 任何失败都不向上抛，统一返回 404 JSON
        logger.error(`WebUI 缩略图获取失败 [${fileUniqueId}]: ${err.message}`);
        if (!res.headersSent) json(res, 404, { error: '缩略图获取失败' });
        else res.end();
    }
}

/**
 * SSE 日志流：GET /api/logs/stream?token=xxx
 */
function handleLogStream(req, res, url) {
    const token = url.searchParams.get('token');
    if (!isTokenValid(token)) {
        json(res, 401, { error: '未授权' });
        return;
    }
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');

    const client = { res };
    sseClients.add(client);

    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 30000);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(client);
    });
    res.on('error', () => {
        clearInterval(heartbeat);
        sseClients.delete(client);
    });
}

// 注册 logger 订阅（全局只注册一次，广播给所有 SSE 客户端）
let loggerSubscribed = false;
function ensureLoggerSubscription() {
    if (loggerSubscribed) return;
    loggerSubscribed = true;
    logger.onLog((entry) => {
        const payload = `data: ${JSON.stringify(entry)}\n\n`;
        for (const client of sseClients) {
            try { client.res.write(payload); } catch { /* ignore */ }
        }
    });
}

/**
 * 关闭所有 SSE 日志流连接
 * 优雅关闭时必须先调用，否则 server.close() 会因长连接挂起
 */
function closeAllSseClients() {
    for (const client of sseClients) {
        try { client.res.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
}

// ---------------- 搬运收录（transport）----------------

/** 未检查：字段缺失或为 null 都算"未检查" */
const TRANSPORT_UNCHECKED = { $or: [{ alive: null }, { alive: { $exists: false } }] };

/** transport 文档 → 前端结构（附可点击跳转链接与活性状态） */
function transportView(doc) {
    const d = doc || {};
    return {
        chat_id: d.chat_id,
        chat_name: d.chat_name || `Chat${d.chat_id}`,
        url: d.url || '',
        link: transportLinkUrl(d),
        num: Number.isFinite(Number(d.num)) ? Number(d.num) : 0,
        alive: d.alive === true ? true : (d.alive === false ? false : null),
        last_check_at: d.last_check_at || null,
        last_check_status: d.last_check_status || null,
        last_check_error: d.last_check_error || null,
        created_at: d.created_at || null,
        updated_at: d.updated_at || null
    };
}

async function handleTransportList(D, url) {
    const q = (url.searchParams.get('q') || '').trim();
    const status = url.searchParams.get('status') || 'all';
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize'), 10) || 20));

    const and = [];
    if (q) {
        const or = [
            { chat_name: { $regex: escapeRegex(q), $options: 'i' } },
            { url: { $regex: escapeRegex(q), $options: 'i' } }
        ];
        if (/^-?\d+$/.test(q)) or.push({ chat_id: Number(q) });
        and.push({ $or: or });
    }
    if (status === 'alive') and.push({ alive: true });
    else if (status === 'dead') and.push({ alive: false });
    else if (status === 'unchecked') and.push(TRANSPORT_UNCHECKED);
    const filter = and.length ? { $and: and } : {};

    const col = D.getCollection(COLLECTIONS.TRANSPORT);
    const total = await col.countDocuments(filter);
    const docs = await col.find(filter).sort({ num: -1, chat_id: 1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();
    const [all, alive, dead, unchecked] = await Promise.all([
        col.countDocuments({}),
        col.countDocuments({ alive: true }),
        col.countDocuments({ alive: false }),
        col.countDocuments(TRANSPORT_UNCHECKED)
    ]);

    return {
        status: 200,
        data: {
            items: docs.map(transportView),
            total, page, pageSize,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            counts: { all, alive, dead, unchecked }
        }
    };
}

async function handleTransportCreate(D, url, body) {
    const chatId = toNumberId(body.chat_id);
    if (chatId === null) return { status: 400, data: { error: 'chat_id 必须是数字' } };
    const link = String(body.url || '').trim();
    if (!link) return { status: 400, data: { error: '收录链接不能为空' } };

    const col = D.getCollection(COLLECTIONS.TRANSPORT);
    if (await col.findOne({ chat_id: chatId })) {
        return { status: 409, data: { error: `该会话已存在收录记录（chat_id=${chatId}）` } };
    }
    const now = Date.now();
    const doc = {
        chat_id: chatId,
        chat_name: String(body.chat_name || '').trim().slice(0, 64) || `Chat${chatId}`,
        url: link,
        num: Number.isFinite(Number(body.num)) ? Number(body.num) : 0,
        created_at: now,
        updated_at: now,
        alive: null,
        last_check_at: null,
        last_check_status: null,
        last_check_error: null
    };
    await col.insertOne(doc);
    logOperation({
        action: 'transport_save',
        source: 'webui',
        target: { type: 'chat', id: chatId },
        counts: { chats: 1 },
        detail: { chat_name: doc.chat_name, url: link, created: true, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, chat_id: chatId, item: transportView(doc) } };
}

async function handleTransportUpdate(D, url, body) {
    const chatId = toNumberId(body.chat_id);
    if (chatId === null) return { status: 400, data: { error: 'chat_id 必须是数字' } };
    const patch = isPlainObject(body.patch) ? body.patch : {};

    const update = {};
    if (typeof patch.chat_name === 'string' && patch.chat_name.trim()) {
        update.chat_name = patch.chat_name.trim().slice(0, 64);
    }
    if (patch.url !== undefined) {
        const link = String(patch.url || '').trim();
        if (!link) return { status: 400, data: { error: '收录链接不能为空' } };
        update.url = link;
    }
    if (patch.num !== undefined && Number.isFinite(Number(patch.num))) update.num = Number(patch.num);
    if (Object.keys(update).length === 0) {
        return { status: 400, data: { error: '没有可修改的字段（chat_name/url/num）' } };
    }

    const col = D.getCollection(COLLECTIONS.TRANSPORT);
    const before = await col.findOne({ chat_id: chatId });
    if (!before) return { status: 404, data: { error: `未找到收录记录（chat_id=${chatId}）` } };

    update.updated_at = Date.now();
    // 链接变化后旧的活性结论作废，等待重新检查
    if (update.url && update.url !== before.url) {
        Object.assign(update, { alive: null, last_check_status: null, last_check_error: null, last_check_at: null });
    }
    await col.updateOne({ chat_id: chatId }, { $set: update });
    const after = await col.findOne({ chat_id: chatId });

    logOperation({
        action: 'transport_save',
        source: 'webui',
        target: { type: 'chat', id: chatId },
        counts: { chats: 1 },
        detail: { chat_name: update.chat_name || before.chat_name, url: update.url || before.url, fields: Object.keys(update), via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, chat_id: chatId, item: transportView(after || { ...before, ...update }) } };
}

async function handleTransportDelete(D, url, body) {
    if (body.confirm !== true) return { status: 400, data: { error: '删除需要二次确认（confirm: true）' } };
    const chatId = toNumberId(body.chat_id);
    if (chatId === null) return { status: 400, data: { error: 'chat_id 必须是数字' } };
    const col = D.getCollection(COLLECTIONS.TRANSPORT);
    const before = await col.findOne({ chat_id: chatId });
    const result = await col.deleteOne({ chat_id: chatId });
    if (result.deletedCount === 0) return { status: 404, data: { error: `未找到收录记录（chat_id=${chatId}）` } };

    logOperation({
        action: 'transport_delete',
        source: 'webui',
        target: { type: 'chat', id: chatId },
        counts: { chats: 1 },
        detail: { chat_name: (before && before.chat_name) || undefined, url: (before && before.url) || undefined, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, chat_id: chatId } };
}

/** 活性检查（单条 / 全部）；检查器可通过 deps 注入，便于离线测试 */
async function handleTransportCheck(D, url, body) {
    let checkOne = D.checkTransportLink;
    let checkAll = D.checkAllTransports;
    if (!checkOne || !checkAll) {
        try {
            const lh = require('../utils/linkHealth');
            checkOne = checkOne || lh.checkTransportLink;
            checkAll = checkAll || lh.checkAllTransports;
        } catch (err) {
            return { status: 503, data: { error: `活性检查不可用：${err.message}` } };
        }
    }
    const col = D.getCollection(COLLECTIONS.TRANSPORT);
    const chatId = toNumberId(body.chat_id);

    if (chatId !== null) {
        const doc = await col.findOne({ chat_id: chatId });
        if (!doc) return { status: 404, data: { error: `未找到收录记录（chat_id=${chatId}）` } };
        const result = await checkOne(doc);
        const update = {
            last_check_at: Date.now(),
            last_check_status: result.status,
            last_check_error: result.error || null
        };
        if (result.status === 'ok') update.alive = true;
        else if (result.status === 'dead') update.alive = false;
        else update.alive = doc.alive === undefined ? null : doc.alive;
        if (result.chat_name) update.chat_name = result.chat_name;
        await col.updateOne({ chat_id: chatId }, { $set: update });
        const after = await col.findOne({ chat_id: chatId });
        logOperation({
            action: 'transport_check',
            source: 'webui',
            target: { type: 'chat', id: chatId },
            detail: { status: result.status, error: result.error || undefined, via: 'webui' }
        }).catch(() => { });
        return { status: 200, data: { ok: true, item: transportView(after || { ...doc, ...update }) } };
    }

    const summary = await checkAll({ force: true, concurrency: 4 });
    logOperation({
        action: 'transport_check',
        source: 'webui',
        target: { type: 'collection', id: COLLECTIONS.TRANSPORT },
        counts: { chats: summary.checked },
        detail: {
            total: summary.total, ok: summary.ok, dead: summary.dead.length,
            unknown: summary.unknown.length, newlyDead: summary.newlyDead.length, via: 'webui'
        }
    }).catch(() => { });
    return {
        status: 200,
        data: {
            ok: true,
            summary: {
                total: summary.total,
                checked: summary.checked,
                ok: summary.ok,
                dead: summary.dead.length,
                unknown: summary.unknown.length,
                newlyDead: summary.newlyDead.map(d => ({ chat_id: d.chat_id, chat_name: d.chat_name, error: d.check_error }))
            }
        }
    };
}

// ---------------- 文章（article / sub_article）----------------

/** 取下一个业务自增 id（用 find+sort+limit，避免依赖 findOne 的 sort 选项） */
async function nextBizId(col) {
    const docs = await col.find({}).sort({ id: -1 }).limit(1).toArray();
    const max = docs.length ? Number(docs[0].id) : 0;
    return (Number.isFinite(max) ? max : 0) + 1;
}

function articleView(doc, subs, subCount) {
    const d = doc || {};
    return {
        id: d.id,
        title: d.title || '',
        link: d.link || '',
        created_at: d.created_at || null,
        updated_at: d.updated_at || null,
        subCount: subCount === undefined ? (subs ? subs.length : 0) : subCount,
        subs: subs || []
    };
}

function subArticleView(doc) {
    const d = doc || {};
    return {
        id: d.id,
        article_id: d.article_id,
        title: d.title || '',
        link: d.link || '',
        created_at: d.created_at || null,
        updated_at: d.updated_at || null
    };
}

async function handleArticleList(D, url) {
    const q = (url.searchParams.get('q') || '').trim();
    const withSubs = url.searchParams.get('withSubs') === '1';
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize'), 10) || 20));

    const col = D.getCollection(COLLECTIONS.ARTICLE);
    const subCol = D.getCollection(COLLECTIONS.SUB_ARTICLE);
    const filter = q
        ? { $or: [
            { title: { $regex: escapeRegex(q), $options: 'i' } },
            { link: { $regex: escapeRegex(q), $options: 'i' } }
        ] }
        : {};
    const total = await col.countDocuments(filter);
    const docs = await col.find(filter).sort({ updated_at: -1, id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();

    const items = [];
    for (const doc of docs) {
        const subs = withSubs ? await subCol.find({ article_id: doc.id }).sort({ updated_at: -1, id: -1 }).toArray() : [];
        const subCount = withSubs ? subs.length : await subCol.countDocuments({ article_id: doc.id });
        items.push(articleView(doc, subs.map(subArticleView), subCount));
    }

    return {
        status: 200,
        data: {
            items, total, page, pageSize,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            subTotal: await subCol.countDocuments({})
        }
    };
}

async function handleArticleCreate(D, url, body) {
    const title = String(body.title || '').trim();
    if (!title) return { status: 400, data: { error: '标题不能为空' } };
    if (title.length > 200) return { status: 400, data: { error: '标题最长 200 个字符' } };
    const col = D.getCollection(COLLECTIONS.ARTICLE);
    const now = Date.now();
    const id = await nextBizId(col);
    const doc = { id, title, link: String(body.link || '').trim(), created_at: now, updated_at: now };
    await col.insertOne(doc);
    logOperation({
        action: 'article_save',
        source: 'webui',
        target: { type: 'article', id },
        counts: { articles: 1 },
        detail: { title, created: true, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id, item: articleView(doc, [], 0) } };
}

async function handleArticleUpdate(D, url, body) {
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    const patch = isPlainObject(body.patch) ? body.patch : {};
    const update = {};
    if (patch.title !== undefined) {
        const title = String(patch.title || '').trim();
        if (!title) return { status: 400, data: { error: '标题不能为空' } };
        update.title = title.slice(0, 200);
    }
    if (patch.link !== undefined) update.link = String(patch.link || '').trim();
    if (Object.keys(update).length === 0) return { status: 400, data: { error: '没有可修改的字段（title/link）' } };

    const col = D.getCollection(COLLECTIONS.ARTICLE);
    const before = await col.findOne({ id });
    if (!before) return { status: 404, data: { error: `未找到文章 id=${id}` } };
    update.updated_at = Date.now();
    await col.updateOne({ id }, { $set: update });
    const after = await col.findOne({ id });
    logOperation({
        action: 'article_save',
        source: 'webui',
        target: { type: 'article', id },
        counts: { articles: 1 },
        detail: { title: update.title !== undefined ? update.title : before.title, fields: Object.keys(update), via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id, item: articleView(after || { ...before, ...update }) } };
}

async function handleArticleDelete(D, url, body) {
    if (body.confirm !== true) return { status: 400, data: { error: '删除需要二次确认（confirm: true）' } };
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    const col = D.getCollection(COLLECTIONS.ARTICLE);
    const subCol = D.getCollection(COLLECTIONS.SUB_ARTICLE);
    const before = await col.findOne({ id });
    const subResult = await subCol.deleteMany({ article_id: id });
    const result = await col.deleteOne({ id });
    if (result.deletedCount === 0) return { status: 404, data: { error: `未找到文章 id=${id}` } };
    logOperation({
        action: 'article_delete',
        source: 'webui',
        target: { type: 'article', id },
        counts: { articles: 1, subArticles: subResult.deletedCount || 0 },
        detail: { title: (before && before.title) || undefined, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id, removedSubs: subResult.deletedCount || 0 } };
}

async function handleSubArticleCreate(D, url, body) {
    const articleId = toNumberId(body.article_id);
    if (articleId === null) return { status: 400, data: { error: 'article_id 必须是数字' } };
    const title = String(body.title || '').trim();
    if (!title) return { status: 400, data: { error: '子文章标题不能为空' } };
    const articleCol = D.getCollection(COLLECTIONS.ARTICLE);
    if (!(await articleCol.findOne({ id: articleId }))) {
        return { status: 404, data: { error: `未找到文章 id=${articleId}` } };
    }
    const col = D.getCollection(COLLECTIONS.SUB_ARTICLE);
    const now = Date.now();
    const id = await nextBizId(col);
    const doc = { id, article_id: articleId, title: title.slice(0, 200), link: String(body.link || '').trim(), created_at: now, updated_at: now };
    await col.insertOne(doc);
    await articleCol.updateOne({ id: articleId }, { $set: { updated_at: now } });
    logOperation({
        action: 'article_save',
        source: 'webui',
        target: { type: 'article', id: articleId },
        counts: { subArticles: 1 },
        detail: { title: doc.title, subId: id, created: true, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id, item: subArticleView(doc) } };
}

async function handleSubArticleUpdate(D, url, body) {
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    const patch = isPlainObject(body.patch) ? body.patch : {};
    const update = {};
    if (patch.title !== undefined) {
        const title = String(patch.title || '').trim();
        if (!title) return { status: 400, data: { error: '子文章标题不能为空' } };
        update.title = title.slice(0, 200);
    }
    if (patch.link !== undefined) update.link = String(patch.link || '').trim();
    if (Object.keys(update).length === 0) return { status: 400, data: { error: '没有可修改的字段（title/link）' } };

    const col = D.getCollection(COLLECTIONS.SUB_ARTICLE);
    const before = await col.findOne({ id });
    if (!before) return { status: 404, data: { error: `未找到子文章 id=${id}` } };
    update.updated_at = Date.now();
    await col.updateOne({ id }, { $set: update });
    const articleCol = D.getCollection(COLLECTIONS.ARTICLE);
    await articleCol.updateOne({ id: before.article_id }, { $set: { updated_at: update.updated_at } });
    const after = await col.findOne({ id });
    logOperation({
        action: 'article_save',
        source: 'webui',
        target: { type: 'article', id: before.article_id },
        counts: { subArticles: 1 },
        detail: { subId: id, fields: Object.keys(update), via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id, item: subArticleView(after || { ...before, ...update }) } };
}

async function handleSubArticleDelete(D, url, body) {
    if (body.confirm !== true) return { status: 400, data: { error: '删除需要二次确认（confirm: true）' } };
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    const col = D.getCollection(COLLECTIONS.SUB_ARTICLE);
    const before = await col.findOne({ id });
    const result = await col.deleteOne({ id });
    if (result.deletedCount === 0) return { status: 404, data: { error: `未找到子文章 id=${id}` } };
    if (before) {
        await D.getCollection(COLLECTIONS.ARTICLE).updateOne({ id: before.article_id }, { $set: { updated_at: Date.now() } });
    }
    logOperation({
        action: 'article_delete',
        source: 'webui',
        target: { type: 'article', id: before ? before.article_id : undefined },
        counts: { subArticles: 1 },
        detail: { subId: id, title: (before && before.title) || undefined, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id } };
}

// ---------------- 合集 / 杂集（collection / sub_collection）----------------

const COLLECTION_TYPES = new Set(['collection', 'misc']);

function collectionView(doc, subs, subCount) {
    const d = doc || {};
    return {
        id: d.id,
        name: d.name || '',
        type: d.type || 'collection',
        created_at: d.created_at || null,
        updated_at: d.updated_at || null,
        subCount: subCount === undefined ? (subs ? subs.length : 0) : subCount,
        subs: subs || []
    };
}

function subCollectionView(doc) {
    const d = doc || {};
    return {
        id: d.id,
        collection_id: d.collection_id,
        name: d.name || '',
        link: d.link || '',
        created_at: d.created_at || null,
        updated_at: d.updated_at || null
    };
}

async function handleCollectionList(D, url) {
    const type = url.searchParams.get('type') || 'all';
    const q = (url.searchParams.get('q') || '').trim();
    const withSubs = url.searchParams.get('withSubs') === '1';

    const col = D.getCollection(COLLECTIONS.COLLECTION);
    const subCol = D.getCollection(COLLECTIONS.SUB_COLLECTION);
    const and = [];
    if (COLLECTION_TYPES.has(type)) and.push({ type });
    if (q) and.push({ name: { $regex: escapeRegex(q), $options: 'i' } });
    const filter = and.length ? { $and: and } : {};
    const docs = await col.find(filter).sort({ updated_at: -1, id: -1 }).toArray();

    const items = [];
    for (const doc of docs) {
        const subs = withSubs ? await subCol.find({ collection_id: doc.id }).sort({ updated_at: -1, id: -1 }).toArray() : [];
        const subCount = withSubs ? subs.length : await subCol.countDocuments({ collection_id: doc.id });
        items.push(collectionView(doc, subs.map(subCollectionView), subCount));
    }

    const [all, collections, misc] = await Promise.all([
        col.countDocuments({}),
        col.countDocuments({ type: 'collection' }),
        col.countDocuments({ type: 'misc' })
    ]);
    return {
        status: 200,
        data: {
            items,
            total: items.length,
            counts: { all, collection: collections, misc },
            subTotal: await subCol.countDocuments({})
        }
    };
}

async function handleCollectionCreate(D, url, body) {
    const name = String(body.name || '').trim();
    if (!name) return { status: 400, data: { error: '名称不能为空' } };
    const type = String(body.type || 'collection');
    if (!COLLECTION_TYPES.has(type)) return { status: 400, data: { error: "type 必须是 collection（合集）或 misc（杂集）" } };
    const col = D.getCollection(COLLECTIONS.COLLECTION);
    const now = Date.now();
    const id = await nextBizId(col);
    const doc = { id, name: name.slice(0, 200), type, created_at: now, updated_at: now };
    await col.insertOne(doc);
    logOperation({
        action: 'collection_save',
        source: 'webui',
        target: { type: 'collection', id },
        counts: { collections: 1 },
        detail: { name: doc.name, type, created: true, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id, item: collectionView(doc, [], 0) } };
}

async function handleCollectionUpdate(D, url, body) {
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    const patch = isPlainObject(body.patch) ? body.patch : {};
    const update = {};
    if (patch.name !== undefined) {
        const name = String(patch.name || '').trim();
        if (!name) return { status: 400, data: { error: '名称不能为空' } };
        update.name = name.slice(0, 200);
    }
    if (patch.type !== undefined) {
        const type = String(patch.type);
        if (!COLLECTION_TYPES.has(type)) return { status: 400, data: { error: "type 必须是 collection（合集）或 misc（杂集）" } };
        update.type = type;
    }
    if (Object.keys(update).length === 0) return { status: 400, data: { error: '没有可修改的字段（name/type）' } };

    const col = D.getCollection(COLLECTIONS.COLLECTION);
    const before = await col.findOne({ id });
    if (!before) return { status: 404, data: { error: `未找到合集 id=${id}` } };
    update.updated_at = Date.now();
    await col.updateOne({ id }, { $set: update });
    const after = await col.findOne({ id });
    logOperation({
        action: 'collection_save',
        source: 'webui',
        target: { type: 'collection', id },
        counts: { collections: 1 },
        detail: { name: update.name !== undefined ? update.name : before.name, fields: Object.keys(update), via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id, item: collectionView(after || { ...before, ...update }) } };
}

async function handleCollectionDelete(D, url, body) {
    if (body.confirm !== true) return { status: 400, data: { error: '删除需要二次确认（confirm: true）' } };
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    const col = D.getCollection(COLLECTIONS.COLLECTION);
    const subCol = D.getCollection(COLLECTIONS.SUB_COLLECTION);
    const before = await col.findOne({ id });
    const subResult = await subCol.deleteMany({ collection_id: id });
    const result = await col.deleteOne({ id });
    if (result.deletedCount === 0) return { status: 404, data: { error: `未找到合集 id=${id}` } };
    logOperation({
        action: 'collection_delete',
        source: 'webui',
        target: { type: 'collection', id },
        counts: { collections: 1, subCollections: subResult.deletedCount || 0 },
        detail: { name: (before && before.name) || undefined, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id, removedSubs: subResult.deletedCount || 0 } };
}

async function handleSubCollectionCreate(D, url, body) {
    const collectionId = toNumberId(body.collection_id);
    if (collectionId === null) return { status: 400, data: { error: 'collection_id 必须是数字' } };
    const name = String(body.name || '').trim();
    if (!name) return { status: 400, data: { error: '子项名称不能为空' } };
    const collectionCol = D.getCollection(COLLECTIONS.COLLECTION);
    if (!(await collectionCol.findOne({ id: collectionId }))) {
        return { status: 404, data: { error: `未找到合集 id=${collectionId}` } };
    }
    const col = D.getCollection(COLLECTIONS.SUB_COLLECTION);
    const now = Date.now();
    const id = await nextBizId(col);
    const doc = { id, collection_id: collectionId, name: name.slice(0, 200), link: String(body.link || '').trim(), created_at: now, updated_at: now };
    await col.insertOne(doc);
    await collectionCol.updateOne({ id: collectionId }, { $set: { updated_at: now } });
    logOperation({
        action: 'collection_save',
        source: 'webui',
        target: { type: 'collection', id: collectionId },
        counts: { subCollections: 1 },
        detail: { name: doc.name, subId: id, created: true, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id, item: subCollectionView(doc) } };
}

async function handleSubCollectionUpdate(D, url, body) {
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    const patch = isPlainObject(body.patch) ? body.patch : {};
    const update = {};
    if (patch.name !== undefined) {
        const name = String(patch.name || '').trim();
        if (!name) return { status: 400, data: { error: '子项名称不能为空' } };
        update.name = name.slice(0, 200);
    }
    if (patch.link !== undefined) update.link = String(patch.link || '').trim();
    if (Object.keys(update).length === 0) return { status: 400, data: { error: '没有可修改的字段（name/link）' } };

    const col = D.getCollection(COLLECTIONS.SUB_COLLECTION);
    const before = await col.findOne({ id });
    if (!before) return { status: 404, data: { error: `未找到子项 id=${id}` } };
    update.updated_at = Date.now();
    await col.updateOne({ id }, { $set: update });
    await D.getCollection(COLLECTIONS.COLLECTION).updateOne({ id: before.collection_id }, { $set: { updated_at: update.updated_at } });
    const after = await col.findOne({ id });
    logOperation({
        action: 'collection_save',
        source: 'webui',
        target: { type: 'collection', id: before.collection_id },
        counts: { subCollections: 1 },
        detail: { subId: id, fields: Object.keys(update), via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id, item: subCollectionView(after || { ...before, ...update }) } };
}

async function handleSubCollectionDelete(D, url, body) {
    if (body.confirm !== true) return { status: 400, data: { error: '删除需要二次确认（confirm: true）' } };
    const id = toNumberId(body.id);
    if (id === null) return { status: 400, data: { error: 'id 必须是数字' } };
    const col = D.getCollection(COLLECTIONS.SUB_COLLECTION);
    const before = await col.findOne({ id });
    const result = await col.deleteOne({ id });
    if (result.deletedCount === 0) return { status: 404, data: { error: `未找到子项 id=${id}` } };
    if (before) {
        await D.getCollection(COLLECTIONS.COLLECTION).updateOne({ id: before.collection_id }, { $set: { updated_at: Date.now() } });
    }
    logOperation({
        action: 'collection_delete',
        source: 'webui',
        target: { type: 'collection', id: before ? before.collection_id : undefined },
        counts: { subCollections: 1 },
        detail: { subId: id, name: (before && before.name) || undefined, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, id } };
}

// ---------------- 标签库（tags）增删与置顶排序 ----------------

async function handleTagCreate(D, url, body) {
    const name = normalizeTagName(body.name);
    if (!name) return { status: 400, data: { error: '标签名不能为空，且不超过 20 个字符' } };
    // 显式查重（不依赖唯一索引报错，便于给出明确提示，也便于测试）
    if (await D.getCollection(COLLECTIONS.TAGS).findOne({ name })) {
        return { status: 409, data: { error: `标签「${name}」已存在` } };
    }
    const { addTag } = require('../db/tags');
    const result = await addTag(name);
    if (!result.ok) return { status: 409, data: { error: result.error || '添加标签失败' } };
    logOperation({
        action: 'tag_create',
        source: 'webui',
        target: { type: 'tag', id: name },
        counts: { tags: 1 },
        detail: { tag: name, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, name } };
}

async function handleTagDelete(D, url, body) {
    if (body.confirm !== true) return { status: 400, data: { error: '删除标签需要二次确认（confirm: true）' } };
    const name = normalizeTagName(body.name);
    if (!name) return { status: 400, data: { error: '标签名不能为空' } };
    const { removeTag } = require('../db/tags');
    const result = await removeTag(name);
    if (!result.ok) return { status: 404, data: { error: result.error || '删除标签失败' } };
    logOperation({
        action: 'tag_delete',
        source: 'webui',
        target: { type: 'tag', id: name },
        counts: { tags: 1, messages: result.synced || undefined },
        detail: { tag: name, synced: result.synced || 0, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, name, synced: result.synced || 0 } };
}

/**
 * 标签改名：POST /api/tags/rename
 * body: { name, to }
 * 会同步改写所有消息里的该标签（db/tags.renameTag）
 */
async function handleTagRename(D, url, body) {
    const from = normalizeTagName(body.name);
    const to = normalizeTagName(body.to);
    if (!from) return { status: 400, data: { error: '原标签名不能为空' } };
    if (!to) return { status: 400, data: { error: '新标签名不能为空，且不超过 20 个字符' } };

    const { renameTag } = require('../db/tags');
    const result = await renameTag(from, to);
    if (!result.ok) {
        const notFound = /不存在/.test(result.error || '');
        return { status: notFound ? 404 : 409, data: { error: result.error || '改名失败' } };
    }
    if (from !== to) {
        logOperation({
            action: 'tag_rename',
            source: 'webui',
            target: { type: 'tag', id: to },
            counts: { tags: 1, messages: result.synced || undefined },
            detail: { from, to, synced: result.synced || 0, via: 'webui' }
        }).catch(() => { });
    }
    return { status: 200, data: { ok: true, name: to, from, synced: result.synced || 0, tags: result.tags } };
}

async function handleTagPin(D, url, body) {
    const name = normalizeTagName(body.name);
    if (!name) return { status: 400, data: { error: '标签名不能为空' } };
    const pin = Math.min(normalizePin(body.pin), 40);
    const { setTagPin } = require('../db/tags');
    const result = await setTagPin(name, pin);
    if (!result.ok) return { status: 404, data: { error: result.error || '设置置顶失败' } };
    logOperation({
        action: 'tag_pin',
        source: 'webui',
        target: { type: 'tag', id: name },
        counts: { tags: 1 },
        detail: { tag: name, pin, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, name, pin, tags: result.tags } };
}

/** 置顶排序：按传入顺序写 pin=1..N（拖拽排序保存用） */
async function handleTagReorder(D, url, body) {
    const names = Array.isArray(body.names) ? body.names : null;
    if (!names || !names.length) return { status: 400, data: { error: 'names 必须是非空数组' } };
    const { reorderTags } = require('../db/tags');
    const result = await reorderTags(names);
    if (!result.ok) return { status: 400, data: { error: result.error || '排序失败' } };
    logOperation({
        action: 'tag_pin',
        source: 'webui',
        target: { type: 'collection', id: COLLECTIONS.TAGS },
        counts: { tags: result.updated },
        detail: { order: names.slice(0, 40), updated: result.updated, via: 'webui' }
    }).catch(() => { });
    return { status: 200, data: { ok: true, updated: result.updated, tags: result.tags } };
}

// ---------------- 数据库存储统计 ----------------

/**
 * GET /api/db-stats
 * 各集合文档数 / 数据大小 / 存储大小 / 索引；套餐不允许读取大小时自动降级为仅文档数
 */
async function handleDbStats(D, url) {
    const force = url.searchParams.get('force') === '1';
    try {
        const { getDbStats } = require('../db/dbStats');
        const stats = await getDbStats({ force });
        return { status: 200, data: { ok: true, ...stats } };
    } catch (err) {
        logger.warn(`读取数据库统计失败（降级为不可用）: ${err.message}`);
        return {
            status: 200,
            data: {
                ok: false,
                available: false,
                reason: err.message || '无法读取数据库统计',
                at: Date.now(),
                totals: null,
                collections: []
            }
        };
    }
}

// 路由表：method + path 前缀
const ROUTES = [
    ['POST', /^\/api\/login$/, handleLogin],
    ['GET', /^\/api\/db\/collections$/, handleCollections],
    ['POST', /^\/api\/db\/query$/, handleDbQuery],
    ['POST', /^\/api\/db\/execute$/, handleDbExecute],
    ['POST', /^\/api\/ai\/plan$/, handleAiPlan],
    // 领域只读接口
    ['GET', /^\/api\/overview$/, handleOverview],
    ['GET', /^\/api\/media$/, handleMediaList],
    ['GET', /^\/api\/media\/detail$/, handleMediaDetail],
    ['GET', /^\/api\/random$/, handleRandom],
    ['POST', /^\/api\/clean$/, handleClean],
    ['GET', /^\/api\/tags$/, handleTags],
    ['GET', /^\/api\/users$/, handleUsers],
    ['GET', /^\/api\/groups$/, handleGroups],
    // 控制台写操作
    ['POST', /^\/api\/media\/tags$/, handleMediaTags],
    ['POST', /^\/api\/media\/description$/, handleMediaDescription],
    ['POST', /^\/api\/users\/create$/, handleUserCreate],
    ['POST', /^\/api\/users\/update$/, handleUserUpdate],
    ['POST', /^\/api\/users\/delete$/, handleUserDelete],
    ['POST', /^\/api\/groups\/create$/, handleChatCreate],
    ['POST', /^\/api\/groups\/update$/, handleChatUpdate],
    ['POST', /^\/api\/groups\/delete$/, handleChatDelete],
    // 报表
    ['GET', /^\/api\/oplogs$/, handleOpLogs],
    ['GET', /^\/api\/stats$/, handleStats],
    // 搬运收录（含链接活性检查）
    ['GET', /^\/api\/transport$/, handleTransportList],
    ['POST', /^\/api\/transport\/create$/, handleTransportCreate],
    ['POST', /^\/api\/transport\/update$/, handleTransportUpdate],
    ['POST', /^\/api\/transport\/delete$/, handleTransportDelete],
    ['POST', /^\/api\/transport\/check$/, handleTransportCheck],
    // 文章 / 子文章
    ['GET', /^\/api\/articles$/, handleArticleList],
    ['POST', /^\/api\/articles\/create$/, handleArticleCreate],
    ['POST', /^\/api\/articles\/update$/, handleArticleUpdate],
    ['POST', /^\/api\/articles\/delete$/, handleArticleDelete],
    ['POST', /^\/api\/articles\/sub\/create$/, handleSubArticleCreate],
    ['POST', /^\/api\/articles\/sub\/update$/, handleSubArticleUpdate],
    ['POST', /^\/api\/articles\/sub\/delete$/, handleSubArticleDelete],
    // 合集 / 杂集 / 子项
    ['GET', /^\/api\/collections$/, handleCollectionList],
    ['POST', /^\/api\/collections\/create$/, handleCollectionCreate],
    ['POST', /^\/api\/collections\/update$/, handleCollectionUpdate],
    ['POST', /^\/api\/collections\/delete$/, handleCollectionDelete],
    ['POST', /^\/api\/collections\/sub\/create$/, handleSubCollectionCreate],
    ['POST', /^\/api\/collections\/sub\/update$/, handleSubCollectionUpdate],
    ['POST', /^\/api\/collections\/sub\/delete$/, handleSubCollectionDelete],
    // 数据库存储统计
    ['GET', /^\/api\/db-stats$/, handleDbStats],
    // 标签库增删 / 改名 / 置顶 / 拖拽排序
    ['POST', /^\/api\/tags\/create$/, handleTagCreate],
    ['POST', /^\/api\/tags\/delete$/, handleTagDelete],
    ['POST', /^\/api\/tags\/rename$/, handleTagRename],
    ['POST', /^\/api\/tags\/pin$/, handleTagPin],
    ['POST', /^\/api\/tags\/reorder$/, handleTagReorder],
];

async function handleApi(D, req, res, url) {
    const method = req.method;
    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
        const raw = await readBody(req).catch(() => '');
        try {
            body = raw ? JSON.parse(raw) : {};
        } catch {
            return json(res, 400, { error: '无效的 JSON 请求体' });
        }
    }

    for (const [routeMethod, routeRegex, handler] of ROUTES) {
        const match = url.pathname.match(routeRegex);
        if (routeMethod === method && match) {
            try {
                const result = await handler(D, url, body, {});
                return json(res, result.status, result.data);
            } catch (err) {
                logger.error(`WebUI API 错误 [${method} ${url.pathname}]: ${err.stack || err.message}`);
                return json(res, 500, { error: err.message || '服务器内部错误' });
            }
        }
    }

    return json(res, 404, { error: '接口不存在' });
}

// ---------------- 静态文件 ----------------

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function serveStatic(res, pathname) {
    let filePath = pathname === '/' ? '/index.html' : pathname;
    const resolved = path.normalize(path.join(PUBLIC_DIR, filePath));
    if (!resolved.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end();
    }

    fs.readFile(resolved, (err, data) => {
        if (err) {
            res.writeHead(404);
            return res.end('Not Found');
        }
        const ext = path.extname(resolved).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
}

// ---------------- 服务创建 ----------------

/**
 * 创建 Web UI HTTP 服务（依赖可注入，便于单元测试）
 * @param {Object} deps - 覆盖默认依赖（getCollection/callAI/password）
 * @returns {http.Server}
 */
function createWebUI(deps = {}) {
    const D = { ...defaultDeps, ...deps };
    if (deps.password) effectivePassword = deps.password;
    ensureLoggerSubscription();

    return http.createServer(async (req, res) => {
        const url = parseUrl(req);
        try {
            // SSE 日志流：独立鉴权（token 通过 query 传递，EventSource 无法带 header）
            if (url.pathname === '/api/logs/stream') {
                handleLogStream(req, res, url);
                return;
            }

            // 缩略图代理：<img> 无法携带 header，同样改用 query token 独立鉴权
            if (url.pathname === '/api/thumb') {
                await handleThumb(D, req, res, url);
                return;
            }

            if (!requireAuth(req, res, url)) return;

            if (url.pathname.startsWith('/api/')) {
                await handleApi(D, req, res, url);
            } else {
                serveStatic(res, url.pathname);
            }
        } catch (err) {
            logger.error(`WebUI 请求处理错误: ${err.message}`);
            if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
            else res.end();
        }
    });
}

/**
 * 启动 Web UI（默认端口 config.WEBUI_PORT）
 * @returns {http.Server}
 */
function startWebUI(port = config.WEBUI_PORT) {
    const server = createWebUI();
    server.listen(port, () => {
        logger.success(`Web UI 已启动: http://127.0.0.1:${port}`);
    });
    return server;
}

module.exports = {
    startWebUI,
    createWebUI,
    closeAllSseClients,
    sessions,
    getPassword,
    telegramGetFile,
    ALLOWED_COLLECTIONS,
    ALL_COLLECTIONS_KEY
};
