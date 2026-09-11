// tests/webui.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ---------------------------------------------------------------------------
// 模块级桩：把 db/getCollection 指向「当前用例的内存集合」
// 必须在 require('../webui/server') 之前装好——server 会连带加载
// handlers/modes/editMode → db/media / db/groupList / utils/opLog 等模块，
// 这些模块在加载时就解构了 getCollection，之后再替换 require.cache 不再生效。
// 这样「注入给 server 的 getCollection」与「db/* 内部使用的 getCollection」
// 看到的是同一份内存数据，控制台写操作才能被离线测试。
// ---------------------------------------------------------------------------
const REAL_COLLECTIONS = require('../db/collections'); // 直接导出集合名映射
const GET_COLLECTION_PATH = path.join(__dirname, '..', 'db', 'getCollection.js');
let activeStore = null; // 当前用例的内存集合：name -> 假集合
require.cache[GET_COLLECTION_PATH] = {
    id: GET_COLLECTION_PATH,
    filename: GET_COLLECTION_PATH,
    loaded: true,
    exports: {
        getCollection: (name) => {
            const store = activeStore || new Map();
            if (!store.has(name)) store.set(name, makeMemoryCol([]));
            return store.get(name);
        },
        COLLECTIONS: REAL_COLLECTIONS
    }
};

const { createWebUI } = require('../webui/server');

const TEST_PASSWORD = 'test-password';

// ---------------- 假数据库依赖 ----------------

function makeFakeCol() {
    const calls = { insert: [], update: [], delete: [], find: [], sorts: null };
    const col = {
        calls,
        countDocuments: async () => 42,
        find: (filter) => {
            calls.find.push(filter);
            const chain = () => ({
                sort: (s) => { calls.sorts = s; return chain(); },
                skip: chain,
                limit: chain,
                toArray: async () => [{ _id: 'abc123', name: '示例文档' }]
            });
            return chain();
        },
        insertOne: async (data) => { calls.insert.push(data); return { insertedId: 'newid123' }; },
        updateOne: async (filter, update) => { calls.update.push({ filter, update }); return { matchedCount: 1, modifiedCount: 1 }; },
        deleteOne: async (filter) => { calls.delete.push(filter); return { deletedCount: 1 }; }
    };
    return col;
}

function makeStubDeps() {
    const fakeCol = makeFakeCol();
    return {
        fakeCol,
        getCollection: () => fakeCol,
        callAI: async (messages) => {
            const hasSelected = JSON.stringify(messages).includes('用户当前已选中文档');
            return JSON.stringify({
                explain: hasSelected ? '针对选中文档的操作' : '测试操作',
                operation: { action: 'query', collection: 'users', filter: { white: 1 }, limit: 10 }
            });
        },
        password: TEST_PASSWORD
    };
}

// ---------------- 服务生命周期 ----------------

let server;
let base;

before(async () => {
    server = createWebUI(makeStubDeps());
    await new Promise(resolve => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise(resolve => server.close(resolve));
});

async function req(path, options = {}) {
    const res = await fetch(base + path, options);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
}

async function login() {
    const r = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${r.body.token}` };
}

async function withServer(deps, fn) {
    const s = createWebUI(deps);
    await new Promise(resolve => s.listen(0, resolve));
    const b = `http://127.0.0.1:${s.address().port}`;
    try {
        const auth = await (async () => {
            const r = await fetch(b + '/api/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: TEST_PASSWORD })
            }).then(r => r.json());
            return { 'Content-Type': 'application/json', Authorization: `Bearer ${r.token}` };
        })();
        return await fn(b, auth, deps);
    } finally {
        await new Promise(resolve => s.close(resolve));
    }
}

// ---------------- 登录与鉴权 ----------------

test('错误密码登录返回 401', async () => {
    const r = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' })
    });
    assert.strictEqual(r.status, 401);
});

test('正确密码登录返回 token', async () => {
    const r = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.token);
});

test('未登录访问 API 返回 401', async () => {
    assert.strictEqual((await req('/api/db/collections')).status, 401);
});

test('获取集合白名单', async () => {
    const auth = await login();
    const r = await req('/api/db/collections', { headers: auth });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.collections.includes('users'));
    assert.ok(r.body.collections.includes('group_list'));
});

// ---------------- 查询（指定集合 / 全部集合） ----------------

test('查询指定集合返回分页结构', async () => {
    const auth = await login();
    const r = await req('/api/db/query', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ collection: 'users', filter: { white: 1 }, page: 1, pageSize: 20 })
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.all, false);
    assert.strictEqual(r.body.collection, 'users');
    assert.strictEqual(r.body.total, 42);
    assert.strictEqual(r.body.items[0].name, '示例文档');
});

test('查询支持自定义排序（sort 参数传递给数据库）', async () => {
    await withServer(makeStubDeps(), async (b, auth, deps) => {
        const r = await fetch(b + '/api/db/query', {
            method: 'POST', headers: auth,
            body: JSON.stringify({ collection: 'users', filter: {}, sort: { _id: 1 }, page: 1, pageSize: 20 })
        });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(deps.fakeCol.calls.sorts, { _id: 1 });
    });
});

test('查询全部集合返回分组数据', async () => {
    const auth = await login();
    const r = await req('/api/db/query', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ collection: '__all__', filter: {} })
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.all, true);
    assert.ok(Array.isArray(r.body.groups));
    const usersGroup = r.body.groups.find(g => g.collection === 'users');
    assert.ok(usersGroup);
    assert.strictEqual(usersGroup.total, 42);
    assert.strictEqual(usersGroup.items.length, 1);
});

test('非法集合被拒绝', async () => {
    const auth = await login();
    const r = await req('/api/db/query', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ collection: 'system.users', filter: {} })
    });
    assert.strictEqual(r.status, 500);
    assert.ok(r.body.error.includes('不允许的集合'));
});

// ---------------- 执行操作（execute） ----------------

test('执行 query 返回结果', async () => {
    const auth = await login();
    const r = await req('/api/db/execute', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ operation: { action: 'query', collection: 'users', filter: { white: 1 }, limit: 10 } })
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.type, 'query');
    assert.strictEqual(r.body.total, 42);
    assert.strictEqual(r.body.items.length, 1);
});

test('执行 insert 调用 insertOne 并移除 _id', async () => {
    await withServer(makeStubDeps(), async (b, auth, deps) => {
        const r = await fetch(b + '/api/db/execute', {
            method: 'POST', headers: auth,
            body: JSON.stringify({ operation: { action: 'insert', collection: 'users', data: { id: 999, name: '新用户', _id: 'x' } } })
        }).then(r => r.json());
        assert.strictEqual(r.type, 'insert');
        assert.ok(!('_id' in deps.fakeCol.calls.insert[0]));
    });
});

test('执行 update：空 filter 返回 400，合法调用 $set', async () => {
    const auth = await login();
    const bad = await req('/api/db/execute', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ operation: { action: 'update', collection: 'users', filter: {}, data: { white: 1 } } })
    });
    assert.strictEqual(bad.status, 400);

    await withServer(makeStubDeps(), async (b, auth2, deps) => {
        const r = await fetch(b + '/api/db/execute', {
            method: 'POST', headers: auth2,
            body: JSON.stringify({ operation: { action: 'update', collection: 'users', filter: { id: 123 }, data: { white: 1 } } })
        }).then(r => r.json());
        assert.strictEqual(r.type, 'update');
        assert.deepStrictEqual(deps.fakeCol.calls.update[0], { filter: { id: 123 }, update: { $set: { white: 1 } } });
    });
});

test('执行 delete：无 confirm / 空 filter 均被拒绝', async () => {
    const auth = await login();
    const noConfirm = await req('/api/db/execute', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ operation: { action: 'delete', collection: 'users', filter: { id: 1 } } })
    });
    assert.strictEqual(noConfirm.status, 400);
    assert.ok(noConfirm.body.error.includes('二次确认'));

    const emptyFilter = await req('/api/db/execute', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ operation: { action: 'delete', collection: 'users', filter: {} }, confirm: true })
    });
    assert.strictEqual(emptyFilter.status, 400);
    assert.ok(emptyFilter.body.error.includes('禁止全表删除'));
});

test('执行 delete：confirm + filter 时调用 deleteOne', async () => {
    await withServer(makeStubDeps(), async (b, auth, deps) => {
        const r = await fetch(b + '/api/db/execute', {
            method: 'POST', headers: auth,
            body: JSON.stringify({ operation: { action: 'delete', collection: 'users', filter: { id: 123 } }, confirm: true })
        }).then(r => r.json());
        assert.strictEqual(r.type, 'delete');
        assert.strictEqual(r.deletedCount, 1);
        assert.deepStrictEqual(deps.fakeCol.calls.delete[0], { id: 123 });
    });
});

test('执行非法操作类型返回 400', async () => {
    const auth = await login();
    const r = await req('/api/db/execute', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ operation: { action: 'drop', collection: 'users' } })
    });
    assert.strictEqual(r.status, 400);
});

// ---------------- AI 翻译 ----------------

test('AI 翻译返回操作计划且不执行数据库', async () => {
    await withServer(makeStubDeps(), async (b, auth, deps) => {
        const r = await fetch(b + '/api/ai/plan', {
            method: 'POST', headers: auth,
            body: JSON.stringify({ prompt: '查一下白名单用户' })
        }).then(r => r.json());
        assert.strictEqual(r.explain, '测试操作');
        assert.strictEqual(r.operation.action, 'query');
        assert.strictEqual(r.operation.collection, 'users');
        // AI 只翻译不执行
        assert.strictEqual(deps.fakeCol.calls.find.length, 0);
        assert.strictEqual(deps.fakeCol.calls.insert.length, 0);
    });
});

test('AI 翻译携带选中文档信息', async () => {
    const deps = makeStubDeps();
    const seenMessages = [];
    deps.callAI = async (messages) => { seenMessages.push(messages); return JSON.stringify({ explain: 'x', operation: { action: 'delete', collection: 'users', filter: { _id: 'abc123' } } }); };
    await withServer(deps, async (b, auth) => {
        const r = await fetch(b + '/api/ai/plan', {
            method: 'POST', headers: auth,
            body: JSON.stringify({
                prompt: '把这条删掉',
                selected: { collection: 'users', doc: { _id: 'abc123', name: '张三' } }
            })
        }).then(r => r.json());
        assert.strictEqual(r.operation.filter._id, 'abc123');
        assert.ok(seenMessages[0].some(m => m.content.includes('张三')), 'AI 应收到选中文档内容');
    });
});

test('AI 翻译缺少 prompt 返回 400', async () => {
    const auth = await login();
    const r = await req('/api/ai/plan', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ prompt: '' })
    });
    assert.strictEqual(r.status, 400);
});

test('AI 返回无效格式时返回 502', async () => {
    const deps = makeStubDeps();
    deps.callAI = async () => '这不是 JSON';
    await withServer(deps, async (b, auth) => {
        const r = await fetch(b + '/api/ai/plan', {
            method: 'POST', headers: auth,
            body: JSON.stringify({ prompt: '查询' })
        });
        assert.strictEqual(r.status, 502);
    });
});

// ---------------- SSE 日志流 ----------------

test('SSE 日志流返回 text/event-stream', async () => {
    const r = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
        const res = await fetch(`${base}/api/logs/stream?token=${encodeURIComponent(r.body.token)}`, { signal: controller.signal });
        assert.strictEqual(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/event-stream/);
    } finally {
        clearTimeout(timer);
    }
});

test('SSE 无 token 返回 401', async () => {
    const res = await fetch(base + '/api/logs/stream', { signal: AbortSignal.timeout(800) });
    assert.strictEqual(res.status, 401);
});

test('优雅关闭：SSE 长连接存在时 closeAllSseClients 后 server.close 正常回调', async () => {
    const deps = makeStubDeps();
    const s = createWebUI(deps);
    await new Promise(resolve => s.listen(0, resolve));
    const b = `http://127.0.0.1:${s.address().port}`;
    const { closeAllSseClients } = require('../webui/server');
    try {
        const login = await fetch(b + '/api/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: TEST_PASSWORD })
        }).then(r => r.json());

        // 建立 SSE 长连接（保持打开）
        const ctrl = new AbortController();
        const sse = await fetch(b + `/api/logs/stream?token=${encodeURIComponent(login.token)}`, { signal: ctrl.signal });
        assert.strictEqual(sse.status, 200);

        // 模拟优雅关闭：先断开 SSE，再关闭 server
        closeAllSseClients();
        const closed = await Promise.race([
            new Promise(resolve => s.close(resolve)),
            new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 2000))
        ]);
        assert.notStrictEqual(closed, 'TIMEOUT', '断开 SSE 后 server.close 应立即回调，否则进程无法退出');
        ctrl.abort();
    } finally {
        try { await new Promise(resolve => s.close(resolve)); } catch { /* ignore */ }
    }
});

