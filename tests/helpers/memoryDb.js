// tests/helpers/memoryDb.js
/**
 * 测试用内存 MongoDB + 模块打桩工具
 *
 * 用途：在不连接真实数据库、不调用 Telegram API 的前提下，驱动写库链路
 * （群组自动收录 / 频道转发兜底 / /send / 消息回复 / 编辑）并断言落库结果。
 *
 * 用法（必须在 require 被测模块之前完成打桩）：
 *   const { installMemoryDb, installBotStub, installLoggerStub, relaxTimers } = require('./helpers/memoryDb');
 *   relaxTimers();
 *   installMemoryDb(root);
 *   installBotStub(root);
 *   installLoggerStub(root);
 *   const { handleGroupMessage } = require('../handlers/groupMessageHandlers');
 */

const store = new Map(); // 集合名 -> 文档数组

// ---------------- 过滤/更新求值（覆盖本项目用到的操作符） ----------------

function getPath(obj, key) {
    return key.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}

function setPath(obj, key, value) {
    const parts = key.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}

function unsetPath(obj, key) {
    const parts = key.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) return;
        cur = cur[parts[i]];
    }
    delete cur[parts[parts.length - 1]];
}

function matchValue(value, cond) {
    // Mongo 语义：{ tags: 'JK' } 命中 tags 数组包含 JK 的文档
    if (Array.isArray(value) && (cond === null || typeof cond !== 'object')) {
        return value.some(v => v === cond);
    }
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        for (const [op, arg] of Object.entries(cond)) {
            switch (op) {
                case '$eq': if (value !== arg) return false; break;
                case '$ne': if (value === arg) return false; break;
                case '$in': if (!Array.isArray(arg) || !arg.includes(value)) return false; break;
                case '$gt': if (!(value > arg)) return false; break;
                case '$gte': if (!(value >= arg)) return false; break;
                case '$lt': if (!(value < arg)) return false; break;
                case '$lte': if (!(value <= arg)) return false; break;
                case '$exists': if ((value !== undefined) !== !!arg) return false; break;
                case '$regex': {
                    const re = arg instanceof RegExp ? arg : new RegExp(arg, cond.$options || '');
                    if (!re.test(String(value ?? ''))) return false;
                    break;
                }
                case '$options': break; // 仅作为 $regex 的修饰符
                default: return false;
            }
        }
        return true;
    }
    return value === cond;
}

function matchFilter(doc, filter) {
    for (const [key, cond] of Object.entries(filter || {})) {
        if (key === '$or') {
            if (!cond.some(f => matchFilter(doc, f))) return false;
            continue;
        }
        if (key === '$and') {
            if (!cond.every(f => matchFilter(doc, f))) return false;
            continue;
        }
        if (!matchValue(getPath(doc, key), cond)) return false;
    }
    return true;
}

function applyUpdate(doc, update) {
    if (Array.isArray(update)) {
        // 聚合管道（tagUsed 的 count = max(0, count + delta)）
        const set = update[0].$set || {};
        for (const [k, expr] of Object.entries(set)) {
            const add = expr.$max[1].$add;
            // $add[0] 可能是 '$count'（字符串）或 { $ifNull: ['$count', 0] }（tagUsed 实际写法）
            const operand = add[0];
            const field = typeof operand === 'string'
                ? operand.replace(/^\$/, '')
                : (operand && Array.isArray(operand.$ifNull) ? String(operand.$ifNull[0]).replace(/^\$/, '') : null);
            const cur = field ? (getPath(doc, field) || 0) : 0;
            setPath(doc, k, Math.max(expr.$max[0], cur + add[1]));
        }
        return;
    }
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) setPath(doc, k, v);
    if (update.$setOnInsert) for (const [k, v] of Object.entries(update.$setOnInsert)) if (getPath(doc, k) === undefined) setPath(doc, k, v);
    if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) setPath(doc, k, (getPath(doc, k) || 0) + v);
    if (update.$addToSet) for (const [k, v] of Object.entries(update.$addToSet)) {
        const arr = getPath(doc, k) || [];
        if (!arr.includes(v)) arr.push(v);
        setPath(doc, k, arr);
    }
    if (update.$pull) for (const [k, v] of Object.entries(update.$pull)) {
        setPath(doc, k, (getPath(doc, k) || []).filter(x => x !== v));
    }
    if (update.$unset) for (const k of Object.keys(update.$unset)) unsetPath(doc, k);
}

