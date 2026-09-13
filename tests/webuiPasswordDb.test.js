// tests/webuiPasswordDb.test.js
/**
 * Web UI 登录密码来源：数据库 settings 集合的 `webui_password` 字段
 * （.env / config 里已不再有 WEBUI_PASSWORD）
 *
 * 覆盖三条链路：
 *   1. settings 里配了密码 → 用该密码能登录，错误密码 401
 *   2. settings 里没配密码 → 返回 503 并提示怎么配（fail closed，不再是随机密码）
 *   3. 通过 setSettingPassword 改密码后，旧密码立即失效（不需重启、不等缓存过期）
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { installMemoryDb, installLoggerStub, resetStore, stubModule } = require('./helpers/memoryDb');

installMemoryDb(ROOT);
installLoggerStub(ROOT);
stubModule(path.join(ROOT, 'database.js'), { getClient: () => null, getDb: () => null, connectDB: async () => { } });
// 登录流程不碰 Telegram，但 server.js 顶部会 require bot；桩掉避免真实网络依赖
stubModule(path.join(ROOT, 'bot.js'), {
    sendMessage: async () => ({}), editMessageText: async () => ({}),
    answerCallbackQuery: async () => ({}), on: () => { }, startBotPolling: () => { }
});

const { createWebUI } = require('../webui/server');
const settings = require('../db/settings');
const { getCollection, COLLECTIONS } = require('../db/getCollection');

const DB_PASSWORD = 'db-side-password';

let server;
let base;

before(async () => {
    // 注意：不注入 password，逼 server 走"从数据库读密码"的真实路径
    server = createWebUI();
    await new Promise(resolve => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise(resolve => server.close(resolve));
});

beforeEach(async () => {
    resetStore();
    settings.clearSettingsCache();
    await getCollection(COLLECTIONS.SETTINGS).updateOne(
        { _id: 'app_settings' }, { $set: { webui_password: DB_PASSWORD } }, { upsert: true }
    );
    settings.clearSettingsCache();
});

async function login(password) {
    const res = await fetch(base + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

test('settings 里配置的密码可以登录（来源不再是 .env）', async () => {
    const r = await login(DB_PASSWORD);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.token, '应返回会话 token');
});

test('错误密码仍然返回 401', async () => {
    const r = await login('not-the-password');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.error, '密码错误');
});

test('settings 未配置密码时登录返回 503 并提示配置方式（fail closed）', async () => {
    await getCollection(COLLECTIONS.SETTINGS).updateOne(
        { _id: 'app_settings' }, { $unset: { webui_password: '' } }
    );
    settings.clearSettingsCache();

    // 空密码也不能绕过
    assert.strictEqual((await login('')).status, 503);
    const r = await login(DB_PASSWORD);
    assert.strictEqual(r.status, 503);
    assert.match(r.body.error, /webui_password/, '错误文案要告诉用户字段名');
});

test('改密码后旧密码立即失效、新密码立即可用（无需重启）', async () => {
    assert.strictEqual((await login(DB_PASSWORD)).status, 200);

    assert.strictEqual(await settings.setSettingPassword('rotated-password'), true);

    assert.strictEqual((await login(DB_PASSWORD)).status, 401, '旧密码应失效');
    assert.strictEqual((await login('rotated-password')).status, 200, '新密码应立即可用');
});
