// tests/levelExtractor.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { extractLevel, removeLevelSuffix } = require('../utils/levelExtractor');

test('提取末尾等级标记', () => {
    assert.strictEqual(extractLevel('这是一条消息 #S'), 'S');
    assert.strictEqual(extractLevel('图片说明 #a'), 'A');
    assert.strictEqual(extractLevel('测试 #B'), 'B');
    assert.strictEqual(extractLevel('测试#C'), 'C');
});

test('无标记时返回默认 D', () => {
    assert.strictEqual(extractLevel('普通文本'), 'D');
    assert.strictEqual(extractLevel(''), 'D');
    assert.strictEqual(extractLevel(null), 'D');
    assert.strictEqual(extractLevel(undefined), 'D');
});

test('无效等级字母返回默认 D', () => {
    assert.strictEqual(extractLevel('文本 #X'), 'D');
    assert.strictEqual(extractLevel('文本 #Z'), 'D');
    assert.strictEqual(extractLevel('文本 #'), 'D');
});

test('移除等级后缀', () => {
    assert.strictEqual(removeLevelSuffix('这是一条消息 #S'), '这是一条消息');
    assert.strictEqual(removeLevelSuffix('图片说明 #a'), '图片说明');
    assert.strictEqual(removeLevelSuffix('没有标记'), '没有标记');
    assert.strictEqual(removeLevelSuffix(''), '');
    assert.strictEqual(removeLevelSuffix(null), '');
});
