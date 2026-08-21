// tests/queryParser.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseQuery } = require('../utils/queryParser');

const EMPTY = { types: [], specifiedLevels: [], levelGTE: [], levelLTE: [], tags: [], keyword: '' };

test('空/非法输入返回空结构', () => {
    assert.deepStrictEqual(parseQuery(''), EMPTY);
    assert.deepStrictEqual(parseQuery(null), EMPTY);
    assert.deepStrictEqual(parseQuery(undefined), EMPTY);
    assert.deepStrictEqual(parseQuery(123), EMPTY);
});

test('纯关键字保留', () => {
    const r = parseQuery('hello world');
    assert.deepStrictEqual(r.keyword, 'hello world');
    assert.deepStrictEqual(r.types, []);
});

test('解析媒体类型标记 -V -P -A -D', () => {
    const r = parseQuery('-V 测试');
    assert.deepStrictEqual(r.types, ['video']);
    assert.strictEqual(r.keyword, '测试');

    const r2 = parseQuery('测试 -P -A -D -V');
    assert.deepStrictEqual(r2.types, ['photo', 'audio', 'document', 'video']);
    assert.strictEqual(r2.keyword, '测试');
});

test('标记不区分大小写', () => {
    const r = parseQuery('-v 测试');
    assert.deepStrictEqual(r.types, ['video']);
});

test('解析指定等级 +S', () => {
    const r = parseQuery('+S 测试');
    assert.deepStrictEqual(r.specifiedLevels, ['S']);
    assert.strictEqual(r.keyword, '测试');
});

test('解析大于等于等级 S+ / 小于等于等级 D-', () => {
    const r1 = parseQuery('S+ 测试');
    assert.deepStrictEqual(r1.levelGTE, ['S']);
    assert.strictEqual(r1.keyword, '测试');

    const r2 = parseQuery('D- 测试');
    assert.deepStrictEqual(r2.levelLTE, ['D']);
    assert.strictEqual(r2.keyword, '测试');
});

test('混合标记解析', () => {
    const r = parseQuery('-V +S 猫 狗');
    assert.deepStrictEqual(r.types, ['video']);
    assert.deepStrictEqual(r.specifiedLevels, ['S']);
    assert.strictEqual(r.keyword, '猫 狗');
});

test('重复标记去重', () => {
    const r = parseQuery('-V -V 测试');
    assert.deepStrictEqual(r.types, ['video']);
    assert.strictEqual(r.keyword, '测试');
});

test('非法的粘连片段保留为关键字', () => {
    const r = parseQuery('abc-V');
    assert.strictEqual(r.keyword, 'abc-V');
    assert.deepStrictEqual(r.types, []);
});

test('仅标记无关键字', () => {
    const r = parseQuery('-P');
    assert.deepStrictEqual(r.types, ['photo']);
    assert.strictEqual(r.keyword, '');
});

test('解析标签筛选 -tag', () => {
    const r = parseQuery('-tag 图片 教程 关键词');
    assert.deepStrictEqual(r.tags, ['图片', '教程', '关键词']);
    assert.strictEqual(r.keyword, '');
});

test('标签用顿号/逗号分隔', () => {
    const r = parseQuery('查找 -tag 图片、教程，高清');
    assert.deepStrictEqual(r.tags, ['图片', '教程', '高清']);
    assert.strictEqual(r.keyword, '查找');
});

test('-tag 指令不区分大小写', () => {
    const r = parseQuery('-TAG HD');
    assert.deepStrictEqual(r.tags, ['hd']);
});

test('-tag 与类型/等级标记不冲突', () => {
    const r = parseQuery('-v -tag 教程 +S');
    assert.deepStrictEqual(r.types, ['video']);
    assert.deepStrictEqual(r.specifiedLevels, ['S']);
    assert.deepStrictEqual(r.tags, ['教程']);
    assert.strictEqual(r.keyword, '');
});

test('-tag 在标签后遇到其他标记停止收集', () => {
    const r = parseQuery('-tag 教程 -v 视频');
    assert.deepStrictEqual(r.tags, ['教程']);
    assert.deepStrictEqual(r.types, ['video']);
    assert.strictEqual(r.keyword, '视频');
});
