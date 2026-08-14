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
        callAI: async () => JSON.stringify({ explain: '测试查询', filter: { mark: { $gt: 5 } } }),
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

// ---------------- 集合与查询 ----------------

test('获取集合白名单', async () => {
    const auth = await login();
    const r = await req('/api/db/collections', { headers: auth });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.collections));
    assert.ok(r.body.collections.includes('users'));
    assert.ok(r.body.collections.includes('group_list'));
});

test('查询返回分页结构与文档', async () => {
    const auth = await login();
    const r = await req('/api/db/query', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ collection: 'users', filter: { white: 1 }, page: 1, pageSize: 20 })
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.total, 42);
    assert.strictEqual(r.body.items.length, 1);
    assert.strictEqual(r.body.items[0].name, '示例文档');
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

// ---------------- 新增 / 修改 / 删除 ----------------

test('插入文档调用 insertOne 并移除 _id', async () => {
    const deps = makeStubDeps();
    const s2 = createWebUI(deps);
    await new Promise(resolve => s2.listen(0, resolve));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    try {
        const auth = await (async () => {
            const r = await fetch(b2 + '/api/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: TEST_PASSWORD })
            }).then(r => r.json());
            return { 'Content-Type': 'application/json', Authorization: `Bearer ${r.token}` };
        })();
        const r = await fetch(b2 + '/api/db/insert', {
            method: 'POST', headers: auth,
            body: JSON.stringify({ collection: 'users', data: { id: 999, name: '新用户', _id: 'should-be-removed' } })
        }).then(r => r.json());
        assert.strictEqual(r.ok, true);
        const inserted = deps.fakeCol.calls.insert[0];
        assert.strictEqual(inserted.id, 999);
        assert.ok(!('_id' in inserted), '不应允许手动指定 _id');
    } finally {
        await new Promise(resolve => s2.close(resolve));
    }
});

test('更新文档：空 filter 返回 400', async () => {
    const auth = await login();
    const r = await req('/api/db/update', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ collection: 'users', filter: {}, data: { white: 1 } })
    });
    assert.strictEqual(r.status, 400);
});

test('更新文档调用 updateOne 且使用 $set', async () => {
    const deps = makeStubDeps();
    const s2 = createWebUI(deps);
    await new Promise(resolve => s2.listen(0, resolve));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    try {
        const auth = await (async () => {
            const r = await fetch(b2 + '/api/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: TEST_PASSWORD })
            }).then(r => r.json());
            return { 'Content-Type': 'application/json', Authorization: `Bearer ${r.token}` };
        })();
        const r = await fetch(b2 + '/api/db/update', {
            method: 'POST', headers: auth,
            body: JSON.stringify({ collection: 'users', filter: { id: 123 }, data: { white: 1 } })
        }).then(r => r.json());
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.matchedCount, 1);
        const call = deps.fakeCol.calls.update[0];
        assert.deepStrictEqual(call.filter, { id: 123 });
        assert.deepStrictEqual(call.update, { $set: { white: 1 } });
    } finally {
        await new Promise(resolve => s2.close(resolve));
    }
});

test('删除文档：缺少 confirm 返回 400', async () => {
    const auth = await login();
    const r = await req('/api/db/delete', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ collection: 'users', filter: { id: 1 } })
    });
    assert.strictEqual(r.status, 400);
    assert.ok(r.body.error.includes('二次确认'));
});

test('删除文档：confirm 但空 filter 返回 400（禁止全表删除）', async () => {
    const auth = await login();
    const r = await req('/api/db/delete', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ collection: 'users', filter: {}, confirm: true })
    });
    assert.strictEqual(r.status, 400);
});

test('删除文档：confirm + filter 时调用 deleteOne', async () => {
    const deps = makeStubDeps();
    const s2 = createWebUI(deps);
    await new Promise(resolve => s2.listen(0, resolve));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    try {
        const auth = await (async () => {
            const r = await fetch(b2 + '/api/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: TEST_PASSWORD })
            }).then(r => r.json());
            return { 'Content-Type': 'application/json', Authorization: `Bearer ${r.token}` };
        })();
        const r = await fetch(b2 + '/api/db/delete', {
            method: 'POST', headers: auth,
            body: JSON.stringify({ collection: 'users', filter: { id: 123 }, confirm: true })
        }).then(r => r.json());
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.deletedCount, 1);
        assert.deepStrictEqual(deps.fakeCol.calls.delete[0], { id: 123 });
    } finally {
        await new Promise(resolve => s2.close(resolve));
    }
});

// ---------------- AI 查询翻译 ----------------

test('AI 查询：返回翻译后的 filter 且不执行查询', async () => {
    const deps = makeStubDeps();
    const s2 = createWebUI(deps);
    await new Promise(resolve => s2.listen(0, resolve));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    try {
        const auth = await (async () => {
            const r = await fetch(b2 + '/api/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: TEST_PASSWORD })
            }).then(r => r.json());
            return { 'Content-Type': 'application/json', Authorization: `Bearer ${r.token}` };
        })();
        const r = await fetch(b2 + '/api/ai/query', {
            method: 'POST', headers: auth,
            body: JSON.stringify({ collection: 'group_list', prompt: '标记次数超过5的组' })
        }).then(r => r.json());
        assert.deepStrictEqual(r.filter, { mark: { $gt: 5 } });
        assert.strictEqual(r.explain, '测试查询');
        // AI 只翻译，不应触发任何数据库读写
        assert.strictEqual(deps.fakeCol.calls.find.length, 0);
        assert.strictEqual(deps.fakeCol.calls.insert.length, 0);
        assert.strictEqual(deps.fakeCol.calls.update.length, 0);
        assert.strictEqual(deps.fakeCol.calls.delete.length, 0);
    } finally {
        await new Promise(resolve => s2.close(resolve));
    }
});

test('AI 查询：缺少 prompt 返回 400', async () => {
    const auth = await login();
    const r = await req('/api/ai/query', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ collection: 'users', prompt: '' })
    });
    assert.strictEqual(r.status, 400);
});

test('AI 查询：非法集合返回 400', async () => {
    const auth = await login();
    const r = await req('/api/ai/query', {
        method: 'POST', headers: auth,
        body: JSON.stringify({ collection: 'evil', prompt: '查询' })
    });
    assert.strictEqual(r.status, 400);
});

test('AI 查询：AI 返回无效格式时返回 502', async () => {
    const deps = makeStubDeps();
    deps.callAI = async () => '这不是 JSON';
    const s2 = createWebUI(deps);
    await new Promise(resolve => s2.listen(0, resolve));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    try {
        const auth = await (async () => {
            const r = await fetch(b2 + '/api/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: TEST_PASSWORD })
            }).then(r => r.json());
            return { 'Content-Type': 'application/json', Authorization: `Bearer ${r.token}` };
        })();
        const r = await fetch(b2 + '/api/ai/query', {
            method: 'POST', headers: auth,
            body: JSON.stringify({ collection: 'users', prompt: '查询' })
        });
        assert.strictEqual(r.status, 502);
    } finally {
        await new Promise(resolve => s2.close(resolve));
    }
});

// ---------------- 静态页面 / 404 ----------------

test('首页返回 HTML（登录页默认可见）', async () => {
    const res = await fetch(base + '/');
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('数据库控制台'));
    assert.ok(text.includes('AI 查询'));
});

test('未知 API 返回 404', async () => {
    const auth = await login();
    assert.strictEqual((await req('/api/unknown', { headers: auth })).status, 404);
});
