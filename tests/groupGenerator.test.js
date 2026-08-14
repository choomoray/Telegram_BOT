// tests/groupGenerator.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const {
    generateSingleGroupId,
    generateMediaGroupId,
    generateGroupIdFromMessage
} = require('../utils/groupGenerator');

test('单一媒体 group_id 格式', () => {
    assert.strictEqual(generateSingleGroupId(-100123, 5), '-100123_5');
    assert.strictEqual(generateSingleGroupId(123, 5), '123_5');
});

test('媒体组 group_id 格式', () => {
    assert.strictEqual(generateMediaGroupId(-100123, 'mgid-1'), '-100123_mgid-1');
});

test('从消息对象生成单一媒体 group_id', () => {
    const msg = { chat: { id: -100123 }, message_id: 5, photo: [{}] };
    assert.strictEqual(generateGroupIdFromMessage(msg), '-100123_5');
});

test('媒体组消息优先使用 media_group_id', () => {
    const msg = { chat: { id: -100123 }, message_id: 5, media_group_id: 'mgid', video: {} };
    assert.strictEqual(generateGroupIdFromMessage(msg), '-100123_mgid');
});

test('非媒体消息返回 null', () => {
    const msg = { chat: { id: -100123 }, message_id: 5, text: 'hi' };
    assert.strictEqual(generateGroupIdFromMessage(msg), null);
});
