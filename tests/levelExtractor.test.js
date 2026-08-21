// tests/levelExtractor.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { removeLevelSuffix } = require('../utils/levelExtractor');

test('移除等级后缀', () => {
    assert.strictEqual(removeLevelSuffix('这是一条消息 #S'), '这是一条消息');
    assert.strictEqual(removeLevelSuffix('图片说明 #a'), '图片说明');
    assert.strictEqual(removeLevelSuffix('没有标记'), '没有标记');
    assert.strictEqual(removeLevelSuffix(''), '');
    assert.strictEqual(removeLevelSuffix(null), '');
});
