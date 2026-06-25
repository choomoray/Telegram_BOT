// utils/queryCache.js
const crypto = require('crypto');

const sessionStore = new Map();
const SESSION_TTL = 10 * 60 * 1000;
const MAX_SESSIONS = 1000;

setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessionStore.entries()) {
        if (now - session.createdAt > SESSION_TTL) {
            sessionStore.delete(sessionId);
        }
    }
    // 超过上限时删除最旧的 20%
    if (sessionStore.size > MAX_SESSIONS) {
        const entries = [...sessionStore.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
        const toDelete = Math.floor(MAX_SESSIONS * 0.2);
        for (let i = 0; i < toDelete && i < entries.length; i++) {
            sessionStore.delete(entries[i][0]);
        }
    }
}, 60 * 1000);

function generateSessionId() {
    return crypto.randomBytes(4).toString('hex');
}

/**
 * 创建查询会话
 * 初始模式：'fold'（折叠，仅显示翻页按钮）
 */
function createSession(userId, originalText, results, total, keyword, queryParams = {}) {
    const sessionId = generateSessionId();
    const pageSize = queryParams.pageSize || 15;
    const session = {
        userId,
        originalText,
        results,
        total,
        pageSize,
        keyword,
        queryParams,
        mode: 'fold',          // 默认折叠
        createdAt: Date.now()
    };
    sessionStore.set(sessionId, session);
    return sessionId;
}

function getSession(sessionId) {
    const session = sessionStore.get(sessionId);
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_TTL) {
        sessionStore.delete(sessionId);
        return null;
    }
    return session;
}

function deleteSession(sessionId) {
    sessionStore.delete(sessionId);
}

function getPageResults(sessionId, page) {
    const session = getSession(sessionId);
    if (!session) return null;

    const { results, pageSize } = session;
    const total = results.length;
    const totalPages = Math.ceil(total / pageSize);

    page = Math.max(1, Math.min(page, totalPages));

    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pageResults = results.slice(start, end);

    return {
        pageResults,
        totalPages,
        currentPage: page,
        total
    };
}

function setSessionMode(sessionId, mode) {
    const session = getSession(sessionId);
    if (session) {
        session.mode = mode;
    }
}

module.exports = {
    createSession,
    getSession,
    deleteSession,
    getPageResults,
    setSessionMode
};