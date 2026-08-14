// tests/webui.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createWebUI } = require('../webui/server');

const TEST_PASSWORD = 'test-password';

// ---------------- 假数据库依赖 ----------------

function makeStubDeps() {
    const calls = { ban: [], unban: [], setting: [], delMedia: [], delMsg: [], delGroup: [], delGroupList: [] };
    const baseCounts = { channel_group: 3, users: 10, media: 42, message: 100, log: 500, transport: 2 };

    const col = (name) => ({
        countDocuments: async (filter) => {
            if (name === 'users' && filter && filter.state === 0) return 2;
            if (name === 'users' && filter && filter.white === 1) return 5;
            if (name === 'group_list' && filter && filter.mark) return 5;
            if (name === 'log' && filter && filter.type === 1 && filter.time) return 3;
            if (filter && Object.keys(filter).length > 0) return 0;
            return baseCounts[name] || 0;
        },
        find: () => {
            const chain = () => ({
                sort: chain,
                skip: chain,
                limit: chain,
                toArray: async () => []
            });
            return chain();
        },
        aggregate: () => ({ toArray: async () => [{ _id: 'video', count: 30 }, { _id: 'photo', count: 12 }] }),
        updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
        deleteOne: async () => ({ deletedCount: 1 })
    });

    return {
        calls,
        getCollection: (name) => col(name),
        banUser: async (userId) => { calls.ban.push(userId); return { success: true, banned: 1, failed: 0 }; },
        unbanUser: async (userId) => { calls.unban.push(userId); return { success: true, unbanned: 1, failed: 0 }; },
        getSettings: async () => ({ _id: 'app_settings', search_level: 0, search_random: 1 }),
        updateSetting: async (config, key, value) => {
            if (key === 'bad_key') throw new Error('不允许修改的设置: bad_key');
            calls.setting.push({ key, value });
            return true;
        },
        findMediaByFileUniqueId: async (fuid) => ({ file_unique_id: fuid, group_id: 'g1', media_type: 'video' }),
        deleteMediaByFileUniqueId: async (fuid) => { calls.delMedia.push(fuid); return { deletedCount: 1 }; },
        findMessageByFileUniqueId: async () => ({ file_unique_id: 'x', group_id: 'g1', text: 't' }),
        deleteMessageByFileUniqueId: async (fuid) => { calls.delMsg.push(fuid); return { deletedCount: 1 }; },
        findGroupList: async () => ({ group_id: 'g1', is_group: 1 }),
        deleteGroupList: async (gid) => { calls.delGroupList.push(gid); return { deletedCount: 1 }; },
        setGroupDelete: async () => {},
        getMarkRecords: async () => [
            { group_id: 'g1', mark: 3, last_mark_time: 1000, text: '记录一', chat_id: -1001, message_id: 1, media_type: 'photo' }
        ],
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

// ---------------- 登录与鉴权 ----------------

test('错误密码登录返回 401', async () => {
    const r = await req('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' })
    });
    assert.strictEqual(r.status, 401);
});

test('正确密码登录返回 token', async () => {
    const r = await req('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.token);
});

test('未登录访问 API 返回 401', async () => {
    const r = await req('/api/dashboard');
    assert.strictEqual(r.status, 401);
});

test('带 token 访问 dashboard 返回统计', async () => {
    const login = await req('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    const r = await req('/api/dashboard', {
        headers: { Authorization: `Bearer ${login.body.token}` }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.groups, 3);
    assert.strictEqual(r.body.users, 10);
    assert.strictEqual(r.body.media, 42);
    assert.strictEqual(r.body.messages, 100);
    assert.strictEqual(r.body.markedGroups, 5);
    assert.strictEqual(r.body.bannedUsers, 2);
    assert.strictEqual(r.body.whiteUsers, 5);
    assert.strictEqual(r.body.logs, 500);
    assert.strictEqual(r.body.transports, 2);
    assert.strictEqual(r.body.todayMedia, 3);
    assert.ok(Array.isArray(r.body.typeDist));
});

// ---------------- 媒体 ----------------

test('媒体列表接口返回结构', async () => {
    const login = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    const r = await req('/api/media?page=1&pageSize=20', {
        headers: { Authorization: `Bearer ${login.body.token}` }
    });
    assert.strictEqual(r.status, 200);
    assert.ok('total' in r.body && 'items' in r.body && 'page' in r.body);
});

test('删除媒体调用底层删除并处理组', async () => {
    const login = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    const deps = makeStubDeps();
    const s2 = createWebUI(deps);
    await new Promise(resolve => s2.listen(0, resolve));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    try {
        const r = await fetch(b2 + '/api/media/abc123', {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${login.body.token}` }
        });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(deps.calls.delMedia, ['abc123']);
        assert.deepStrictEqual(deps.calls.delGroupList, ['g1']); // is_group===1 删除整组
    } finally {
        await new Promise(resolve => s2.close(resolve));
    }
});

test('删除不存在的媒体返回 404', async () => {
    const login = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    const deps = makeStubDeps();
    deps.findMediaByFileUniqueId = async () => null;
    const s2 = createWebUI(deps);
    await new Promise(resolve => s2.listen(0, resolve));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    try {
        const r = await fetch(b2 + '/api/media/notexist', {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${login.body.token}` }
        });
        assert.strictEqual(r.status, 404);
    } finally {
        await new Promise(resolve => s2.close(resolve));
    }
});

