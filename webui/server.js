// webui/server.js
/**
 * Web UI 管理面板（零第三方依赖，Node 内置 http）
 *
 * 启动方式：node index.js webui
 * 默认地址：http://127.0.0.1:9700
 *
 * 功能：仪表盘统计、媒体库浏览/搜索/删除、用户查看/封禁/解封、
 *       标记记录、群组列表、操作日志、全局设置、搬运源列表
 *
 * 鉴权：登录密码（WEBUI_PASSWORD 环境变量，未设置则启动时随机生成并打印）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const { getCollection, COLLECTIONS } = require('../db/getCollection');
const usersDb = require('../db/users');
const settingsDb = require('../db/settings');
const { findMediaByFileUniqueId, deleteMediaByFileUniqueId } = require('../db/media');
const { findMessageByFileUniqueId, deleteMessageByFileUniqueId } = require('../db/message');
const { findGroupList, deleteGroupList, setGroupDelete } = require('../db/groupList');
const { getMarkRecords } = require('../handlers/callbacks/markCallback');

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL = 12 * 60 * 60 * 1000; // 会话有效期 12 小时

// 登录会话：token -> { createdAt }
const sessions = new Map();
// 实际生效的密码（未配置时随机生成）
let effectivePassword = config.WEBUI_PASSWORD || null;

// 默认依赖（测试时可注入 stub 覆盖）
const defaultDeps = {
    getCollection,
    banUser: usersDb.banUserFully,
    unbanUser: usersDb.unbanUserFully,
    getSettings: settingsDb.getSettings,
    updateSetting: settingsDb.updateSetting,
    findMediaByFileUniqueId,
    deleteMediaByFileUniqueId,
    findMessageByFileUniqueId,
    deleteMessageByFileUniqueId,
    findGroupList,
    deleteGroupList,
    setGroupDelete,
    getMarkRecords,
    password: null // 测试时可用固定密码
};

// ---------------- 工具 ----------------

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

// 校验会话中间件：除 /api/login 外的所有 /api/* 需要 Bearer token
function requireAuth(req, res, url) {
    if (url.pathname === '/api/login') return true;
    if (!url.pathname.startsWith('/api/')) return true; // 非 API 不校验
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!isTokenValid(token)) {
        json(res, 401, { error: '未授权或会话已过期' });
        return false;
    }
    return true;
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

async function handleDashboard(D, url) {
    const col = D.getCollection;
    const [
        groupCount, userCount, mediaCount, messageCount,
        markedGroups, bannedUsers, whiteUsers, logCount, transportCount
    ] = await Promise.all([
        col(COLLECTIONS.CHANNEL_GROUP).countDocuments(),
        col(COLLECTIONS.USERS).countDocuments(),
        col(COLLECTIONS.MEDIA).countDocuments(),
        col(COLLECTIONS.MESSAGE).countDocuments(),
        col(COLLECTIONS.GROUP_LIST).countDocuments({ mark: { $gt: 0 } }),
        col(COLLECTIONS.USERS).countDocuments({ state: 0 }),
        col(COLLECTIONS.USERS).countDocuments({ white: 1 }),
        col(COLLECTIONS.LOG).countDocuments(),
        col(COLLECTIONS.TRANSPORT).countDocuments()
    ]);

    // 媒体类型分布
    let typeDist = [];
    try {
        typeDist = await col(COLLECTIONS.MEDIA).aggregate([
            { $group: { _id: '$media_type', count: { $sum: 1 } } }
        ]).toArray();
    } catch (err) {
        logger.warn(`WebUI 媒体类型聚合失败: ${err.message}`);
    }

    // 今日收录（log 集合 MEDIA_SAVE 类型）
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMedia = await col(COLLECTIONS.LOG).countDocuments({ type: 1, time: { $gte: todayStart.getTime() } });

    return {
        status: 200,
        data: {
            groups: groupCount,
            users: userCount,
            media: mediaCount,
            messages: messageCount,
            markedGroups,
            bannedUsers,
            whiteUsers,
            logs: logCount,
            transports: transportCount,
            todayMedia,
            typeDist
        }
    };
}

async function handleMediaList(D, url) {
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize'), 10) || 20));
    const keyword = (url.searchParams.get('keyword') || '').trim();
    const type = url.searchParams.get('type') || '';
    const level = url.searchParams.get('level') || '';

    const filter = {};
    if (keyword) filter.text = { $regex: escapeRegExp(keyword), $options: 'i' };
    if (type) filter.media_type = type;
    if (level) filter.level = level;

    const col = D.getCollection(COLLECTIONS.MESSAGE);
    const total = await col.countDocuments(filter);
    const items = await col.find(filter)
        .sort({ _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();

    return { status: 200, data: { total, page, pageSize, items } };
}

async function handleMediaDelete(D, url, body, params) {
    const fileUniqueId = params.fileUniqueId;
    if (!fileUniqueId) return { status: 400, data: { error: '缺少 fileUniqueId' } };

    const mediaDoc = await D.findMediaByFileUniqueId(fileUniqueId);
    if (!mediaDoc) return { status: 404, data: { error: '媒体不存在' } };

    const groupId = mediaDoc.group_id;
    const groupDoc = await D.findGroupList(groupId);
    const messageDoc = await D.findMessageByFileUniqueId(fileUniqueId);
    const hadText = !!messageDoc;
    const col = D.getCollection;

    if (!groupDoc) {
        await D.deleteMediaByFileUniqueId(fileUniqueId);
        if (hadText) await D.deleteMessageByFileUniqueId(fileUniqueId);
    } else if (groupDoc.is_group === 1) {
        // 唯一媒体，删除整个组
        await D.deleteMediaByFileUniqueId(fileUniqueId);
        if (hadText) await D.deleteMessageByFileUniqueId(fileUniqueId);
        await D.deleteGroupList(groupId);
    } else {
        // 组内还有其他媒体，仅删除当前媒体并减少计数
        await D.deleteMediaByFileUniqueId(fileUniqueId);
        if (hadText) await D.deleteMessageByFileUniqueId(fileUniqueId);
        await col(COLLECTIONS.GROUP_LIST).updateOne({ group_id: groupId }, { $inc: { is_group: -1 } });
        const updatedGroup = await D.findGroupList(groupId);
        if (updatedGroup && updatedGroup.is_group === 0) {
            await D.deleteGroupList(groupId);
        } else if (hadText) {
            const other = await col(COLLECTIONS.MESSAGE).countDocuments({ group_id: groupId });
            if (other === 0) await D.setGroupDelete(groupId, Date.now());
        }
    }

    logger.info(`WebUI 删除媒体: file_unique_id=${fileUniqueId}, group_id=${groupId}`);
    return { status: 200, data: { ok: true } };
}

async function handleUserList(D, url) {
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize'), 10) || 20));
    const keyword = (url.searchParams.get('keyword') || '').trim();

    const filter = {};
    if (keyword) {
        if (/^\d+$/.test(keyword)) {
            filter.id = Number(keyword);
        } else {
            filter.name = { $regex: escapeRegExp(keyword), $options: 'i' };
        }
    }

    const col = D.getCollection(COLLECTIONS.USERS);
    const total = await col.countDocuments(filter);
    const items = await col.find(filter)
        .sort({ last_seen: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();

    return { status: 200, data: { total, page, pageSize, items } };
}

async function handleUserBan(D, url, body) {
    const userId = parseInt(body.userId, 10);
    if (!userId) return { status: 400, data: { error: '缺少 userId' } };
    const result = await D.banUser(userId, 'webui');
    logger.info(`WebUI 封禁用户: ${userId}`);
    return { status: 200, data: result };
}

async function handleUserUnban(D, url, body) {
    const userId = parseInt(body.userId, 10);
    if (!userId) return { status: 400, data: { error: '缺少 userId' } };
    const result = await D.unbanUser(userId);
    logger.info(`WebUI 解封用户: ${userId}`);
    return { status: 200, data: result };
}

async function handleGroupList(D, url) {
    const col = D.getCollection(COLLECTIONS.CHANNEL_GROUP);
    const items = await col.find({}).sort({ id: 1 }).toArray();
    return { status: 200, data: { total: items.length, items } };
}

async function handleMarkRecords(D, url) {
    const records = await D.getMarkRecords();
    return { status: 200, data: { total: records.length, items: records } };
}

async function handleLogList(D, url) {
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize'), 10) || 30));
    const type = url.searchParams.get('type') || '';
    const filter = {};
    if (type && /^\d+$/.test(type)) filter.type = parseInt(type, 10);

    const col = D.getCollection(COLLECTIONS.LOG);
    const total = await col.countDocuments(filter);
    const items = await col.find(filter)
        .sort({ time: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();

    return { status: 200, data: { total, page, pageSize, items } };
}

async function handleSettingsGet(D) {
    const settings = await D.getSettings();
    return { status: 200, data: settings };
}

async function handleSettingsUpdate(D, url, body) {
    const { key, value } = body;
    if (!key) return { status: 400, data: { error: '缺少 key' } };
    try {
        const ok = await D.updateSetting({}, key, value);
        if (!ok) return { status: 400, data: { error: `更新设置失败（不允许的键: ${key}）` } };
        logger.info(`WebUI 更新设置: ${key}=${JSON.stringify(value)}`);
        return { status: 200, data: { ok: true } };
    } catch (err) {
        return { status: 400, data: { error: err.message } };
    }
}

async function handleTransportList(D) {
    const col = D.getCollection(COLLECTIONS.TRANSPORT);
    const items = await col.find({}).sort({ _id: -1 }).toArray();
    return { status: 200, data: { total: items.length, items } };
}

// 路由表：method + path 前缀
const ROUTES = [
    ['POST', /^\/api\/login$/, handleLogin],
    ['GET', /^\/api\/dashboard$/, handleDashboard],
    ['GET', /^\/api\/media$/, handleMediaList],
    ['DELETE', /^\/api\/media\/([^/]+)$/, handleMediaDelete],
    ['GET', /^\/api\/users$/, handleUserList],
    ['POST', /^\/api\/users\/ban$/, handleUserBan],
    ['POST', /^\/api\/users\/unban$/, handleUserUnban],
    ['GET', /^\/api\/groups$/, handleGroupList],
    ['GET', /^\/api\/mark-records$/, handleMarkRecords],
    ['GET', /^\/api\/logs$/, handleLogList],
    ['GET', /^\/api\/settings$/, handleSettingsGet],
    ['POST', /^\/api\/settings$/, handleSettingsUpdate],
    ['GET', /^\/api\/transports$/, handleTransportList]
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
                const result = await handler(D, url, body, { fileUniqueId: match[1] ? decodeURIComponent(match[1]) : null });
                return json(res, result.status, result.data);
            } catch (err) {
                logger.error(`WebUI API 错误 [${method} ${url.pathname}]: ${err.stack || err.message}`);
                return json(res, 500, { error: '服务器内部错误' });
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
 * @param {Object} deps - 覆盖默认依赖（getCollection/banUser/...）
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
    getPassword
};