// ---------------- 静态页面 / 404 ----------------

test('首页返回 HTML（登录页默认可见）', async () => {
    const res = await fetch(base + '/');
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('数据库控制台'));
    assert.ok(text.includes('AI 翻译'));
    assert.ok(text.includes('全部数据库'));
});

test('未知 API 返回 404', async () => {
    const auth = await login();
    assert.strictEqual((await req('/api/unknown', { headers: auth })).status, 404);
});

// ================= 领域接口（overview / media / clean / tags / users / groups / thumb） =================
const http = require('node:http');
const { telegramGetFile } = require('../webui/server');

const NOW = Date.now();
const DAY = 24 * 3600 * 1000;

// ---------------- 内存假集合（支持链式 find 与常用查询操作符） ----------------

/** 宽松相等（数组按元素比较，用于 $ne: [] 这类判断） */
function looseEqual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
    return false;
}

/** 匹配单个字段的查询操作符 */
function matchOperators(value, cond) {
    for (const [op, operand] of Object.entries(cond)) {
        switch (op) {
            case '$gt':
                if (value === null || value === undefined || !(value > operand)) return false;
                break;
            case '$gte':
                if (value === null || value === undefined || !(value >= operand)) return false;
                break;
            case '$lt':
                if (value === null || value === undefined || !(value < operand)) return false;
                break;
            case '$lte':
                if (value === null || value === undefined || !(value <= operand)) return false;
                break;
            case '$in':
                if (!Array.isArray(operand) || !operand.includes(value)) return false;
                break;
            case '$exists':
                if (operand ? value === undefined : value !== undefined) return false;
                break;
            case '$ne':
                if (looseEqual(value, operand)) return false;
                break;
            case '$regex': {
                const re = operand instanceof RegExp ? operand : new RegExp(operand, cond.$options || '');
                if (!re.test(String(value === undefined || value === null ? '' : value))) return false;
                break;
            }
            case '$options':
                break; // 仅作为 $regex 的修饰符
            default:
                throw new Error(`测试假集合不支持的操作符: ${op}`);
        }
    }
    return true;
}

/** 读取字段（支持 a.b 形式的点路径） */
function getField(doc, key) {
    if (!key.includes('.')) return doc[key];
    return key.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), doc);
}

/** 匹配一个文档（支持 $or 与字段级操作符；数组字段按 Mongo 语义做包含匹配） */
function matchFilter(doc, filter) {
    if (!filter || typeof filter !== 'object') return true;
    for (const [key, cond] of Object.entries(filter)) {
        if (key === '$or') {
            if (!Array.isArray(cond) || !cond.some(sub => matchFilter(doc, sub))) return false;
            continue;
        }
        if (key === '$and') {
            if (!Array.isArray(cond) || !cond.every(sub => matchFilter(doc, sub))) return false;
            continue;
        }
        const value = getField(doc, key);
        const isOpObject = cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof RegExp);
        if (isOpObject) {
            if (!matchOperators(value, cond)) return false;
        } else if (Array.isArray(value)) {
            // Mongo 语义：{ tags: 'JK' } 命中 tags 数组包含 JK 的文档
            if (!value.some(v => looseEqual(v, cond))) return false;
        } else if (!looseEqual(value, cond)) {
            return false;
        }
    }
    return true;
}

function compareForSort(a, b) {
    if (a === b) return 0;
    if (a === undefined || a === null) return -1;
    if (b === undefined || b === null) return 1;
    return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * 应用更新文档（支持 $set/$unset/$inc/$addToSet/$pull、位置操作符 tags.$ 与 tagUsed 的聚合管道写法）
 * @param {Object} target - 命中的文档（就地修改）
 * @param {Object|Array} update - 更新文档
 * @param {Object} [filter] - 查询条件（支持 `tags.$` 位置更新时需要知道命中的数组元素）
 */
function applyUpdate(target, update, filter) {
    if (Array.isArray(update)) {
        // 聚合管道：本项目仅 tagUsed 使用 count = max(0, count + delta)
        const setSpec = (update[0] && update[0].$set) || {};
        for (const [key, expr] of Object.entries(setSpec)) {
            const add = expr.$max[1].$add;
            // $add[0] 可能是 '$count'（字符串）或 { $ifNull: ['$count', 0] }（tagUsed 实际写法）
            const operand = add[0];
            const field = typeof operand === 'string'
                ? operand.slice(1)
                : (operand && Array.isArray(operand.$ifNull) ? String(operand.$ifNull[0]).slice(1) : null);
            const cur = (field && target[field]) || 0;
            target[key] = Math.max(expr.$max[0], cur + add[1]);
        }
        return;
    }
    if (!update) return;
    if (update.$set) {
        for (const [key, val] of Object.entries(update.$set)) {
            if (key.endsWith('.$')) {
                // 位置操作符：改写数组里「被 filter 命中的那个元素」
                const field = key.slice(0, -2);
                const arr = target[field];
                if (!Array.isArray(arr)) continue;
                const wanted = filter ? filter[field] : undefined;
                const idx = wanted === undefined ? 0 : arr.findIndex(v => looseEqual(v, wanted));
                if (idx >= 0) arr[idx] = val;
                continue;
            }
            target[key] = val;
        }
    }
    if (update.$inc) {
        for (const [key, delta] of Object.entries(update.$inc)) target[key] = (target[key] || 0) + delta;
    }
    if (update.$addToSet) {
        for (const [key, val] of Object.entries(update.$addToSet)) {
            const arr = Array.isArray(target[key]) ? target[key] : [];
            if (!arr.some(v => looseEqual(v, val))) arr.push(val);
            target[key] = arr;
        }
    }
    if (update.$pull) {
        for (const [key, val] of Object.entries(update.$pull)) {
            target[key] = (Array.isArray(target[key]) ? target[key] : []).filter(v => !looseEqual(v, val));
        }
    }
    if (update.$unset) {
        for (const key of Object.keys(update.$unset)) delete target[key];
    }
}

/**
 * 内存假集合：countDocuments / find(sort/skip/limit/toArray) / findOne /
 * deleteMany / insertOne / updateOne，并记录调用便于断言
 */
function makeMemoryCol(initialDocs = []) {
    let autoId = 0;
    const docs = initialDocs.map(d => {
        const out = { ...d };
        if (out._id === undefined) {
            out._id = String(++autoId).padStart(6, '0');
        } else {
            const num = parseInt(out._id, 10);
            if (Number.isFinite(num) && num > autoId) autoId = num;
        }
        return out;
    });
    const calls = { find: [], sorts: [], deleteMany: [], insert: [], update: [] };

    function makeCursor(filter) {
        let sortSpec = null;
        let skipCount = 0;
        let limitCount = Infinity;
        const chain = {
            sort(spec) { sortSpec = spec; calls.sorts.push(spec); return chain; },
            skip(n) { skipCount = n; return chain; },
            limit(n) { limitCount = n; return chain; },
            async toArray() {
                let out = docs.filter(d => matchFilter(d, filter));
                if (sortSpec) {
                    const keys = Object.entries(sortSpec);
                    out = [...out].sort((a, b) => {
                        for (const [key, dir] of keys) {
                            const cmp = compareForSort(a[key], b[key]);
                            if (cmp !== 0) return dir < 0 ? -cmp : cmp;
                        }
                        return 0;
                    });
                }
                return out.slice(skipCount, skipCount + limitCount).map(d => ({ ...d }));
            }
        };
        return chain;
    }

    return {
        calls,
        docs,
        countDocuments: async (filter = {}) => docs.filter(d => matchFilter(d, filter)).length,
        find: (filter = {}) => { calls.find.push(filter); return makeCursor(filter); },
        findOne: async (filter = {}) => {
            // 故意返回「活引用」而不是副本：真实驱动会返回副本，若实现依赖副本语义
            // （例如先 findOne 拿到旧值、再 update，然后读旧值），这里就会暴露出来。
            const found = docs.find(d => matchFilter(d, filter));
            return found || null;
        },
        deleteMany: async (filter = {}) => {
            calls.deleteMany.push(filter);
            let deletedCount = 0;
            for (let i = docs.length - 1; i >= 0; i--) {
                if (matchFilter(docs[i], filter)) { docs.splice(i, 1); deletedCount++; }
            }
            return { deletedCount };
        },
        insertOne: async (data) => { calls.insert.push(data); docs.push({ ...data }); return { insertedId: data._id }; },
        updateOne: async (filter, update) => {
            calls.update.push({ filter, update });
            const target = docs.find(d => matchFilter(d, filter));
            if (!target) return { matchedCount: 0, modifiedCount: 0 };
            applyUpdate(target, update, filter);
            return { matchedCount: 1, modifiedCount: 1 };
        },
        updateMany: async (filter, update) => {
            calls.update.push({ filter, update });
            const matched = docs.filter(d => matchFilter(d, filter));
            for (const doc of matched) applyUpdate(doc, update, filter);
            return { matchedCount: matched.length, modifiedCount: matched.length };
        },
        deleteOne: async (filter = {}) => {
            calls.deleteOne = calls.deleteOne || [];
            calls.deleteOne.push(filter);
            const idx = docs.findIndex(d => matchFilter(d, filter));
            if (idx < 0) return { deletedCount: 0 };
            docs.splice(idx, 1);
            return { deletedCount: 1 };
        }
    };
}

/** 按集合名分发的内存依赖（不触碰真实数据库与网络） */
function makeMemoryDeps(data = {}) {
    const cols = new Map();
    for (const name of Object.keys(data)) cols.set(name, makeMemoryCol(data[name] || []));
    // 让 db/* 模块内部也看到同一份内存数据
    activeStore = cols;
    return {
        cols,
        getCollection: (name) => {
            if (!cols.has(name)) cols.set(name, makeMemoryCol([]));
            return cols.get(name);
        },
        callAI: async () => JSON.stringify({ explain: '测试', operation: { action: 'query', collection: 'users', filter: {} } }),
        password: TEST_PASSWORD,
        telegramGetFile: async () => { throw new Error('测试未注入 telegramGetFile'); }
    };
}

/** 领域接口测试数据（每次调用返回全新对象，避免用例间互相污染） */
function makeDomainData() {
    return {
        group_list: [
            { _id: '0010', group_id: '-100_1', is_group: 3, is_delete: 0, mark: 1, last_mark_time: NOW - 1000 },
            { _id: '0011', group_id: '-100_2', is_group: 2, is_delete: NOW - 40 * DAY, mark: 0, last_mark_time: null },
            { _id: '0012', group_id: '-100_3', is_group: 5, is_delete: NOW - 8 * DAY, mark: 2, last_mark_time: null },
            { _id: '0013', group_id: '-100_4', is_group: 4, is_delete: null, mark: 0, last_mark_time: null }
        ],
        media: [
            { _id: 'm1', group_id: '-100_1', subgroup: 1, media_type: 'photo', file_id: 'AgAC1', file_unique_id: 'AQAD1', message_id: 11, group: { chat_id: -100, message_id: 11 }, channel: null },
            { _id: 'm2', group_id: '-100_1', subgroup: 1, media_type: 'video', file_id: 'AgAC2', file_unique_id: 'AQAD2', message_id: 12, video_time: 30, group: { chat_id: -100, message_id: 12 }, channel: { chat_id: -200, message_id: 9 } },
            { _id: 'm3', group_id: '-100_1', subgroup: 2, media_type: 'photo', file_id: 'AgAC3', file_unique_id: 'AQAD3', message_id: 9, group: { chat_id: -100, message_id: 9 }, channel: null },
            { _id: 'm21', group_id: '-100_2', subgroup: 1, media_type: 'photo', file_id: 'AgAC21', file_unique_id: 'AQAD21', message_id: 21, group: { chat_id: -100, message_id: 21 }, channel: null },
            { _id: 'm22', group_id: '-100_2', subgroup: 1, media_type: 'video', file_id: 'AgAC22', file_unique_id: 'AQAD22', message_id: 22, group: { chat_id: -100, message_id: 22 }, channel: null },
            { _id: 'm41', group_id: '-100_4', subgroup: 1, media_type: 'document', file_id: 'AgAC41', file_unique_id: 'AQAD41', message_id: 41, group: { chat_id: -100, message_id: 41 }, channel: null }
        ],
        message: [
            { _id: 's1', group_id: '-100_1', file_unique_id: 'AQAD1', text: 'JK 写真描述', tags: ['JK'], chat_id: -100, message_id: 11, updated_at: NOW - 5000 },
            { _id: 's2', group_id: '-100_1', file_unique_id: 'AQAD3', text: '旧描述', tags: [], chat_id: -100, message_id: 9, updated_at: NOW - 90000 },
            { _id: 's3', group_id: '-100_2', file_unique_id: 'AQAD21', text: 'JK 合集', tags: ['JK', 'CAT'], chat_id: -100, message_id: 21, updated_at: NOW - 1000 },
            { _id: 's4', group_id: '-100_3', file_unique_id: 'AQAD31', text: '无标签描述', tags: [], chat_id: -100, message_id: 31, updated_at: NOW - 2000 }
        ],
        users: [
            { _id: 'u1', id: 123, name: '张三', state: 1, white: 1, group: [-100, -200], last_seen: NOW - 100, join_time: NOW - 1000 },
            { _id: 'u2', id: 456, name: '李四', state: 0, white: 0, group: [-100], last_seen: NOW - 200, join_time: NOW - 2000 },
            { _id: 'u3', id: 789, name: 'Alice', state: 1, white: 0, group: [], last_seen: NOW - 300, join_time: NOW - 3000 }
        ],
        tags: [
            { _id: 't1', name: 'JK', pin: 1, count: 12 },
            { _id: 't2', name: 'CAT', pin: 0, count: 30 },
            { _id: 't3', name: 'DOG', pin: 0, count: 30 },
            { _id: 't4', name: 'PIN2', pin: 2, count: 0 }
        ],
        channel_group: [
            { _id: 'c1', id: -100, name: '频道A', type: 'channel', bind_id: -200, is_bound: true },
            { _id: 'c2', id: -200, name: '群组B', type: 'group', bind_id: -100, is_bound: true },
            { _id: 'c3', id: -300, name: '孤立群', type: 'group', bind_id: null, is_bound: false },
            { _id: 'c4', id: -400, name: '悬空绑定', type: 'group', bind_id: -999, is_bound: false }
        ],
        log: [
            { _id: 'l1', type: 22, time: NOW - 10, userId: 123, query: 'abc' },
            { _id: 'l2', type: 18, time: NOW - 20 },
            { _id: 'l3', type: 1, time: NOW - 30 }
        ]
    };
}

/** 在独立服务上跑领域接口测试（返回 deps 便于断言调用记录） */
async function withDomain(deps, fn) {
    return withServer(deps, (b, auth) => fn(b, auth, deps));
}

async function domainReq(b, auth, path, options = {}) {
    const res = await fetch(b + path, { headers: auth, ...options });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
}

/** 从 withServer 的鉴权头中取出 Bearer token */
function tokenFrom(auth) {
    return String(auth.Authorization || '').replace(/^Bearer\s+/, '');
}

// ---------------- 概览 ----------------

test('GET /api/overview 返回计数/媒体类型/最近日志/最新媒体组', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        // 登录会写一条 webui_login 审计日志，先清掉以便精确计数
        const logCol = deps.getCollection('log');
        logCol.docs.splice(0, logCol.docs.length, ...makeDomainData().log);
        const r = await domainReq(b, auth, '/api/overview');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(Object.keys(r.body.counts).sort(), [
            'banned', 'bound', 'channels', 'chats', 'cleanable', 'groupList', 'groups',
            'kept', 'logs', 'media', 'message', 'pending', 'tags', 'users', 'whitelist'
        ]);
        assert.deepStrictEqual(r.body.counts, {
            media: 6, message: 4, groupList: 4, cleanable: 2, kept: 1, pending: 1,
            users: 3, banned: 1, whitelist: 1, tags: 4, chats: 4, channels: 1,
            groups: 3, bound: 2, logs: 3
        });
        assert.deepStrictEqual(r.body.mediaByType, { photo: 3, video: 2, audio: 0, document: 1 });

        assert.ok(Array.isArray(r.body.recent));
        assert.strictEqual(r.body.recent.length, 3);
        assert.strictEqual(r.body.recent[0]._id, 'l1');
        assert.strictEqual(typeof r.body.recent[0]._id, 'string');
        assert.strictEqual(r.body.recent[0].type, 22);
        assert.strictEqual(r.body.recent[0].userId, 123);
        assert.strictEqual(r.body.recent[0].query, 'abc');
        assert.strictEqual(r.body.recent[1].userId, null);
        assert.ok(r.body.recent[0].time >= r.body.recent[1].time, 'recent 应按 time 倒序');

        assert.strictEqual(r.body.latestGroupList.length, 4);
        assert.deepStrictEqual(r.body.latestGroupList[0], { group_id: '-100_4', is_group: 4, is_delete: null });
        assert.deepStrictEqual(Object.keys(r.body.latestGroupList[0]), ['group_id', 'is_group', 'is_delete']);
        assert.ok(typeof r.body.serverTime === 'number' && r.body.serverTime > 0);
    });
});

