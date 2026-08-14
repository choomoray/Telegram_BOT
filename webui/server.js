// webui/server.js
/**
 * Web UI 管理面板（零第三方依赖，Node 内置 http）
 *
 * 启动方式：node index.js webui
 * 默认地址：http://127.0.0.1:9700
 *
 * 功能：左侧实时数据浏览（集合切换 / MongoDB filter 查询 / AI 查询翻译），
 *       右侧数据库操作（新增 / 修改 / 删除，删除需二次确认）
 *
 * AI 辅助：调用 DeepSeek 将自然语言翻译为 MongoDB 查询条件（filter），
 *          结果显示在查询栏供用户编辑后手动执行，AI 不直接操作数据库。
 *
 * 鉴权：登录密码（WEBUI_PASSWORD 环境变量，未设置则启动时随机生成并打印）
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

// 登录会话：token -> { createdAt }
const sessions = new Map();
// 实际生效的密码（未配置时随机生成）
let effectivePassword = config.WEBUI_PASSWORD || null;

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

async function handleDbQuery(D, url, body) {
    assertCollection(body.collection);
    const filter = isPlainObject(body.filter) ? sanitizeFilter(body.filter) : {};
    const sort = isPlainObject(body.sort) ? body.sort : { _id: -1 };
    const page = Math.max(1, parseInt(body.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(body.pageSize, 10) || 20));

    const col = D.getCollection(body.collection);
    const total = await col.countDocuments(filter);
    const items = await col.find(filter)
        .sort(sort)
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();

    return { status: 200, data: { total, page, pageSize, items } };
}

async function handleDbInsert(D, url, body) {
    assertCollection(body.collection);
    const data = body.data;
    if (!isPlainObject(data)) return { status: 400, data: { error: 'data 必须是 JSON 对象' } };
    delete data._id; // 不允许手动指定 _id

    const result = await D.getCollection(body.collection).insertOne(data);
    logger.info(`WebUI 新增文档: ${body.collection} -> ${result.insertedId}`);
    return { status: 200, data: { ok: true, insertedId: result.insertedId } };
}

async function handleDbUpdate(D, url, body) {
    assertCollection(body.collection);
    const filter = body.filter;
    const data = body.data;
    if (!isPlainObject(filter) || Object.keys(filter).length === 0) {
        return { status: 400, data: { error: 'filter 不能为空（需精确定位文档）' } };
    }
    if (!isPlainObject(data)) return { status: 400, data: { error: 'data 必须是 JSON 对象' } };
    delete data._id; // 不允许修改 _id

    const result = await D.getCollection(body.collection).updateOne(sanitizeFilter(filter), { $set: data });
    logger.info(`WebUI 更新文档: ${body.collection} matched=${result.matchedCount} modified=${result.modifiedCount}`);
    return { status: 200, data: { ok: true, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount } };
}

async function handleDbDelete(D, url, body) {
    assertCollection(body.collection);
    if (body.confirm !== true) {
        return { status: 400, data: { error: '删除操作需要二次确认（confirm: true）' } };
    }
    const filter = body.filter;
    if (!isPlainObject(filter) || Object.keys(filter).length === 0) {
        return { status: 400, data: { error: 'filter 不能为空（禁止无条件下删除）' } };
    }

    const result = await D.getCollection(body.collection).deleteOne(sanitizeFilter(filter));
    logger.info(`WebUI 删除文档: ${body.collection} deleted=${result.deletedCount}`);
    return { status: 200, data: { ok: true, deletedCount: result.deletedCount } };
}

async function handleAiQuery(D, url, body) {
    const { collection, prompt } = body;
    if (!ALLOWED_COLLECTIONS.has(collection)) {
        return { status: 400, data: { error: `不允许的集合: ${collection}` } };
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
        return { status: 400, data: { error: '缺少 prompt（自然语言查询描述）' } };
    }

    let guide = '';
    try {
        guide = await fs.promises.readFile(path.join(__dirname, 'db-guide.md'), 'utf8');
    } catch (err) {
        logger.error(`读取 db-guide.md 失败: ${err.message}`);
    }

    const system = `${guide}\n\n用户当前查看的集合是：${collection}。请根据用户需求生成针对该集合的查询条件（filter）。`;
    const content = await D.callAI([
        { role: 'system', content: system },
        { role: 'user', content: prompt }
    ]);

    const parsed = extractJson(content);
    if (!parsed || !isPlainObject(parsed.filter)) {
        logger.error(`AI 返回无法解析: ${String(content).slice(0, 300)}`);
        return { status: 502, data: { error: 'AI 返回格式无效，请重试' } };
    }

    logger.info(`WebUI AI 查询翻译: collection=${collection}, prompt="${prompt}", filter=${JSON.stringify(parsed.filter)}`);
    return { status: 200, data: { explain: parsed.explain || '', filter: parsed.filter } };
}

// 路由表：method + path 前缀
const ROUTES = [
    ['POST', /^\/api\/login$/, handleLogin],
    ['GET', /^\/api\/db\/collections$/, handleCollections],
    ['POST', /^\/api\/db\/query$/, handleDbQuery],
    ['POST', /^\/api\/db\/insert$/, handleDbInsert],
    ['POST', /^\/api\/db\/update$/, handleDbUpdate],
    ['POST', /^\/api\/db\/delete$/, handleDbDelete],
    ['POST', /^\/api\/ai\/query$/, handleAiQuery]
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

    return http.createServer(async (req, res) => {
        const url = parseUrl(req);
        try {
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
    sessions,
    getPassword,
    ALLOWED_COLLECTIONS
};
