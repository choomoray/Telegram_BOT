// tests/tags.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { sortTags } = require('../db/tags');
const { splitTagInput, matchTagsInText } = require('../utils/tagUi');

// ---------------- sortTags（标签展示排序） ----------------

test('置顶标签（pin>0）按位置升序排最前，其余按使用次数降序', () => {
    const tags = [
        { name: '普通A', count: 10 },
        { name: '置顶B', pin: 2, count: 1 },
        { name: '普通B', count: 5 },
        { name: '置顶A', pin: 1, count: 3 }
    ];
    const sorted = sortTags(tags);
    assert.deepStrictEqual(sorted.map(t => t.name), ['置顶A', '置顶B', '普通A', '普通B']);
});

test('置顶标签按 pin 位置排序（1=左上第一个按钮），pin 为 0 视为不置顶', () => {
    const tags = [
        { name: '置顶2', pin: 2, count: 0 },
        { name: '普通', count: 50 },
        { name: '置顶1', pin: 1, count: 99 },
        { name: '未置顶', pin: 0, count: 30 }
    ];
    const sorted = sortTags(tags);
    assert.deepStrictEqual(sorted.map(t => t.name), ['置顶1', '置顶2', '普通', '未置顶']);
});

test('次数相同按名称排序', () => {
    const tags = [
        { name: 'b', count: 1 },
        { name: 'a', count: 1 },
        { name: 'c', count: 2 }
    ];
    const sorted = sortTags(tags);
    assert.deepStrictEqual(sorted.map(t => t.name), ['c', 'a', 'b']);
});

test('sortTags 不修改原数组', () => {
    const tags = [{ name: 'a', count: 1 }, { name: 'b', count: 2 }];
    const copy = JSON.parse(JSON.stringify(tags));
    sortTags(tags);
    assert.deepStrictEqual(tags, copy);
});

// ---------------- splitTagInput（手动输入解析） ----------------

test('按空格/、/逗号分隔并去重', () => {
    assert.deepStrictEqual(splitTagInput('图片 教程、高清，风景'), ['图片', '教程', '高清', '风景']);
});

test('大小写去重（保留首现）', () => {
    assert.deepStrictEqual(splitTagInput('HD hd 图片'), ['HD', '图片']);
});

test('空输入返回空数组', () => {
    assert.deepStrictEqual(splitTagInput(''), []);
    assert.deepStrictEqual(splitTagInput(null), []);
    assert.deepStrictEqual(splitTagInput('   '), []);
});

// ---------------- matchTagsInText（文本识别标签） ----------------

test('文本中识别已存在的标签', () => {
    const tags = [{ name: '图片' }, { name: '教程' }, { name: 'HD' }];
    assert.deepStrictEqual(matchTagsInText('这是一个图片教程', tags), ['图片', '教程']);
});

test('大小写不敏感识别', () => {
    const tags = [{ name: 'hd' }];
    assert.deepStrictEqual(matchTagsInText('这是HD画质', tags), ['hd']);
});

test('文本不含标签返回空', () => {
    const tags = [{ name: '图片' }];
    assert.deepStrictEqual(matchTagsInText('普通文本', tags), []);
    assert.deepStrictEqual(matchTagsInText('', tags), []);
    assert.deepStrictEqual(matchTagsInText(null, tags), []);
});