test('GET /api/overview 单个计数失败时回退 0 而不整体报错', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    const broken = deps.getCollection('media');
    broken.countDocuments = async () => { throw new Error('计数炸了'); };
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/overview');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.counts.media, 0);
        assert.strictEqual(r.body.mediaByType.photo, 0);
        assert.strictEqual(r.body.counts.groupList, 4, '其他计数不受影响');
    });
});

// ---------------- 媒体列表 ----------------

test('GET /api/media scope=kept 返回完整字段', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/media?scope=kept');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.total, 1);
        assert.strictEqual(r.body.page, 1);
        assert.strictEqual(r.body.pageSize, 24);
        const item = r.body.items[0];
        assert.deepStrictEqual(Object.keys(item).sort(), [
            'channel', 'cleanable', 'group', 'group_id', 'is_delete', 'is_group', 'mark',
            'mediaCount', 'preview', 'subgroups', 'tags', 'text', 'types', 'updatedAt'
        ].sort());
        assert.strictEqual(item.group_id, '-100_1');
        assert.strictEqual(item.is_group, 3);
        assert.strictEqual(item.is_delete, 0);
        assert.strictEqual(item.cleanable, false);
        assert.strictEqual(item.mark, 1);
        assert.strictEqual(item.mediaCount, 3);
        assert.strictEqual(item.subgroups, 2);
        assert.deepStrictEqual(item.types, ['photo', 'video']);
        assert.deepStrictEqual(item.preview, { file_unique_id: 'AQAD1', media_type: 'photo', thumbable: true });
        assert.strictEqual(item.text, 'JK 写真描述');
        assert.deepStrictEqual(item.tags, ['JK']);
        assert.deepStrictEqual(item.group, { chat_id: -100, message_id: 11 });
        assert.strictEqual(item.channel, null);
        assert.strictEqual(item.updatedAt, NOW - 5000);
    });
});

test('GET /api/media scope=cleanable 支持无媒体组（preview 为 null、mediaCount 回退 is_group）', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/media?scope=cleanable');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.total, 2);
        assert.deepStrictEqual(r.body.items.map(i => i.group_id), ['-100_3', '-100_2']);

        const noMedia = r.body.items[0];
        assert.strictEqual(noMedia.cleanable, true);
        assert.strictEqual(noMedia.mediaCount, 5);
        assert.strictEqual(noMedia.subgroups, 0);
        assert.deepStrictEqual(noMedia.types, []);
        assert.strictEqual(noMedia.preview, null);
        assert.strictEqual(noMedia.text, '无标签描述');
        assert.deepStrictEqual(noMedia.tags, []);
        assert.strictEqual(noMedia.group, null);
        assert.strictEqual(noMedia.channel, null);
        assert.strictEqual(noMedia.updatedAt, NOW - 2000);

        const withMedia = r.body.items[1];
        assert.strictEqual(withMedia.mediaCount, 2);
        assert.deepStrictEqual(withMedia.types, ['photo', 'video']);
        assert.deepStrictEqual(withMedia.preview, { file_unique_id: 'AQAD21', media_type: 'photo', thumbable: true });
        assert.strictEqual(withMedia.is_delete, NOW - 40 * DAY);
    });
});

test('GET /api/media scope=all 与 q 关键词搜索（含正则转义）', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const all = await domainReq(b, auth, '/api/media');
        assert.strictEqual(all.body.total, 4);

        const hit = await domainReq(b, auth, '/api/media?scope=all&q=jk');
        assert.strictEqual(hit.body.total, 2, '大小写不敏感');
        assert.deepStrictEqual(hit.body.items.map(i => i.group_id), ['-100_2', '-100_1']);

        const kept = await domainReq(b, auth, '/api/media?scope=kept&q=JK');
        assert.strictEqual(kept.body.total, 1);
        assert.strictEqual(kept.body.items[0].group_id, '-100_1');

        // 正则元字符必须被转义（否则会当成正则分组导致异常匹配）
        const escaped = await domainReq(b, auth, '/api/media?q=%28');
        assert.strictEqual(escaped.status, 200);
        assert.strictEqual(escaped.body.total, 0);
        assert.deepStrictEqual(escaped.body.items, []);
    });
});

test('GET /api/media 分页参数生效，未知 scope 返回 400', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const page2 = await domainReq(b, auth, '/api/media?scope=all&page=2&pageSize=2');
        assert.strictEqual(page2.body.total, 4);
        assert.strictEqual(page2.body.page, 2);
        assert.strictEqual(page2.body.pageSize, 2);
        assert.deepStrictEqual(page2.body.items.map(i => i.group_id), ['-100_2', '-100_1']);

        const capped = await domainReq(b, auth, '/api/media?pageSize=9999');
        assert.strictEqual(capped.body.pageSize, 100);

        const bad = await domainReq(b, auth, '/api/media?scope=nope');
        assert.strictEqual(bad.status, 400);
        assert.ok(bad.body.error.includes('scope'));
    });
});

// ---------------- 媒体详情 ----------------

test('GET /api/media/detail 缺少 groupId 返回 400 / 未知媒体组返回 404', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const missing = await domainReq(b, auth, '/api/media/detail');
        assert.strictEqual(missing.status, 400);

        const empty = await domainReq(b, auth, '/api/media/detail?groupId=');
        assert.strictEqual(empty.status, 400);

        const notFound = await domainReq(b, auth, '/api/media/detail?groupId=-100_404');
        assert.strictEqual(notFound.status, 404);
        assert.strictEqual(notFound.body.error, '未找到该媒体组');
    });
});

test('GET /api/media/detail 返回 group / media / messages', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/media/detail?groupId=-100_1');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.group, {
            group_id: '-100_1', is_group: 3, is_delete: 0, cleanable: false, mark: 1, last_mark_time: NOW - 1000
        });

        assert.strictEqual(r.body.media.length, 3);
        assert.deepStrictEqual(Object.keys(r.body.media[0]).sort(), [
            '_id', 'channel', 'file_id', 'file_unique_id', 'group', 'media_type',
            'message_id', 'subgroup', 'thumbable', 'video_time'
        ].sort());
        assert.deepStrictEqual(r.body.media.map(m => [m.subgroup, m.message_id]), [[1, 11], [1, 12], [2, 9]]);
        assert.strictEqual(r.body.media[0]._id, 'm1');
        assert.strictEqual(typeof r.body.media[0]._id, 'string');
        assert.strictEqual(r.body.media[0].thumbable, true);
        assert.strictEqual(r.body.media[1].thumbable, false);
        assert.strictEqual(r.body.media[1].video_time, 30);
        assert.deepStrictEqual(r.body.media[1].channel, { chat_id: -200, message_id: 9 });
        assert.strictEqual(r.body.media[0].video_time, null);

        assert.deepStrictEqual(Object.keys(r.body.messages[0]).sort(), [
            '_id', 'chat_id', 'file_unique_id', 'message_id', 'tags', 'text', 'updated_at'
        ].sort());
        assert.strictEqual(r.body.messages.length, 2);
        assert.strictEqual(r.body.messages[0]._id, 's1', 'messages 应按 updated_at 倒序');
        assert.strictEqual(r.body.messages[0].text, 'JK 写真描述');
        assert.deepStrictEqual(r.body.messages[0].tags, ['JK']);
        assert.strictEqual(r.body.messages[0].updated_at, NOW - 5000);
        assert.strictEqual(r.body.messages[1].tags.length, 0);
    });
});

