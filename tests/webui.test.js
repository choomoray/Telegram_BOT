// tests/webui.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createWebUI } = require('../webui/server');

const TEST_PASSWORD = 'test-password';

// ---------------- 假数据库依赖 ----------------

function makeFakeCol() {
    const calls = { insert: [], update: [], delete: [], find: [] };
    const col = {
        calls,
        countDocuments: async () => 42,
        find: (filter) => {
            calls.find.push(filter);
            const chain = () => ({
                sort: chain,
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