function makeCursor(docs) {
    let list = [...docs];
    const cursor = {
        sort(spec) {
            const keys = Object.entries(spec || {});
            list.sort((a, b) => {
                for (const [k, dir] of keys) {
                    const av = getPath(a, k), bv = getPath(b, k);
                    if (av === bv) continue;
                    if (av === undefined) return 1;
                    if (bv === undefined) return -1;
                    return (av > bv ? 1 : -1) * (dir < 0 ? -1 : 1);
                }
                return 0;
            });
            return cursor;
        },
        limit(n) { list = list.slice(0, n); return cursor; },
        skip(n) { list = list.slice(n); return cursor; },
        async toArray() { return list; }
    };
    return cursor;
}

// ---------------- 集合实现 ----------------

const collections = new Map();

function fakeCollection(name) {
    if (!collections.has(name)) {
        if (!store.has(name)) store.set(name, []);
        const col = {
            async insertOne(doc) {
                // 模拟 media/message 的 file_unique_id 唯一索引
                if (doc.file_unique_id !== undefined &&
                    store.get(name).some(d => d.file_unique_id === doc.file_unique_id)) {
                    const err = new Error('duplicate key error');
                    err.code = 11000;
                    throw err;
                }
                const _id = `${name}-${store.get(name).length + 1}`;
                store.get(name).push({ _id, ...doc });
                return { insertedId: _id };
            },
            async insertMany(docs) { for (const d of docs) await col.insertOne(d); return { insertedCount: docs.length }; },
            find(filter) { return makeCursor(store.get(name).filter(d => matchFilter(d, filter))); },
            async findOne(filter, opts) {
                let docs = store.get(name).filter(d => matchFilter(d, filter));
                if (opts && opts.sort) docs = await makeCursor(docs).sort(opts.sort).toArray();
                return docs[0] || null;
            },
            async updateOne(filter, update, opts) {
                const docs = store.get(name);
                const found = docs.find(d => matchFilter(d, filter));
                if (!found) {
                    if (opts && opts.upsert) {
                        const doc = {};
                        for (const [k, v] of Object.entries(filter)) if (!k.startsWith('$')) setPath(doc, k, v);
                        applyUpdate(doc, update);
                        docs.push(doc);
                        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
                    }
                    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
                }
                applyUpdate(found, update);
                return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
            },
            async updateMany(filter, update) {
                let n = 0;
                for (const d of store.get(name)) if (matchFilter(d, filter)) { applyUpdate(d, update); n++; }
                return { matchedCount: n, modifiedCount: n };
            },
            async deleteOne(filter) {
                const docs = store.get(name);
                const i = docs.findIndex(d => matchFilter(d, filter));
                if (i >= 0) { docs.splice(i, 1); return { deletedCount: 1 }; }
                return { deletedCount: 0 };
            },
            async deleteMany(filter) {
                const docs = store.get(name);
                const kept = docs.filter(d => !matchFilter(d, filter));
                const deletedCount = docs.length - kept.length;
                store.set(name, kept);
                return { deletedCount };
            },
            async countDocuments(filter) { return store.get(name).filter(d => matchFilter(d, filter)).length; },
            async distinct(key, filter) {
                const set = new Set();
                for (const d of store.get(name)) if (matchFilter(d, filter)) set.add(getPath(d, key));
                return [...set];
            }
        };
        collections.set(name, col);
    }
    return collections.get(name);
}

// ---------------- 模块打桩 ----------------

function stubModule(absPath, exportsObj) {
    require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports: exportsObj };
}

