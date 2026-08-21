// tests/queryParser.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseQuery } = require('../utils/queryParser');

const EMPTY = { tags: [], keyword: '' };

test('空/非法输入返回空结构', () => {
    assert.deepStrictEqual(parseQuery(''), EMPTY);
    assert.deepStrictEqual(parseQuery(null), EMPTY);
    assert.deepStrictEqual(parseQuery(undefined), EMPTY);
    assert.deepStrictEqual(parseQuery(123), EMPTY);
});

test('纯关键字保留', () => {
    const r = parseQuery('hello world');
    assert.deepStrictEqual(r.keyword, 'hello world');
    assert.deepStrictEqual(r.tags, []);
});

test('句尾最后一个 - 为标签标记', () => {
    const r = parseQuery('教程 -图片 高清');
    assert.deepStrictEqual(r.tags, ['图片', '高清']);
    assert.strictEqual(r.keyword, '教程');
});

test('仅标签无关键字', () => {
    const r = parseQuery('-图片 高清');
    assert.deepStrictEqual(r.tags, ['图片', '高清']);
    assert.strictEqual(r.keyword, '');
});

test('标签用顿号/逗号分隔', () => {
    const r = parseQuery('查找 -图片、教程，高清');
    assert.deepStrictEqual(r.tags, ['图片', '教程', '高清']);
    assert.strictEqual(r.keyword, '查找');
});

test('标签不区分大小写（统一转小写）', () => {
    const r = parseQuery('-HD 教程');
    assert.deepStrictEqual(r.tags, ['hd', '教程']);
});

test('无 - 标记时为纯关键字', () => {
    const r = parseQuery('普通查询内容');
    assert.deepStrictEqual(r.tags, []);
    assert.strictEqual(r.keyword, '普通查询内容');
});

test('单独 - 也可作为标签标记', () => {
    const r = parseQuery('搜索 - 图片 教程');
    assert.deepStrictEqual(r.tags, ['图片', '教程']);
    assert.strictEqual(r.keyword, '搜索');
});
