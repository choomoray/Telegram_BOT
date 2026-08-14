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
    password: null // 测试时可用固定密码
};

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

// ---------------- API 处理 ----------------

async function handleLogin(D, url, body) {
    const { password } = body;
    if (!password || password !== getPassword()) {
        return { status: 401, data: { error: '密码错误' } };
    }
    const token = createToken();
    sessions.set(token, { createdAt: Date.now() });
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
    const total = await col.countDocuments(filter);
    const items = await col.find(filter)
        .sort({ _id: -1 })
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
            return { status: 200, data: { type: 'insert', insertedId: result.insertedId } };
        }
        case 'update': {
            if (Object.keys(filter).length === 0) return { status: 400, data: { error: '修改操作 filter 不能为空（需精确定位）' } };
            if (Object.keys(data).length === 0) return { status: 400, data: { error: '修改操作缺少 data' } };
            delete data._id;
            const result = await D.getCollection(op.collection).updateOne(filter, { $set: data });
            logger.info(`WebUI 执行修改: ${op.collection} matched=${result.matchedCount} modified=${result.modifiedCount}`);
            return { status: 200, data: { type: 'update', matchedCount: result.matchedCount, modifiedCount: result.modifiedCount } };
        }
        case 'delete': {
            if (body.confirm !== true) return { status: 400, data: { error: '删除操作需要二次确认（confirm: true）' } };
            if (Object.keys(filter).length === 0) return { status: 400, data: { error: '删除操作 filter 不能为空（禁止全表删除）' } };
            const result = await D.getCollection(op.collection).deleteOne(filter);
            logger.info(`WebUI 执行删除: ${op.collection} deleted=${result.deletedCount}`);
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

    const content = await D.callAI([
        { role: 'system', content: system },
        { role: 'user', content: prompt }
    ]);

    const parsed = extractJson(content);
    if (!parsed || !isPlainObject(parsed.operation)) {
        logger.error(`AI 返回无法解析: ${String(content).slice(0, 300)}`);
        return { status: 502, data: { error: 'AI 返回格式无效，请重试' } };
    }

    logger.info(`WebUI AI 翻译: prompt="${prompt}" -> ${JSON.stringify(parsed.operation)}`);
    return { status: 200, data: { explain: parsed.explain || '', operation: parsed.operation } };
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

// 路由表：method + path 前缀
const ROUTES = [
    ['POST', /^\/api\/login$/, handleLogin],
    ['GET', /^\/api\/db\/collections$/, handleCollections],
    ['POST', /^\/api\/db\/query$/, handleDbQuery],
    ['POST', /^\/api\/db\/execute$/, handleDbExecute],
    ['POST', /^\/api\/ai\/plan$/, handleAiPlan]
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
    ALLOWED_COLLECTIONS,
    ALL_COLLECTIONS_KEY
};
