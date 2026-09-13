// tests/settingsPassword.test.js
/**
 * Web UI 登录密码：唯一来源是数据库 settings 集合的 `webui_password` 字段
 *   - 未配置 → getSettingPassword() 返回 null（webui 侧据此拒绝登录）
 *   - setSettingPassword() 可写入 / 清除，且立即失效缓存（改完马上生效）
 *   - webui_password 是"密钥类"字段：loadSettings() 不得把它灌进 config
 *     （否则会被日志/调试输出带出去）
 *
 * 注意：settings.js 有 5 秒模块级缓存，每个用例前必须 clearSettingsCache()，
 * 否则会读到上一个用例缓存下来的文档。
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { installMemoryDb, installLoggerStub, resetStore, stubModule } = require('./helpers/memoryDb');

installMemoryDb(ROOT);
installLoggerStub(ROOT);
// settings.js 只在 updateSetting() 里用 getClient 探活；本用例不走那条路径，
// 这里给个空桩，避免真实 database.js 被加载后要求连接。
stubModule(path.join(ROOT, 'database.js'), { getClient: () => null, getDb: () => null, connectDB: async () => { } });

const settings = require('../db/settings');

beforeEach(() => {
    resetStore();
    settings.clearSettingsCache();
});

test('未配置时 getSettingPassword 返回 null（webui 据此拒绝登录）', async () => {
    assert.strictEqual(await settings.getSettingPassword(), null);
});

test('setSettingPassword 写入后能读回，并立即生效（不等 5 秒缓存过期）', async () => {
    // 先读一次把缓存填上（此时无密码 → 缓存为空文档）
    assert.strictEqual(await settings.getSettingPassword(), null);

    assert.strictEqual(await settings.setSettingPassword('jnrb-2026'), true);
    assert.strictEqual(await settings.getSettingPassword(), 'jnrb-2026');
});

test('setSettingPassword 传空串 / null 表示清除密码', async () => {
    await settings.setSettingPassword('temp-pass');
    assert.strictEqual(await settings.getSettingPassword(), 'temp-pass');

    assert.strictEqual(await settings.setSettingPassword(''), true);
    assert.strictEqual(await settings.getSettingPassword(), null);

    await settings.setSettingPassword('temp-pass-2');
    assert.strictEqual(await settings.setSettingPassword(null), true);
    assert.strictEqual(await settings.getSettingPassword(), null);
});

test('密码前后空格被裁剪（避免手填字段时多打空格导致登录失败）', async () => {
    await settings.setSettingPassword('  spaced  ');
    assert.strictEqual(await settings.getSettingPassword(), 'spaced');
});

test('settings 文档里非字符串的 webui_password 视为未配置', async () => {
    const { getCollection, COLLECTIONS } = require('../db/getCollection');
    await getCollection(COLLECTIONS.SETTINGS).updateOne(
        { _id: 'app_settings' }, { $set: { webui_password: 123456 } }, { upsert: true }
    );
    settings.clearSettingsCache();
    assert.strictEqual(await settings.getSettingPassword(), null);
});

test('webui_password 是密钥类字段：loadSettings 不把它写进 config', async () => {
    await settings.setSettingPassword('secret-pass');

    const config = { webui_password: 'initial', WEBUI_PORT: 9700 };
    await settings.loadSettings(config);

    assert.strictEqual(config.webui_password, 'initial', 'config 里的同名字段不应被数据库值覆盖');
    assert.ok(!settings.ALLOWED_KEYS.includes('webui_password'), '不应出现在 /setting 面板可改键里');
    assert.ok(settings.SECRET_KEYS.includes('webui_password'), '应登记为密钥类字段');
});
