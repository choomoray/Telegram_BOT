// tests/modeNames.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { MODE_NAMES, getModeName } = require('../utils/modeNames');

test('已知模式返回中文名', () => {
    assert.strictEqual(getModeName('media_group'), '媒体合并模式');
    assert.strictEqual(getModeName('delete'), '数据删除模式');
});

test('未知模式原样返回', () => {
    assert.strictEqual(getModeName('unknown_mode'), 'unknown_mode');
    assert.strictEqual(getModeName(undefined), undefined);
});

test('映射表覆盖所有注册模式', () => {
    const registered = [
        'media_group', 'media_hide', 'media_unhide',
        'message_reply', 'search', 'delete', 'delete_group',
        'clean', 'mark', 'edit', 'setting', 'transport',
        'password', 'manage'
    ];
    for (const mode of registered) {
        assert.ok(MODE_NAMES[mode], `缺少模式 ${mode} 的中文名`);
    }
});
