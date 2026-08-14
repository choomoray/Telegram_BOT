// tests/chatIdConverter.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { convertToLinkChatId, generateMessageLink } = require('../utils/chatIdConverter');

test('超级群组/频道 -100 前缀去除', () => {
    assert.strictEqual(convertToLinkChatId(-1001234567890), '1234567890');
    assert.strictEqual(convertToLinkChatId('-1001234567890'), '1234567890');
});

test('普通负 ID 去掉负号', () => {
    assert.strictEqual(convertToLinkChatId(-123456789), '123456789');
    assert.strictEqual(convertToLinkChatId('-123456789'), '123456789');
});

test('正数直接返回', () => {
    assert.strictEqual(convertToLinkChatId(123456789), '123456789');
    assert.strictEqual(convertToLinkChatId('123456789'), '123456789');
});

test('生成消息跳转链接', () => {
    assert.strictEqual(generateMessageLink(-1001234567890, 42), 'https://t.me/c/1234567890/42');
    assert.strictEqual(generateMessageLink(123456789, 7), 'https://t.me/c/123456789/7');
});