test('GET /api/media/detail：新结构 media（无顶层 message_id）也能按位置排序并给出位置消息 ID', async () => {
    const data = makeDomainData();
    data.group_list.push({ _id: '0099', group_id: '-100_9', is_group: 3, is_delete: 0, mark: 0, last_mark_time: null });
    // 新结构：只有 group / channel 子文档，没有顶层 message_id（写入端已不再产生该字段）
    data.media = [
        { _id: 'n1', group_id: '-100_9', subgroup: 1, media_type: 'photo', file_id: 'AgN1', file_unique_id: 'N1', group: { chat_id: -900, message_id: 300 } },
        { _id: 'n2', group_id: '-100_9', subgroup: 1, media_type: 'photo', file_id: 'AgN2', file_unique_id: 'N2', group: { chat_id: -900, message_id: 100 } },
        { _id: 'n3', group_id: '-100_9', subgroup: 2, media_type: 'video', file_id: 'AgN3', file_unique_id: 'N3', channel: { chat_id: -901, message_id: 50 }, video_time: 5 }
    ];
    data.message = [];

    const deps = makeMemoryDeps(data);
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/media/detail?groupId=-100_9');
        assert.strictEqual(r.status, 200);
        // subgroup 升序 → 位置消息 ID 升序（100 < 300），subgroup=2 在后
        assert.deepStrictEqual(r.body.media.map(m => [m.subgroup, m.message_id]), [[1, 100], [1, 300], [2, 50]]);
        assert.deepStrictEqual(r.body.media.map(m => m._id), ['n2', 'n1', 'n3']);
    });
});

// ---------------- 清理 ----------------

test('POST /api/clean 非法 scope 返回 400', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/clean', {
            method: 'POST', body: JSON.stringify({ scope: 'year' })
        });
        assert.strictEqual(r.status, 400);
        assert.strictEqual(deps.cols.has('media') ? deps.cols.get('media').calls.deleteMany.length : 0, 0);
    });
});

test('POST /api/clean 预览返回数量但不删除', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const all = await domainReq(b, auth, '/api/clean', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
        assert.strictEqual(all.status, 200);
        assert.deepStrictEqual(all.body, { scope: 'all', groups: 2, media: 2, deleted: false });

        const week = await domainReq(b, auth, '/api/clean', { method: 'POST', body: JSON.stringify({ scope: 'week' }) });
        assert.strictEqual(week.body.groups, 2, '一周前的组（40 天前与 8 天前）都应命中');
        assert.strictEqual(week.body.media, 2);
        assert.strictEqual(week.body.deleted, false);

        const month = await domainReq(b, auth, '/api/clean', { method: 'POST', body: JSON.stringify({ scope: 'month' }) });
        assert.strictEqual(month.body.groups, 1, '仅 40 天前的组命中一个月');
        assert.strictEqual(month.body.media, 2);

        assert.strictEqual(deps.cols.get('media').calls.deleteMany.length, 0, '预览不应删除');
        assert.strictEqual(deps.cols.get('group_list').calls.deleteMany.length, 0);
        assert.strictEqual(deps.cols.get('group_list').docs.length, 4);
    });
});

test('POST /api/clean confirm:true 执行 media + group_list 删除', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/clean', {
            method: 'POST', body: JSON.stringify({ scope: 'all', confirm: true })
        });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body, { scope: 'all', groups: 2, media: 2, deleted: true });

        const mediaCalls = deps.cols.get('media').calls.deleteMany;
        const groupCalls = deps.cols.get('group_list').calls.deleteMany;
        assert.strictEqual(mediaCalls.length, 1);
        assert.strictEqual(groupCalls.length, 1);
        const ids = mediaCalls[0].group_id.$in;
        assert.ok(ids.includes('-100_2') && ids.includes('-100_3'), '应删除待清理组');
        assert.deepStrictEqual(groupCalls[0], { group_id: { $in: ids } });
        assert.strictEqual(deps.cols.get('media').docs.filter(d => ids.includes(d.group_id)).length, 0);
        assert.strictEqual(deps.cols.get('group_list').docs.length, 2);
    });
});

// ---------------- 标签 ----------------

test('GET /api/tags 按置顶/次数排序并统计 usage', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/tags');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.total, 4);
        assert.deepStrictEqual(r.body.tags.map(t => t.name), ['JK', 'PIN2', 'CAT', 'DOG']);
        assert.deepStrictEqual(Object.keys(r.body.tags[0]).sort(), ['count', 'name', 'pin', 'usage'].sort());
        const byName = Object.fromEntries(r.body.tags.map(t => [t.name, t]));
        assert.strictEqual(byName.JK.usage, 2, 'usage = 引用该标签的 message 文档数');
        assert.strictEqual(byName.JK.pin, 1);
        assert.strictEqual(byName.JK.count, 12);
        assert.strictEqual(byName.CAT.usage, 1);
        assert.strictEqual(byName.DOG.usage, 0);
        assert.strictEqual(byName.PIN2.usage, 0);
    });
});

// ---------------- 用户 ----------------

test('GET /api/users scope 过滤与分页', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const all = await domainReq(b, auth, '/api/users');
        assert.strictEqual(all.status, 200);
        assert.strictEqual(all.body.total, 3);
        assert.strictEqual(all.body.page, 1);
        assert.strictEqual(all.body.pageSize, 20);
        assert.deepStrictEqual(all.body.items.map(u => u.id), [123, 456, 789], '按 last_seen 倒序');
        assert.deepStrictEqual(Object.keys(all.body.items[0]).sort(), [
            'groups', 'id', 'join_time', 'last_seen', 'name', 'state', 'white'
        ].sort());
        assert.strictEqual(all.body.items[0].name, '张三');
        assert.strictEqual(all.body.items[0].groups, 2);
        assert.strictEqual(all.body.items[2].groups, 0);

        const white = await domainReq(b, auth, '/api/users?scope=white');
        assert.strictEqual(white.body.total, 1);
        assert.strictEqual(white.body.items[0].id, 123);

        const banned = await domainReq(b, auth, '/api/users?scope=banned');
        assert.strictEqual(banned.body.total, 1);
        assert.strictEqual(banned.body.items[0].state, 0);

        const page2 = await domainReq(b, auth, '/api/users?page=2&pageSize=2');
        assert.strictEqual(page2.body.total, 3);
        assert.deepStrictEqual(page2.body.items.map(u => u.id), [789]);
    });
});

test('GET /api/users q 支持姓名模糊与纯数字 id 精确匹配', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const byName = await domainReq(b, auth, '/api/users?q=%E5%BC%A0%E4%B8%89');
        assert.strictEqual(byName.body.total, 1);
        assert.strictEqual(byName.body.items[0].id, 123);

        const byId = await domainReq(b, auth, '/api/users?q=456');
        assert.strictEqual(byId.body.total, 1);
        assert.strictEqual(byId.body.items[0].name, '李四');

        const none = await domainReq(b, auth, '/api/users?q=zzz');
        assert.strictEqual(none.body.total, 0);
    });
});

// ---------------- 聊天管理 ----------------

test('GET /api/groups 返回 bindName 解析结果', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/groups');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.items.map(g => g.id), [-400, -300, -200, -100], '按 id 升序');
        assert.deepStrictEqual(Object.keys(r.body.items[0]).sort(), [
            'bindName', 'bind_id', 'id', 'is_bound', 'name', 'type'
        ].sort());
        const byId = Object.fromEntries(r.body.items.map(g => [g.id, g]));
        assert.strictEqual(byId[-100].bindName, '群组B');
        assert.strictEqual(byId[-100].is_bound, true);
        assert.strictEqual(byId[-300].bindName, null);
        assert.strictEqual(byId[-400].bindName, null, 'bind_id 指向不存在的记录时 bindName 为 null');
    });
});

// ---------------- 缩略图代理 ----------------