// ---------------- 用户 ----------------

test('封禁/解封用户调用对应依赖', async () => {
    const login = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    const deps = makeStubDeps();
    const s2 = createWebUI(deps);
    await new Promise(resolve => s2.listen(0, resolve));
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    try {
        const ban = await fetch(b2 + '/api/users/ban', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.token}` },
            body: JSON.stringify({ userId: 123 })
        });
        assert.strictEqual(ban.status, 200);
        assert.deepStrictEqual(deps.calls.ban, [123]);

        const unban = await fetch(b2 + '/api/users/unban', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.token}` },
            body: JSON.stringify({ userId: 123 })
        });
        assert.strictEqual(unban.status, 200);
        assert.deepStrictEqual(deps.calls.unban, [123]);
    } finally {
        await new Promise(resolve => s2.close(resolve));
    }
});

test('缺少 userId 时封禁返回 400', async () => {
    const login = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    const r = await req('/api/users/ban', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.token}` },
        body: JSON.stringify({})
    });
    assert.strictEqual(r.status, 400);
});

// ---------------- 设置 ----------------

test('更新合法设置返回 200，非法 key 返回 400', async () => {
    const login = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.token}` };

    const ok = await req('/api/settings', { method: 'POST', headers: auth, body: JSON.stringify({ key: 'search_level', value: 1 }) });
    assert.strictEqual(ok.status, 200);

    const bad = await req('/api/settings', { method: 'POST', headers: auth, body: JSON.stringify({ key: 'bad_key', value: 1 }) });
    assert.strictEqual(bad.status, 400);
});

// ---------------- 标记记录 / 日志 / 群组 / 搬运 ----------------

test('标记记录接口返回数据', async () => {
    const login = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    const r = await req('/api/mark-records', { headers: { Authorization: `Bearer ${login.body.token}` } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.total, 1);
    assert.strictEqual(r.body.items[0].mark, 3);
});

test('日志/群组/搬运接口可用', async () => {
    const login = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    const auth = { Authorization: `Bearer ${login.body.token}` };
    assert.strictEqual((await req('/api/logs', { headers: auth })).status, 200);
    assert.strictEqual((await req('/api/groups', { headers: auth })).status, 200);
    assert.strictEqual((await req('/api/transports', { headers: auth })).status, 200);
    assert.strictEqual((await req('/api/settings', { headers: auth })).status, 200);
});

// ---------------- 静态页面 / 404 ----------------

test('首页返回 HTML', async () => {
    const res = await fetch(base + '/');
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('管理面板'));
    assert.ok(text.includes('app.js'));
});

test('未知 API 返回 404，非法 JSON 返回 400', async () => {
    const login = await req('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD })
    });
    const auth = { Authorization: `Bearer ${login.body.token}` };

    // 未登录访问未知 API 被鉴权拦截（401），带 token 才能测到 404
    assert.strictEqual((await req('/api/unknown')).status, 401);
    assert.strictEqual((await req('/api/unknown', { headers: auth })).status, 404);

    const r = await fetch(base + '/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.token}` },
        body: 'not-json'
    });
    assert.strictEqual(r.status, 400);
});