/** 让 db/getCollection 返回内存集合（COLLECTIONS 用真实常量表） */
function installMemoryDb(rootDir) {
    const path = require('path');
    const COLLECTIONS = require(path.join(rootDir, 'db', 'collections'));
    stubModule(path.join(rootDir, 'db', 'getCollection.js'), { getCollection: fakeCollection, COLLECTIONS });
}

const realSetTimeout = setTimeout;
const realSetInterval = setInterval;

/**
 * 让模块级定时器（清理 interval、60 秒延迟删除提示消息）不再阻塞测试进程退出。
 * 测试自身等待请用本模块导出的 sleep（基于真实 ref 的定时器）。
 */
function relaxTimers() {
    global.setInterval = () => ({ unref() { }, close() { } });
    global.setTimeout = (...args) => {
        const timer = realSetTimeout(...args);
        if (timer && typeof timer.unref === 'function') timer.unref();
        return timer;
    };
}

/** 真实定时器 sleep（不受 relaxTimers 影响，能保持事件循环） */
function sleep(ms) {
    return new Promise(resolve => realSetTimeout(resolve, ms));
}

/** 安装 Telegram bot 桩，返回 { bot, sent }（sent 记录已"发出"的消息） */
function installBotStub(rootDir) {
    const path = require('path');
    let nextMessageId = 5000;
    const sent = [];
    function makeSentMessage(chatId, media) {
        const message_id = ++nextMessageId;
        const doc = { message_id, chat: { id: chatId }, caption: media.caption };
        const fileId = `sent-${media.media}`;
        if (media.type === 'photo') doc.photo = [{ file_id: fileId, file_unique_id: fileId }];
        if (media.type === 'video') doc.video = { file_id: fileId, file_unique_id: fileId, duration: media.duration };
        if (media.type === 'audio') doc.audio = { file_id: fileId, file_unique_id: fileId };
        if (media.type === 'document') doc.document = { file_id: fileId, file_unique_id: fileId };
        sent.push(doc);
        return doc;
    }
    const bot = {
        async sendMessage(chatId, text, opts) { return { message_id: ++nextMessageId, chat: { id: chatId }, text, ...(opts || {}) }; },
        async editMessageText() { return true; },
        async editMessageCaption() { return true; },
        async deleteMessage() { return true; },
        async answerCallbackQuery() { return true; },
        async sendMediaGroup(chatId, media) { return media.map(m => makeSentMessage(chatId, m)); },
        async sendPhoto(chatId, fileId, opts) { return makeSentMessage(chatId, { type: 'photo', media: fileId, caption: opts && opts.caption }); },
        async sendVideo(chatId, fileId, opts) { return makeSentMessage(chatId, { type: 'video', media: fileId, caption: opts && opts.caption }); },
        async sendAudio(chatId, fileId, opts) { return makeSentMessage(chatId, { type: 'audio', media: fileId, caption: opts && opts.caption }); },
        async sendDocument(chatId, fileId, opts) { return makeSentMessage(chatId, { type: 'document', media: fileId, caption: opts && opts.caption }); },
        on() { }, startPolling() { }, stopPolling() { }, startBotPolling() { }
    };
    stubModule(path.join(rootDir, 'bot.js'), bot);
    return { bot, sent };
}

/** 安装静默 logger 桩（避免测试输出与真实日志文件写入） */
function installLoggerStub(rootDir) {
    const path = require('path');
    stubModule(path.join(rootDir, 'logger.js'), {
        info() { }, warn() { }, error() { }, success() { }, debug() { },
        initTestLog: async () => { }, flushLogs: async () => { },
        // Web UI 的 SSE 日志流通过 onLog 订阅；桩里返回取消订阅函数即可
        onLog: () => () => { }
    });
}

/** 清空内存数据（每个用例之间调用） */
function resetStore() {
    for (const key of [...store.keys()]) store.set(key, []);
    for (const key of [...collections.keys()]) collections.delete(key);
}

module.exports = {
    store,
    fakeCollection,
    stubModule,
    installMemoryDb,
    installBotStub,
    installLoggerStub,
    relaxTimers,
    sleep,
    resetStore
};
