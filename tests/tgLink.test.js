// tests/tgLink.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { transportLinkUrl } = require('../utils/tgLink');

test('已有 http(s) 链接原样返回', () => {
    assert.strictEqual(transportLinkUrl({ chat_id: -1001521978999, url: 'https://t.me/xuexiziliao2/3610' }), 'https://t.me/xuexiziliao2/3610');
    assert.strictEqual(transportLinkUrl({ chat_id: -1, url: 'http://t.me/abc' }), 'http://t.me/abc');
});

test('无链接时由超级群/频道 chat_id 推导 t.me/c 链接', () => {
    assert.strictEqual(transportLinkUrl({ chat_id: -1001521978999 }), 'https://t.me/c/1521978999');
    assert.strictEqual(transportLinkUrl({ chat_id: '-1001521978999' }), 'https://t.me/c/1521978999');
});

test('普通群或短负 ID 不推导链接（避免 -1002 误判为频道 2）', () => {
    assert.strictEqual(transportLinkUrl({ chat_id: -1002 }), '');
    assert.strictEqual(transportLinkUrl({ chat_id: -123456 }), '');
    assert.strictEqual(transportLinkUrl({ chat_id: -100 }), '');
});

test('缺少 chat_id/url 返回空串而不是抛错', () => {
    assert.strictEqual(transportLinkUrl({}), '');
    assert.strictEqual(transportLinkUrl(null), '');
});