/** 本地图片服务（替代真实 Telegram，测试不访问外网） */
function startImageServer(bytes, contentType = 'image/jpeg') {
    const hits = { count: 0 };
    const server = http.createServer((req, res) => {
        hits.count++;
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': bytes.length });
        res.end(bytes);
    });
    return new Promise((resolve) => {
        server.listen(0, () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` }));
    });
}

/** 构造只含一条媒体的依赖 */
function makeThumbDeps(mediaDoc, telegramGetFile) {
    const deps = makeMemoryDeps({ media: [mediaDoc] });
    deps.telegramGetFile = telegramGetFile;
    return deps;
}

const PHOTO_DOC = {
    _id: 'p1', group_id: '-100_1', subgroup: 1, media_type: 'photo',
    file_id: 'AgAC_PHOTO', file_unique_id: 'AQAD_PHOTO', message_id: 11, group: { chat_id: -100, message_id: 11 }, channel: null
};

test('telegramGetFile 已导出（可注入替换）', () => {
    assert.strictEqual(typeof telegramGetFile, 'function');
});

test('GET /api/thumb 无 token 返回 401（Bearer 头可用）', async () => {
    const deps = makeThumbDeps({ ...PHOTO_DOC, file_unique_id: 'AQAD_BEARER' }, async () => 'http://127.0.0.1:1/none');
    const bytes = Buffer.from([1, 2, 3]);
    const img = await startImageServer(bytes);
    try {
        deps.telegramGetFile = async () => `${img.base}/file.jpg`;
        await withDomain(deps, async (b, auth) => {
            const noToken = await fetch(b + '/api/thumb?fileUniqueId=AQAD_BEARER');
            assert.strictEqual(noToken.status, 401);
            assert.deepStrictEqual(await noToken.json(), { error: '未授权' });

            const withHeader = await fetch(b + '/api/thumb?fileUniqueId=AQAD_BEARER', { headers: auth });
            assert.strictEqual(withHeader.status, 200);
        });
    } finally {
        await new Promise(resolve => img.server.close(resolve));
    }
});

test('GET /api/thumb 无封面返回 415，未知媒体返回 404，缺参返回 400', async () => {
    const deps = makeThumbDeps({
        _id: 'v1', group_id: '-100_2', subgroup: 1, media_type: 'video',
        file_id: 'AgAC_VIDEO', file_unique_id: 'AQAD_VIDEO', message_id: 22
    }, async () => { throw new Error('不应被调用'); });
    await withDomain(deps, async (b, auth) => {
        const video = await fetch(b + '/api/thumb?token=' + encodeURIComponent(tokenFrom(auth)) + '&fileUniqueId=AQAD_VIDEO');
        assert.strictEqual(video.status, 415);
        assert.deepStrictEqual(await video.json(), { error: '该媒体没有可用缩略图' });

        const missing = await fetch(b + '/api/thumb?token=' + encodeURIComponent(tokenFrom(auth)) + '&fileUniqueId=AQAD_NONE');
        assert.strictEqual(missing.status, 404);
        assert.deepStrictEqual(await missing.json(), { error: '未找到该媒体' });

        const noParam = await fetch(b + '/api/thumb?token=' + encodeURIComponent(tokenFrom(auth)));
        assert.strictEqual(noParam.status, 400);
    });
});

test('GET /api/thumb 视频用收录时保存的封面 file_id 出图', async () => {
    const bytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0xFF, 0xD9]);
    const img = await startImageServer(bytes);
    const seenFileIds = [];
    const deps = makeThumbDeps({
        _id: 'v2', group_id: '-100_3', subgroup: 1, media_type: 'video',
        file_id: 'AgAC_VIDEO2', file_unique_id: 'AQAD_VIDEO2', message_id: 33,
        thumb_file_id: 'AgAC_THUMB2'
    }, async (fileId) => {
        seenFileIds.push(fileId);
        return `${img.base}/file/${fileId}.jpg`;
    });
    try {
        await withDomain(deps, async (b, auth) => {
            const res = await fetch(b + '/api/thumb?fileUniqueId=AQAD_VIDEO2', { headers: auth });
            assert.strictEqual(res.status, 200);
            assert.match(res.headers.get('content-type'), /image\/jpeg/);
            assert.deepStrictEqual(seenFileIds, ['AgAC_THUMB2'], '视频应使用封面 file_id 而不是视频自身 file_id');
        });
    } finally {
        await new Promise(resolve => img.server.close(resolve));
    }
});

test('GET /api/thumb 返回图片字节、Content-Length 与缓存头，并命中内存缓存', async () => {
    const bytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0xFF, 0xD9]);
    const img = await startImageServer(bytes);
    const seenFileIds = [];
    const deps = makeThumbDeps(PHOTO_DOC, async (fileId) => {
        seenFileIds.push(fileId);
        return `${img.base}/file/${fileId}.jpg`;
    });
    try {
        await withDomain(deps, async (b, auth) => {
            const url = b + '/api/thumb?token=' + encodeURIComponent(tokenFrom(auth)) + '&fileUniqueId=AQAD_PHOTO';
            const first = await fetch(url);
            assert.strictEqual(first.status, 200);
            assert.strictEqual(first.headers.get('content-type'), 'image/jpeg');
            assert.strictEqual(first.headers.get('cache-control'), 'private, max-age=1800');
            assert.strictEqual(first.headers.get('content-length'), String(bytes.length));
            assert.deepStrictEqual([...Buffer.from(await first.arrayBuffer())], [...bytes]);
            assert.deepStrictEqual(seenFileIds, ['AgAC_PHOTO'], 'telegramGetFile 应收到 media.file_id');

            // 第二次命中缓存：不再请求 Telegram
            const second = await fetch(url);
            assert.strictEqual(second.status, 200);
            assert.deepStrictEqual([...Buffer.from(await second.arrayBuffer())], [...bytes]);
            assert.strictEqual(img.hits.count, 1);
            assert.strictEqual(seenFileIds.length, 1);
        });
    } finally {
        await new Promise(resolve => img.server.close(resolve));
    }
});

test('GET /api/thumb Telegram 失败时不抛异常，返回 404 JSON', async () => {
    const deps = makeThumbDeps({ ...PHOTO_DOC, file_unique_id: 'AQAD_FAIL' }, async () => {
        throw new Error('getFile 失败');
    });
    await withDomain(deps, async (b, auth) => {
        const r = await fetch(b + '/api/thumb?token=' + encodeURIComponent(tokenFrom(auth)) + '&fileUniqueId=AQAD_FAIL');
        assert.strictEqual(r.status, 404);
        assert.deepStrictEqual(await r.json(), { error: '缩略图获取失败' });
    });
});

// ---------------- 新接口鉴权 ----------------

test('新增领域接口未登录均返回 401', async () => {
    const endpoints = [
        ['/api/overview', 'GET'],
        ['/api/media', 'GET'],
        ['/api/media/detail?groupId=-100_1', 'GET'],
        ['/api/clean', 'POST'],
        ['/api/tags', 'GET'],
        ['/api/users', 'GET'],
        ['/api/groups', 'GET'],
        ['/api/oplogs', 'GET'],
        ['/api/stats', 'GET'],
        ['/api/media/tags', 'POST'],
        ['/api/media/description', 'POST'],
        ['/api/users/create', 'POST'],
        ['/api/users/update', 'POST'],
        ['/api/users/delete', 'POST'],
        ['/api/groups/create', 'POST'],
        ['/api/groups/update', 'POST'],
        ['/api/groups/delete', 'POST'],
        ['/api/transport', 'GET'],
        ['/api/transport/create', 'POST'],
        ['/api/transport/update', 'POST'],
        ['/api/transport/delete', 'POST'],
        ['/api/transport/check', 'POST'],
        ['/api/articles', 'GET'],
        ['/api/articles/create', 'POST'],
        ['/api/articles/sub/create', 'POST'],
        ['/api/collections', 'GET'],
        ['/api/collections/create', 'POST'],
        ['/api/collections/sub/create', 'POST'],
        ['/api/db-stats', 'GET'],
        ['/api/tags/create', 'POST'],
        ['/api/tags/delete', 'POST'],
        ['/api/tags/pin', 'POST'],
        ['/api/tags/rename', 'POST'],
        ['/api/tags/reorder', 'POST'],
        ['/api/thumb?fileUniqueId=AQAD1', 'GET']
    ];
    for (const [path, method] of endpoints) {
        const res = await fetch(base + path, { method });
        assert.strictEqual(res.status, 401, `${method} ${path} 未登录应返回 401`);
    }
});

// ---------------- 媒体标签筛选（标签 → 媒体组） ----------------

test('GET /api/media?tag= 只返回带该标签的媒体组，且可与关键词叠加', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const jk = await domainReq(b, auth, '/api/media?tag=jk&pageSize=24');
        assert.strictEqual(jk.status, 200);
        assert.deepStrictEqual(jk.body.items.map(i => i.group_id).sort(), ['-100_1', '-100_2'], 'JK 存在于 -100_1 与 -100_2');

        const none = await domainReq(b, auth, '/api/media?tag=NOPE');
        assert.strictEqual(none.body.total, 0);
        assert.deepStrictEqual(none.body.items, []);

        const combined = await domainReq(b, auth, '/api/media?tag=JK&q=' + encodeURIComponent('合集'));
        assert.strictEqual(combined.body.total, 1, 'tag 与 q 叠加取交集');
        assert.strictEqual(combined.body.items[0].group_id, '-100_2');

        const withScope = await domainReq(b, auth, '/api/media?tag=JK&scope=cleanable');
        assert.strictEqual(withScope.body.total, 1, '可清理 ∩ JK = -100_2');
        assert.strictEqual(withScope.body.items[0].group_id, '-100_2');
    });
});

// ---------------- 控制台改标签 ----------------

test('POST /api/media/tags 给单条 message 增删标签并维护标签库计数', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const add = await domainReq(b, auth, '/api/media/tags', {
            method: 'POST',
            body: JSON.stringify({ fileUniqueId: 'AQAD1', add: ['newtag'] })
        });
        assert.strictEqual(add.status, 200);
        assert.deepStrictEqual(add.body.added, ['NEWTAG'], '标签名统一大写');
        assert.ok(add.body.tags.includes('NEWTAG'));
        assert.ok(add.body.createdTags.includes('NEWTAG'), '新标签应写入标签库');
        assert.ok(deps.getCollection('tags').docs.some(t => t.name === 'NEWTAG'));
        assert.ok(deps.getCollection('message').docs.find(m => m.file_unique_id === 'AQAD1').tags.includes('NEWTAG'));

        const remove = await domainReq(b, auth, '/api/media/tags', {
            method: 'POST',
            body: JSON.stringify({ fileUniqueId: 'AQAD1', remove: ['jk'] })
        });
        assert.deepStrictEqual(remove.body.removed, ['JK']);
        assert.ok(!remove.body.tags.includes('JK'));
        assert.strictEqual(remove.body.affectedMessages, 1);

        const bad = await domainReq(b, auth, '/api/media/tags', { method: 'POST', body: JSON.stringify({}) });
        assert.strictEqual(bad.status, 400);
        const noTags = await domainReq(b, auth, '/api/media/tags', {
            method: 'POST', body: JSON.stringify({ fileUniqueId: 'AQAD1' })
        });
        assert.strictEqual(noTags.status, 400);
    });
});

test('POST /api/media/tags 支持整组增删（groupId）', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/media/tags', {
            method: 'POST',
            body: JSON.stringify({ groupId: '-100_1', add: ['GROUP'] })
        });
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.tags.includes('GROUP'), '整组返回组内标签并集');
        const withTag = await domainReq(b, auth, '/api/media/tags', {
            method: 'POST',
            body: JSON.stringify({ groupId: '-100_1', remove: ['GROUP'] })
        });
        assert.ok(!withTag.body.tags.includes('GROUP'));
    });
});

// ---------------- 控制台改描述 ----------------

test('POST /api/media/description 修改描述：更新数据库 + 调用 Telegram + 重算 is_delete', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    const captionCalls = [];
    deps.editCaption = async (chatId, messageId, text) => { captionCalls.push({ chatId, messageId, text }); return true; };
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/media/description', {
            method: 'POST',
            body: JSON.stringify({ fileUniqueId: 'AQAD2', text: '新的视频描述' })
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.telegramEdited, true);
        // 双位置媒体（频道 → 讨论群自动转发）：优先改频道源消息，Telegram 会自动同步到群里的转发副本
        assert.deepStrictEqual(captionCalls[0], { chatId: -200, messageId: 9, text: '新的视频描述' });
        assert.strictEqual(r.body.telegramEditVia, 'channel');
        const msg = deps.getCollection('message').docs.find(m => m.file_unique_id === 'AQAD2');
        assert.strictEqual(msg.text, '新的视频描述');
        assert.strictEqual(msg.group_id, '-100_1');
        // 组内本来就有一条文本，is_delete 仍应为 0
        assert.strictEqual(deps.getCollection('group_list').docs.find(g => g.group_id === '-100_1').is_delete, 0);
    });
});

test('POST /api/media/description：频道位置改不了时自动降级到群组位置', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    const captionCalls = [];
    deps.editCaption = async (chatId, messageId, text) => {
        captionCalls.push({ chatId, messageId });
        if (chatId === -200) throw new Error("ETELEGRAM: 400 Bad Request: message can't be edited");
        return true;
    };
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/media/description', {
            method: 'POST',
            body: JSON.stringify({ fileUniqueId: 'AQAD2', text: '降级到群组' })
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.telegramEdited, true);
        assert.strictEqual(r.body.telegramEditVia, 'group');
        assert.deepStrictEqual(captionCalls.map(c => `${c.chatId}/${c.messageId}`), ['-200/9', '-100/12']);
        // 库记录按实际改成功的位置更新
        const msg = deps.getCollection('message').docs.find(m => m.file_unique_id === 'AQAD2');
        assert.strictEqual(msg.text, '降级到群组');
    });
});

test('POST /api/media/description 清空描述：删除 message 并把 is_delete 记为时间戳', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    const cleared = [];
    deps.editCaption = async (chatId, messageId, text) => { cleared.push(text); return true; };
    await withDomain(deps, async (b, auth) => {
        // -100_2 只有一条文本（AQAD21），清空后组内无文本 → 可清理
        const r = await domainReq(b, auth, '/api/media/description', {
            method: 'POST',
            body: JSON.stringify({ fileUniqueId: 'AQAD21', text: '   ' })
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.clearing, true);
        assert.deepStrictEqual(cleared, [null], '清空时向 Telegram 传 null');
        assert.ok(!deps.getCollection('message').docs.some(m => m.file_unique_id === 'AQAD21'));
        assert.ok(deps.getCollection('group_list').docs.find(g => g.group_id === '-100_2').is_delete > 0);
    });
});

test('POST /api/media/description：Telegram 失败时数据库仍更新并回报错误', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    deps.editCaption = async () => { throw new Error("message can't be edited"); };
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/media/description', {
            method: 'POST',
            body: JSON.stringify({ fileUniqueId: 'AQAD3', text: '超时也能改库' })
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.telegramEdited, false);
        assert.match(r.body.telegramError, /can't be edited/);
        assert.strictEqual(deps.getCollection('message').docs.find(m => m.file_unique_id === 'AQAD3').text, '超时也能改库');
    });
});

test('POST /api/media/description：未知媒体 404、缺参 400、可跳过 Telegram（editTelegram:false）', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    let called = 0;
    deps.editCaption = async () => { called++; return true; };
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/media/description', { method: 'POST', body: JSON.stringify({ text: 'x' }) })).status, 400);
        assert.strictEqual((await domainReq(b, auth, '/api/media/description', { method: 'POST', body: JSON.stringify({ fileUniqueId: 'NOPE', text: 'x' }) })).status, 404);
        const r = await domainReq(b, auth, '/api/media/description', {
            method: 'POST',
            body: JSON.stringify({ fileUniqueId: 'AQAD41', text: '仅改库', editTelegram: false })
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.telegramEdited, false);
        assert.strictEqual(called, 0, 'editTelegram:false 不应调用 Telegram');
    });
});

// ---------------- 用户增删改 ----------------

test('POST /api/users/create：校验 id、拒绝重复、写入默认字段', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/users/create', { method: 'POST', body: JSON.stringify({}) })).status, 400);
        assert.strictEqual((await domainReq(b, auth, '/api/users/create', { method: 'POST', body: JSON.stringify({ id: 123 }) })).status, 409);

        const r = await domainReq(b, auth, '/api/users/create', {
            method: 'POST',
            body: JSON.stringify({ id: 555, name: '新用户', white: 1, group: [-100, 'bad'] })
        });
        assert.strictEqual(r.status, 200);
        const doc = deps.getCollection('users').docs.find(u => u.id === 555);
        assert.strictEqual(doc.name, '新用户');
        assert.strictEqual(doc.white, 1);
        assert.strictEqual(doc.state, 1);
        assert.deepStrictEqual(doc.group, [-100], '非法群组 ID 被过滤');
    });
});

test('POST /api/users/update：字段白名单 + 未找到 404 + 空 patch 400', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/users/update', { method: 'POST', body: JSON.stringify({ id: 123, patch: {} }) })).status, 400);
        assert.strictEqual((await domainReq(b, auth, '/api/users/update', { method: 'POST', body: JSON.stringify({ id: 999, patch: { white: 1 } }) })).status, 404);

        const r = await domainReq(b, auth, '/api/users/update', {
            method: 'POST',
            body: JSON.stringify({ id: 123, patch: { white: 0, state: 0, name: '改名', hack: true } })
        });
        assert.strictEqual(r.status, 200);
        const doc = deps.getCollection('users').docs.find(u => u.id === 123);
        assert.strictEqual(doc.white, 0);
        assert.strictEqual(doc.state, 0);
        assert.strictEqual(doc.name, '改名');
        assert.ok(!('hack' in doc), '非白名单字段被忽略');
    });
});

test('POST /api/users/delete：必须二次确认，删除后不可再删', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/users/delete', { method: 'POST', body: JSON.stringify({ id: 456 }) })).status, 400);
        const r = await domainReq(b, auth, '/api/users/delete', { method: 'POST', body: JSON.stringify({ id: 456, confirm: true }) });
        assert.strictEqual(r.status, 200);
        assert.ok(!deps.getCollection('users').docs.some(u => u.id === 456));
        assert.strictEqual((await domainReq(b, auth, '/api/users/delete', { method: 'POST', body: JSON.stringify({ id: 456, confirm: true }) })).status, 404);
    });
});

// ---------------- 聊天（群组/频道）增删改 ----------------

test('POST /api/groups/create：校验 type、拒绝重复、双向绑定', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/groups/create', { method: 'POST', body: JSON.stringify({ id: -500 }) })).status, 400);
        assert.strictEqual((await domainReq(b, auth, '/api/groups/create', { method: 'POST', body: JSON.stringify({ id: -100, type: 'channel' }) })).status, 409);

        const r = await domainReq(b, auth, '/api/groups/create', {
            method: 'POST',
            body: JSON.stringify({ id: -500, type: 'channel', name: '新频道', bind_id: -300 })
        });
        assert.strictEqual(r.status, 200);
        const docs = deps.getCollection('channel_group').docs;
        assert.strictEqual(docs.find(c => c.id === -500).name, '新频道');
        assert.strictEqual(docs.find(c => c.id === -300).bind_id, -500, '对端应反向绑定');
        assert.strictEqual(docs.find(c => c.id === -300).is_bound, true);
    });
});

test('POST /api/groups/update：改名/重新绑定会清掉旧对端绑定', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/groups/update', {
            method: 'POST',
            body: JSON.stringify({ id: -100, patch: { name: '频道改名', bind_id: -300 } })
        });
        assert.strictEqual(r.status, 200);
        const docs = deps.getCollection('channel_group').docs;
        assert.strictEqual(docs.find(c => c.id === -100).name, '频道改名');
        assert.strictEqual(docs.find(c => c.id === -100).bind_id, -300);
        assert.strictEqual(docs.find(c => c.id === -200).bind_id, null, '旧对端 -200 的绑定被清除');
        assert.strictEqual(docs.find(c => c.id === -200).is_bound, false);
        assert.strictEqual(docs.find(c => c.id === -300).bind_id, -100, '新对端反向绑定');

        // 解绑
        const unbind = await domainReq(b, auth, '/api/groups/update', {
            method: 'POST',
            body: JSON.stringify({ id: -100, patch: { bind_id: null } })
        });
        assert.strictEqual(unbind.status, 200);
        assert.strictEqual(docs.find(c => c.id === -100).is_bound, false);
        assert.strictEqual(docs.find(c => c.id === -300).bind_id, null);
    });
});

test('POST /api/groups/delete：二次确认 + 清理对端绑定', async () => {
    const deps = makeMemoryDeps(makeDomainData());
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/groups/delete', { method: 'POST', body: JSON.stringify({ id: -100 }) })).status, 400);
        const r = await domainReq(b, auth, '/api/groups/delete', { method: 'POST', body: JSON.stringify({ id: -100, confirm: true }) });
        assert.strictEqual(r.status, 200);
        const docs = deps.getCollection('channel_group').docs;
        assert.ok(!docs.some(c => c.id === -100));
        assert.strictEqual(docs.find(c => c.id === -200).bind_id, null, '对端绑定被清理');
        assert.strictEqual((await domainReq(b, auth, '/api/groups/delete', { method: 'POST', body: JSON.stringify({ id: -100, confirm: true }) })).status, 404);
    });
});

// ---------------- 操作日志与统计报表 ----------------

/** 造一批新 schema 日志（含跨月数据，便于验证月表口径） */
function makeLogData() {
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    return [
        { _id: 'n1', action: 'media_save', actionLabel: '媒体收录', category: 'media', result: 'ok', source: 'group', time: now - day, date: new Date(now - day), userId: 123, chatId: -100, target: { type: 'media_group', id: '-100_1' }, counts: { media: 1, groups: 1 }, detail: { mediaType: 'photo', hasCaption: true } },
        { _id: 'n2', action: 'media_save', actionLabel: '媒体收录', category: 'media', result: 'ok', source: 'group', time: now - day - 1000, date: new Date(now - day - 1000), userId: 456, counts: { media: 1 }, detail: { mediaType: 'video' } },
        { _id: 'n3', action: 'query_keyword', actionLabel: '关键字查询', category: 'query', result: 'ok', source: 'private', time: now - 2 * 3600 * 1000, date: new Date(now - 2 * 3600 * 1000), userId: 123, counts: { queries: 1 }, detail: { query: 'JK', results: 0 } },
        { _id: 'n4', action: 'media_edit', actionLabel: '媒体描述修改', category: 'media', result: 'fail', source: 'private', time: now - 3600 * 1000, date: new Date(now - 3600 * 1000), userId: 789, error: '编辑失败' },
        { _id: 'n5', action: 'send_media', actionLabel: '发送媒体', category: 'send', result: 'ok', source: 'private', time: now - 30 * day, date: new Date(now - 30 * day), userId: 123, counts: { media: 3, groups: 1 } },
        { _id: 'l1', type: 1, time: now - 5 * day, userId: 123 },  // 旧数据（无 action/date）
        { _id: 'l2', type: 22, time: now - 5 * day - 10, userId: 456 }
    ];
}

test('GET /api/oplogs 返回新字段、支持筛选与分页', async () => {
    const deps = makeMemoryDeps({ log: makeLogData() });
    await withDomain(deps, async (b, auth) => {
        // 登录本身会写一条 webui_login 审计日志，先清掉以便精确计数
        const logCol = deps.getCollection('log');
        logCol.docs.splice(0, logCol.docs.length, ...makeLogData());

        const all = await domainReq(b, auth, '/api/oplogs?pageSize=50');
        assert.strictEqual(all.status, 200);
        assert.strictEqual(all.body.total, 7);
        const first = all.body.items[0];
        assert.deepStrictEqual(Object.keys(first).sort(), [
            'action', 'actionLabel', 'category', 'chatId', 'counts', 'date', 'detail',
            'durationMs', 'error', 'result', 'source', 'target', 'time', 'type', 'userId', '_id'
        ].sort());
        assert.ok(all.body.catalog.actions.some(a => a.action === 'media_save'), '返回动作目录供前端展示');

        const legacy = all.body.items.find(i => i._id === 'l1');
        assert.strictEqual(legacy.action, 'media_save', '旧数据按 type 归类');
        assert.strictEqual(legacy.actionLabel, '媒体收录');

        const failed = await domainReq(b, auth, '/api/oplogs?result=fail');
        assert.strictEqual(failed.body.total, 1);
        assert.strictEqual(failed.body.items[0].action, 'media_edit');

        const byCategory = await domainReq(b, auth, '/api/oplogs?category=query');
        assert.strictEqual(byCategory.body.total, 2);

        const byAction = await domainReq(b, auth, '/api/oplogs?action=media_save');
        assert.strictEqual(byAction.body.total, 3, '含旧数据归类结果');

        const byUser = await domainReq(b, auth, '/api/oplogs?userId=789');
        assert.strictEqual(byUser.body.total, 1);

        const search = await domainReq(b, auth, '/api/oplogs?q=' + encodeURIComponent('编辑失败'));
        assert.strictEqual(search.body.total, 1, '可搜索 error 内容');

        const paged = await domainReq(b, auth, '/api/oplogs?page=1&pageSize=3');
        assert.strictEqual(paged.body.items.length, 3);
        assert.strictEqual(paged.body.total, 7);
    });
});

test('GET /api/stats 月份报表：汇总/每日趋势/动作与用户分布/环比', async () => {
    const deps = makeMemoryDeps({ log: makeLogData() });
    await withDomain(deps, async (b, auth) => {
        const logCol = deps.getCollection('log');
        logCol.docs.splice(0, logCol.docs.length, ...makeLogData());
        const r = await domainReq(b, auth, '/api/stats?period=month');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.period, 'month');
        assert.ok(r.body.totals.operations >= 5, `本月应统计到多条操作，实际 ${r.body.totals.operations}`);
        assert.ok(r.body.totals.media >= 2, '媒体产出量应被汇总（counts 求和）');
        assert.ok(Array.isArray(r.body.byDay) && r.body.byDay.length > 0, '应有每日趋势');
        assert.ok(r.body.byDay[0].day && /^\d{4}-\d{2}-\d{2}$/.test(r.body.byDay[0].day), '日期为北京时间自然日');
        assert.ok(r.body.byAction.some(a => a.action === 'media_save' && a.count >= 2));
        assert.ok(r.body.byCategory.some(c => c.category === 'media'));
        assert.ok(r.body.topUsers.some(u => u.userId === 123));
        assert.ok(r.body.failures.count >= 1, '失败计数进入报表');
        assert.ok(r.body.previous && 'operationsDelta' in r.body.previous, '应带环比信息');
        assert.ok(r.body.catalog.actions.length > 10);

        // 每日方格图可按查看项切换：byDay 里带分动作 / 分类计数
        const dayWithLogs = r.body.byDay.find(x => x.count > 0);
        assert.ok(dayWithLogs.actions && typeof dayWithLogs.actions === 'object', '每日数据应带分动作计数');
        assert.ok(dayWithLogs.categories && typeof dayWithLogs.categories === 'object', '每日数据应带分类计数');
        const actionSum = Object.values(dayWithLogs.actions).reduce((s, v) => s + v, 0);
        assert.strictEqual(actionSum, dayWithLogs.count, '分动作计数之和 = 当天操作数');
        const categorySum = Object.values(dayWithLogs.categories).reduce((s, v) => s + v, 0);
        assert.strictEqual(categorySum, dayWithLogs.count, '分类计数之和 = 当天操作数');

        const year = await domainReq(b, auth, '/api/stats?period=year&year=' + new Date().getFullYear());
        assert.strictEqual(year.body.period, 'year');
        assert.ok(year.body.totals.operations >= r.body.totals.operations, '年报表应包含月报表');

        assert.strictEqual((await domainReq(b, auth, '/api/stats?year=1900')).status, 400);
    });
});

test('GET /api/stats 没有日志时返回零值结构而不报错', async () => {
    const deps = makeMemoryDeps({ log: [] });
    await withDomain(deps, async (b, auth) => {
        const logCol = deps.getCollection('log');
        logCol.docs.splice(0, logCol.docs.length); // 清掉登录审计日志
        const r = await domainReq(b, auth, '/api/stats?period=month');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.totals.operations, 0);
        assert.deepStrictEqual(r.body.byDay, []);
        assert.deepStrictEqual(r.body.byAction, []);
        assert.strictEqual(r.body.byHour.length, 24, '没有日志也返回 24 个小时桶');
        assert.ok(r.body.byHour.every(h => h.count === 0));
    });
});

test('GET /api/stats 返回活跃时间：24 个小时桶，按北京时间整点归桶', async () => {
    const deps = makeMemoryDeps({ log: [] });
    await withDomain(deps, async (b, auth) => {
        const logCol = deps.getCollection('log');
        // 固定时间点：UTC 01:00 = 北京 09:00；UTC 13:00 = 北京 21:00
        const utc = Date.UTC(2026, 0, 15, 1, 0, 0);
        logCol.docs.splice(0, logCol.docs.length,
            { _id: 'h1', action: 'media_save', result: 'ok', time: utc, date: new Date(utc), counts: { media: 2 } },
            { _id: 'h2', action: 'media_save', result: 'ok', time: utc, date: new Date(utc) },
            { _id: 'h3', action: 'query_keyword', result: 'ok', time: utc + 12 * 3600 * 1000, date: new Date(utc + 12 * 3600 * 1000), counts: { media: 3 } }
        );
        const r = await domainReq(b, auth, '/api/stats?period=month&year=2026&month=1');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.byHour.length, 24);
        assert.deepStrictEqual(r.body.byHour.map(h => h.hour), Array.from({ length: 24 }, (_, h) => h), '小时按 0..23 排列');
        assert.strictEqual(r.body.byHour[9].count, 2, 'UTC 01:00 → 北京 09:00');
        assert.strictEqual(r.body.byHour[9].media, 2, '该小时的媒体产出也汇总');
        assert.strictEqual(r.body.byHour[21].count, 1, 'UTC 13:00 → 北京 21:00');
        assert.strictEqual(r.body.byHour[21].media, 3);
        assert.strictEqual(r.body.byHour.reduce((sum, h) => sum + h.count, 0), r.body.totals.operations, '小时桶总数 = 操作总数');
    });
});

// ---------------- 搬运收录（transport）增删改查 + 链接活性 ----------------

function makeTransportData() {
    return {
        transport: [
            { chat_id: -1001, chat_name: '有效频道', url: 'https://t.me/alive', num: 5, alive: true, last_check_at: NOW - 1000, last_check_status: 'ok' },
            { chat_id: -1002, chat_name: '失效频道', url: 'https://t.me/dead', num: 3, alive: false, last_check_at: NOW - 2000, last_check_status: 'dead', last_check_error: 'chat not found' },
            { chat_id: -1003, chat_name: '未检查频道', url: 'https://t.me/unknown', num: 1 },
            { chat_id: -1001234567890, chat_name: '无链接记录', num: 0 }
        ]
    };
}

test('GET /api/transport：排序 / 状态筛选 / 计数 / 跳转链接', async () => {
    const deps = makeMemoryDeps(makeTransportData());
    await withDomain(deps, async (b, auth) => {
        const all = await domainReq(b, auth, '/api/transport');
        assert.strictEqual(all.status, 200);
        assert.strictEqual(all.body.total, 4);
        assert.deepStrictEqual(all.body.counts, { all: 4, alive: 1, dead: 1, unchecked: 2 });
        assert.strictEqual(all.body.items[0].chat_id, -1001, '按搬运次数降序');
        assert.strictEqual(all.body.items[0].link, 'https://t.me/alive');
        assert.strictEqual(all.body.items[0].alive, true);

        const noUrl = all.body.items.find(i => i.chat_id === -1001234567890);
        assert.strictEqual(noUrl.link, 'https://t.me/c/1234567890', '无 url 时由 chat_id 推导 t.me/c 链接');
        assert.strictEqual(noUrl.alive, null, '未检查为 null');

        const dead = await domainReq(b, auth, '/api/transport?status=dead');
        assert.strictEqual(dead.body.total, 1);
        assert.strictEqual(dead.body.items[0].chat_id, -1002);
        assert.strictEqual(dead.body.items[0].last_check_error, 'chat not found');

        const unchecked = await domainReq(b, auth, '/api/transport?status=unchecked');
        assert.strictEqual(unchecked.body.total, 2, '字段缺失与 null 都算未检查');

        const search = await domainReq(b, auth, '/api/transport?q=' + encodeURIComponent('失效'));
        assert.strictEqual(search.body.total, 1);
        const byId = await domainReq(b, auth, '/api/transport?q=-1003');
        assert.strictEqual(byId.body.total, 1, '纯数字关键词按 chat_id 精确匹配');
    });
});

test('POST /api/transport/create：校验 chat_id/链接、拒绝重复', async () => {
    const deps = makeMemoryDeps(makeTransportData());
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/transport/create', { method: 'POST', body: JSON.stringify({ url: 'https://t.me/x' }) })).status, 400);
        assert.strictEqual((await domainReq(b, auth, '/api/transport/create', { method: 'POST', body: JSON.stringify({ chat_id: -2001 }) })).status, 400);
        assert.strictEqual((await domainReq(b, auth, '/api/transport/create', { method: 'POST', body: JSON.stringify({ chat_id: -1001, url: 'https://t.me/x' }) })).status, 409);

        const r = await domainReq(b, auth, '/api/transport/create', {
            method: 'POST',
            body: JSON.stringify({ chat_id: -2001, chat_name: '新频道', url: 'https://t.me/new', num: 2 })
        });
        assert.strictEqual(r.status, 200);
        const doc = deps.getCollection('transport').docs.find(t => t.chat_id === -2001);
        assert.strictEqual(doc.chat_name, '新频道');
        assert.strictEqual(doc.num, 2);
        assert.strictEqual(doc.alive, null, '新建记录默认未检查');
        assert.ok(doc.created_at > 0);
    });
});

test('POST /api/transport/update：改名字/链接，改链接后活性作废', async () => {
    const deps = makeMemoryDeps(makeTransportData());
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/transport/update', { method: 'POST', body: JSON.stringify({ chat_id: -1001, patch: {} }) })).status, 400);
        assert.strictEqual((await domainReq(b, auth, '/api/transport/update', { method: 'POST', body: JSON.stringify({ chat_id: -9999, patch: { chat_name: 'x' } }) })).status, 404);
        assert.strictEqual((await domainReq(b, auth, '/api/transport/update', { method: 'POST', body: JSON.stringify({ chat_id: -1001, patch: { url: '' } }) })).status, 400);

        const rename = await domainReq(b, auth, '/api/transport/update', {
            method: 'POST', body: JSON.stringify({ chat_id: -1001, patch: { chat_name: '改名后' } })
        });
        assert.strictEqual(rename.status, 200);
        const doc = deps.getCollection('transport').docs.find(t => t.chat_id === -1001);
        assert.strictEqual(doc.chat_name, '改名后');
        assert.strictEqual(doc.alive, true, '只改名字不影响活性结论');

        const relink = await domainReq(b, auth, '/api/transport/update', {
            method: 'POST', body: JSON.stringify({ chat_id: -1001, patch: { url: 'https://t.me/other', num: 9 } })
        });
        assert.strictEqual(relink.status, 200);
        assert.strictEqual(doc.url, 'https://t.me/other');
        assert.strictEqual(doc.num, 9);
        assert.strictEqual(doc.alive, null, '链接变化后活性作废，等待重新检查');
        assert.strictEqual(doc.last_check_status, null);
    });
});

test('POST /api/transport/delete：二次确认 + 删除后 404', async () => {
    const deps = makeMemoryDeps(makeTransportData());
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/transport/delete', { method: 'POST', body: JSON.stringify({ chat_id: -1002 }) })).status, 400);
        const r = await domainReq(b, auth, '/api/transport/delete', { method: 'POST', body: JSON.stringify({ chat_id: -1002, confirm: true }) });
        assert.strictEqual(r.status, 200);
        assert.ok(!deps.getCollection('transport').docs.some(t => t.chat_id === -1002));
        assert.strictEqual((await domainReq(b, auth, '/api/transport/delete', { method: 'POST', body: JSON.stringify({ chat_id: -1002, confirm: true }) })).status, 404);
    });
});

test('POST /api/transport/check：单条写回活性结论、全部检查返回汇总', async () => {
    const deps = makeMemoryDeps(makeTransportData());
    deps.checkTransportLink = async () => ({ status: 'dead', error: 'ETELEGRAM: 400 chat not found', chat_name: '有效频道改名' });
    deps.checkAllTransports = async () => ({
        total: 4, checked: 4, ok: 2,
        dead: [{ chat_id: -1004, chat_name: '挂了', check_error: 'chat not found' }],
        newlyDead: [{ chat_id: -1004, chat_name: '挂了', check_error: 'chat not found' }],
        recovered: [], unknown: [], skipped: 0
    });
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/transport/check', { method: 'POST', body: JSON.stringify({ chat_id: -9999 }) })).status, 404);

        const one = await domainReq(b, auth, '/api/transport/check', { method: 'POST', body: JSON.stringify({ chat_id: -1001 }) });
        assert.strictEqual(one.status, 200);
        assert.strictEqual(one.body.item.alive, false);
        assert.strictEqual(one.body.item.last_check_status, 'dead');
        assert.ok(one.body.item.last_check_at > 0);
        assert.strictEqual(one.body.item.chat_name, '有效频道改名', '检查成功时同步真实会话名');
        const doc = deps.getCollection('transport').docs.find(t => t.chat_id === -1001);
        assert.strictEqual(doc.alive, false, '结论写回数据库');

        const all = await domainReq(b, auth, '/api/transport/check', { method: 'POST', body: JSON.stringify({}) });
        assert.strictEqual(all.status, 200);
        assert.deepStrictEqual(all.body.summary, {
            total: 4, checked: 4, ok: 2, dead: 1, unknown: 0,
            newlyDead: [{ chat_id: -1004, chat_name: '挂了', error: 'chat not found' }]
        });
    });
});

// ---------------- 文章 / 子文章增删改查 ----------------

test('文章：列表带子文章、新建、修改、级联删除', async () => {
    const deps = makeMemoryDeps({
        article: [{ id: 1, title: '旧文章', link: 'https://telegra.ph/old', created_at: NOW - 5000, updated_at: NOW - 5000 }],
        sub_article: [{ id: 1, article_id: 1, title: '第一章', link: 'https://telegra.ph/1', created_at: NOW - 4000, updated_at: NOW - 4000 }]
    });
    await withDomain(deps, async (b, auth) => {
        const list = await domainReq(b, auth, '/api/articles?withSubs=1');
        assert.strictEqual(list.status, 200);
        assert.strictEqual(list.body.total, 1);
        assert.strictEqual(list.body.subTotal, 1);
        assert.strictEqual(list.body.items[0].subCount, 1);
        assert.strictEqual(list.body.items[0].subs[0].title, '第一章');

        assert.strictEqual((await domainReq(b, auth, '/api/articles/create', { method: 'POST', body: JSON.stringify({ title: '  ' }) })).status, 400);
        const created = await domainReq(b, auth, '/api/articles/create', {
            method: 'POST', body: JSON.stringify({ title: '新文章', link: 'https://telegra.ph/new' })
        });
        assert.strictEqual(created.status, 200);
        assert.strictEqual(created.body.id, 2, 'id 自增');
        assert.strictEqual(created.body.item.title, '新文章');

        assert.strictEqual((await domainReq(b, auth, '/api/articles/update', { method: 'POST', body: JSON.stringify({ id: 2, patch: {} }) })).status, 400);
        assert.strictEqual((await domainReq(b, auth, '/api/articles/update', { method: 'POST', body: JSON.stringify({ id: 999, patch: { title: 'x' } }) })).status, 404);
        const renamed = await domainReq(b, auth, '/api/articles/update', {
            method: 'POST', body: JSON.stringify({ id: 2, patch: { title: '改名', hack: 1 } })
        });
        assert.strictEqual(renamed.status, 200);
        const doc = deps.getCollection('article').docs.find(a => a.id === 2);
        assert.strictEqual(doc.title, '改名');
        assert.ok(!('hack' in doc), '非白名单字段被忽略');

        assert.strictEqual((await domainReq(b, auth, '/api/articles/delete', { method: 'POST', body: JSON.stringify({ id: 1 }) })).status, 400);
        const del = await domainReq(b, auth, '/api/articles/delete', { method: 'POST', body: JSON.stringify({ id: 1, confirm: true }) });
        assert.strictEqual(del.status, 200);
        assert.strictEqual(del.body.removedSubs, 1, '子文章级联删除');
        assert.ok(!deps.getCollection('article').docs.some(a => a.id === 1));
        assert.ok(!deps.getCollection('sub_article').docs.some(s => s.article_id === 1));
    });
});

test('子文章：增删改 + 同步父文章 updated_at', async () => {
    const deps = makeMemoryDeps({
        article: [{ id: 1, title: '文章', link: '', created_at: NOW - 5000, updated_at: NOW - 5000 }],
        sub_article: []
    });
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/articles/sub/create', { method: 'POST', body: JSON.stringify({ article_id: 999, title: 'x' }) })).status, 404);
        assert.strictEqual((await domainReq(b, auth, '/api/articles/sub/create', { method: 'POST', body: JSON.stringify({ article_id: 1 }) })).status, 400);

        const created = await domainReq(b, auth, '/api/articles/sub/create', {
            method: 'POST', body: JSON.stringify({ article_id: 1, title: '第一章', link: 'https://telegra.ph/s1' })
        });
        assert.strictEqual(created.status, 200);
        const subId = created.body.id;
        assert.strictEqual(deps.getCollection('sub_article').docs[0].article_id, 1);
        assert.ok(deps.getCollection('article').docs[0].updated_at > NOW - 5000, '父文章 updated_at 被刷新');

        const subUpdate = await domainReq(b, auth, '/api/articles/sub/update', {
            method: 'POST', body: JSON.stringify({ id: subId, patch: { title: '第二章', link: '' } })
        });
        assert.strictEqual(subUpdate.status, 200);
        assert.strictEqual(subUpdate.body.item.title, '第二章');
        assert.strictEqual((await domainReq(b, auth, '/api/articles/sub/update', { method: 'POST', body: JSON.stringify({ id: 999, patch: { title: 'x' } }) })).status, 404);

        assert.strictEqual((await domainReq(b, auth, '/api/articles/sub/delete', { method: 'POST', body: JSON.stringify({ id: subId }) })).status, 400);
        const del = await domainReq(b, auth, '/api/articles/sub/delete', { method: 'POST', body: JSON.stringify({ id: subId, confirm: true }) });
        assert.strictEqual(del.status, 200);
        assert.deepStrictEqual(deps.getCollection('sub_article').docs, []);
    });
});

// ---------------- 合集 / 杂集增删改查 ----------------

test('合集：列表按类型筛选、新建/修改校验 type、级联删除子项', async () => {
    const deps = makeMemoryDeps({
        collection: [
            { id: 1, name: '合集A', type: 'collection', created_at: NOW - 3000, updated_at: NOW - 3000 },
            { id: 2, name: '杂集B', type: 'misc', created_at: NOW - 2000, updated_at: NOW - 2000 }
        ],
        sub_collection: [{ id: 1, collection_id: 1, name: '子项1', link: 'https://t.me/x', created_at: NOW, updated_at: NOW }]
    });
    await withDomain(deps, async (b, auth) => {
        const all = await domainReq(b, auth, '/api/collections?withSubs=1');
        assert.strictEqual(all.status, 200);
        assert.deepStrictEqual(all.body.counts, { all: 2, collection: 1, misc: 1 });
        assert.strictEqual(all.body.subTotal, 1);
        assert.strictEqual(all.body.items.find(c => c.id === 1).subCount, 1);

        const onlyMisc = await domainReq(b, auth, '/api/collections?type=misc');
        assert.strictEqual(onlyMisc.body.items.length, 1);
        assert.strictEqual(onlyMisc.body.items[0].id, 2);

        assert.strictEqual((await domainReq(b, auth, '/api/collections/create', { method: 'POST', body: JSON.stringify({ name: '', type: 'collection' }) })).status, 400);
        assert.strictEqual((await domainReq(b, auth, '/api/collections/create', { method: 'POST', body: JSON.stringify({ name: 'x', type: 'bad' }) })).status, 400);
        const created = await domainReq(b, auth, '/api/collections/create', {
            method: 'POST', body: JSON.stringify({ name: '新杂集', type: 'misc' })
        });
        assert.strictEqual(created.status, 200);
        assert.strictEqual(created.body.id, 3);

        assert.strictEqual((await domainReq(b, auth, '/api/collections/update', { method: 'POST', body: JSON.stringify({ id: 999, patch: { name: 'x' } }) })).status, 404);
        assert.strictEqual((await domainReq(b, auth, '/api/collections/update', { method: 'POST', body: JSON.stringify({ id: 3, patch: { type: 'nope' } }) })).status, 400);
        const moved = await domainReq(b, auth, '/api/collections/update', {
            method: 'POST', body: JSON.stringify({ id: 3, patch: { name: '改名', type: 'collection' } })
        });
        assert.strictEqual(moved.status, 200);
        assert.strictEqual(moved.body.item.type, 'collection');

        const del = await domainReq(b, auth, '/api/collections/delete', { method: 'POST', body: JSON.stringify({ id: 1, confirm: true }) });
        assert.strictEqual(del.status, 200);
        assert.strictEqual(del.body.removedSubs, 1);
        assert.ok(!deps.getCollection('sub_collection').docs.some(s => s.collection_id === 1));
    });
});

test('子合集：增删改 + 同步父合集 updated_at', async () => {
    const deps = makeMemoryDeps({
        collection: [{ id: 1, name: '合集', type: 'collection', created_at: NOW - 5000, updated_at: NOW - 5000 }],
        sub_collection: []
    });
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/collections/sub/create', { method: 'POST', body: JSON.stringify({ collection_id: 999, name: 'x' }) })).status, 404);
        const created = await domainReq(b, auth, '/api/collections/sub/create', {
            method: 'POST', body: JSON.stringify({ collection_id: 1, name: '子项', link: 'https://t.me/a' })
        });
        assert.strictEqual(created.status, 200);
        assert.ok(deps.getCollection('collection').docs[0].updated_at > NOW - 5000);

        const subId = created.body.id;
        const updated = await domainReq(b, auth, '/api/collections/sub/update', {
            method: 'POST', body: JSON.stringify({ id: subId, patch: { name: '子项改名' } })
        });
        assert.strictEqual(updated.status, 200);
        assert.strictEqual(updated.body.item.name, '子项改名');
        assert.strictEqual((await domainReq(b, auth, '/api/collections/sub/update', { method: 'POST', body: JSON.stringify({ id: subId, patch: {} }) })).status, 400);

        const del = await domainReq(b, auth, '/api/collections/sub/delete', { method: 'POST', body: JSON.stringify({ id: subId, confirm: true }) });
        assert.strictEqual(del.status, 200);
        assert.deepStrictEqual(deps.getCollection('sub_collection').docs, []);
    });
});

// ---------------- 标签库：增删 / 置顶 / 拖拽排序 ----------------

test('标签接口：新建（大写去重）/ 置顶（上限 40）/ 排序 / 删除（同步 message）', async () => {
    const deps = makeMemoryDeps({
        tags: [
            { _id: 't1', name: 'AAA', pin: 1, count: 3 },
            { _id: 't2', name: 'BBB', pin: 0, count: 1 },
            { _id: 't3', name: 'CCC', pin: 0, count: 0 }
        ],
        message: [
            { _id: 's1', file_unique_id: 'F1', text: 'x', tags: ['CCC'] },
            { _id: 's2', file_unique_id: 'F2', text: 'y', tags: ['AAA', 'CCC'] }
        ]
    });
    await withDomain(deps, async (b, auth) => {
        expect: {
            assert.strictEqual((await domainReq(b, auth, '/api/tags/create', { method: 'POST', body: JSON.stringify({}) })).status, 400);
            assert.strictEqual((await domainReq(b, auth, '/api/tags/create', { method: 'POST', body: JSON.stringify({ name: 'x'.repeat(21) }) })).status, 400);
        }
        const created = await domainReq(b, auth, '/api/tags/create', { method: 'POST', body: JSON.stringify({ name: ' new tag ' }) });
        assert.strictEqual(created.status, 200);
        assert.strictEqual(created.body.name, 'NEW TAG', '标签名统一大写');
        assert.strictEqual((await domainReq(b, auth, '/api/tags/create', { method: 'POST', body: JSON.stringify({ name: 'aaa' }) })).status, 409, '重名返回 409');

        const capped = await domainReq(b, auth, '/api/tags/pin', { method: 'POST', body: JSON.stringify({ name: 'BBB', pin: 41 }) });
        assert.strictEqual(capped.body.pin, 40, '置顶位置上限 40');
        const unpin = await domainReq(b, auth, '/api/tags/pin', { method: 'POST', body: JSON.stringify({ name: 'AAA', pin: 0 }) });
        assert.strictEqual(unpin.body.pin, 0);
        assert.strictEqual((await domainReq(b, auth, '/api/tags/pin', { method: 'POST', body: JSON.stringify({ name: 'NOPE', pin: 1 }) })).status, 404);

        const order = ['CCC', 'AAA', 'BBB'];
        const reordered = await domainReq(b, auth, '/api/tags/reorder', { method: 'POST', body: JSON.stringify({ names: order }) });
        assert.strictEqual(reordered.status, 200);
        assert.strictEqual(reordered.body.updated, 3);
        const tags = deps.getCollection('tags').docs;
        assert.strictEqual(tags.find(t => t.name === 'CCC').pin, 1, '拖拽后的顺序 = 置顶 1..N');
        assert.strictEqual(tags.find(t => t.name === 'AAA').pin, 2);
        assert.strictEqual(tags.find(t => t.name === 'BBB').pin, 3);
        assert.strictEqual((await domainReq(b, auth, '/api/tags/reorder', { method: 'POST', body: JSON.stringify({ names: [] }) })).status, 400);

        assert.strictEqual((await domainReq(b, auth, '/api/tags/delete', { method: 'POST', body: JSON.stringify({ name: 'CCC' }) })).status, 400, '删除需二次确认');
        const del = await domainReq(b, auth, '/api/tags/delete', { method: 'POST', body: JSON.stringify({ name: 'CCC', confirm: true }) });
        assert.strictEqual(del.status, 200);
        assert.strictEqual(del.body.synced, 2, '同步清理了 2 条消息');
        assert.ok(!deps.getCollection('tags').docs.some(t => t.name === 'CCC'));
        assert.ok(!deps.getCollection('message').docs.some(m => (m.tags || []).includes('CCC')));
        assert.strictEqual((await domainReq(b, auth, '/api/tags/delete', { method: 'POST', body: JSON.stringify({ name: 'CCC', confirm: true }) })).status, 404);
    });
});

test('标签接口：改名（同步 message）/ 校验重名与不存在', async () => {
    const deps = makeMemoryDeps({
        tags: [
            { _id: 't1', name: 'JK', pin: 1, count: 3 },
            { _id: 't2', name: 'CAT', pin: 0, count: 1 }
        ],
        message: [
            { _id: 's1', file_unique_id: 'F1', text: 'x', tags: ['JK'] },
            { _id: 's2', file_unique_id: 'F2', text: 'y', tags: ['JK', 'CAT'] },
            { _id: 's3', file_unique_id: 'F3', text: 'z', tags: [] }
        ]
    });
    await withDomain(deps, async (b, auth) => {
        assert.strictEqual((await domainReq(b, auth, '/api/tags/rename', { method: 'POST', body: JSON.stringify({ name: 'JK' }) })).status, 400, '缺新名字');
        assert.strictEqual((await domainReq(b, auth, '/api/tags/rename', { method: 'POST', body: JSON.stringify({ to: 'X' }) })).status, 400, '缺原名字');
        assert.strictEqual((await domainReq(b, auth, '/api/tags/rename', { method: 'POST', body: JSON.stringify({ name: 'NOPE', to: 'X' }) })).status, 404, '原标签不存在');
        assert.strictEqual((await domainReq(b, auth, '/api/tags/rename', { method: 'POST', body: JSON.stringify({ name: 'JK', to: 'cat' }) })).status, 409, '新名字与已有标签重名');
        assert.strictEqual((await domainReq(b, auth, '/api/tags/rename', { method: 'POST', body: JSON.stringify({ name: 'JK', to: '  ' }) })).status, 400, '新名字空');

        const r = await domainReq(b, auth, '/api/tags/rename', { method: 'POST', body: JSON.stringify({ name: 'jk', to: ' jk2 ' }) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.from, 'JK');
        assert.strictEqual(r.body.name, 'JK2', '自动大写 + 去空白');
        assert.strictEqual(r.body.synced, 2, '同步修改了 2 条消息');
        assert.ok(deps.getCollection('tags').docs.some(t => t.name === 'JK2'));
        assert.ok(!deps.getCollection('tags').docs.some(t => t.name === 'JK'));
        assert.deepStrictEqual(deps.getCollection('message').docs.find(m => m.file_unique_id === 'F1').tags, ['JK2']);
        assert.deepStrictEqual(deps.getCollection('message').docs.find(m => m.file_unique_id === 'F2').tags, ['JK2', 'CAT']);
        assert.deepStrictEqual(deps.getCollection('message').docs.find(m => m.file_unique_id === 'F3').tags, [], '没打该标签的消息不受影响');

        // 改名到相同的名字：200 且不报错（幂等）
        const same = await domainReq(b, auth, '/api/tags/rename', { method: 'POST', body: JSON.stringify({ name: 'JK2', to: 'jk2' }) });
        assert.strictEqual(same.status, 200);
        assert.strictEqual(same.body.synced, 2);
    });
});

test('历史日志编号都能显示可读名称（type=23 不再出现 legacy_type_23）', async () => {
    const deps = makeMemoryDeps({
        log: [
            { _id: 'l23', type: 23, time: NOW - 3000, userId: 1 },
            { _id: 'lneg', type: -1, time: NOW - 2000, userId: 2 },
            { _id: 'l1', type: 1, time: NOW - 1000, userId: 3 }
        ]
    });
    await withDomain(deps, async (b, auth) => {
        const list = await domainReq(b, auth, '/api/oplogs');
        const byType = (t) => list.body.items.find(i => i.type === t);
        assert.strictEqual(byType(23).action, 'media_edit_text');
        assert.strictEqual(byType(23).actionLabel, '修改文本');
        assert.strictEqual(byType(-1).actionLabel, '未知操作');
        assert.strictEqual(byType(1).actionLabel, '媒体收录');
        assert.ok(!list.body.items.some(i => String(i.actionLabel || '').startsWith('legacy_type_')), '不应再出现 legacy_type_* 占位名');

        const stats = await domainReq(b, auth, '/api/stats?period=month');
        const labels = stats.body.byAction.map(a => a.label);
        assert.ok(labels.includes('修改文本'), '报表动作明细里显示可读名称');
        assert.ok(!labels.some(l => String(l).startsWith('legacy_type_')), '报表里不再出现占位名');
    });
});

// ---------------- 数据库存储统计 ----------------

test('GET /api/db-stats：无法读取时优雅降级（不抛 500）', async () => {
    const deps = makeMemoryDeps({});
    await withDomain(deps, async (b, auth) => {
        const r = await domainReq(b, auth, '/api/db-stats');
        assert.strictEqual(r.status, 200, '统计失败也要返回 200，让前端能提示降级');
        assert.strictEqual(r.body.ok, false);
        assert.strictEqual(r.body.available, false);
        assert.ok(typeof r.body.reason === 'string' && r.body.reason.length > 0);
        assert.deepStrictEqual(r.body.collections, []);
    });
});

