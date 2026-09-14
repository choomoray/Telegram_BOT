// tests/queryParser.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseQuery } = require('../utils/queryParser');

const EMPTY = { tags: [], tagsAll: [], types: [], keyword: '', valid: true };

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
    assert.deepStrictEqual(r.types, []);
    assert.strictEqual(r.valid, true);
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

test('每个标签各带一个 - 前缀也认（标签段内的 - 都算标签）', () => {
    const r = parseQuery('搜索 -图片 -高清');
    assert.deepStrictEqual(r.tags, ['图片', '高清']);
    assert.strictEqual(r.keyword, '搜索');
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

test('-- 严格标签：必须包含所有标签', () => {
    const r = parseQuery('教程 --图片 高清');
    assert.deepStrictEqual(r.tagsAll, ['图片', '高清']);
    assert.deepStrictEqual(r.tags, []);
    assert.strictEqual(r.keyword, '教程');
});

test('-- 严格标签仅标签无关键字', () => {
    const r = parseQuery('--图片、高清');
    assert.deepStrictEqual(r.tagsAll, ['图片', '高清']);
    assert.strictEqual(r.keyword, '');
});

test('严格标签不区分大小写', () => {
    const r = parseQuery('--HD 教程');
    assert.deepStrictEqual(r.tagsAll, ['hd', '教程']);
});

test('标签段里出现 -- 即整段按严格模式理解（段内不再混用）', () => {
    const r = parseQuery('搜索 -图片 --高清 教程');
    assert.deepStrictEqual(r.tags, []);
    assert.deepStrictEqual(r.tagsAll, ['图片', '高清', '教程']);
    assert.strictEqual(r.keyword, '搜索');
});

// ---------------- 类型标记（+d/+a/+p/+v/+t） ----------------

test('类型标记：+d/+a/+p/+v/+t 映射到 media_type', () => {
    assert.deepStrictEqual(parseQuery('报告 +d').types, ['document']);
    assert.deepStrictEqual(parseQuery('歌 +a').types, ['audio']);
    assert.deepStrictEqual(parseQuery('风景 +p').types, ['photo']);
    assert.deepStrictEqual(parseQuery('课程 +v').types, ['video']);
    assert.deepStrictEqual(parseQuery('笔记 +t').types, ['text']);
    // 大小写不敏感
    assert.deepStrictEqual(parseQuery('报告 +D').types, ['document']);
});

test('类型标记：可以写多个（并集），去重保序', () => {
    const r = parseQuery('关键字 +d +a');
    assert.deepStrictEqual(r.types, ['document', 'audio']);
    assert.strictEqual(r.keyword, '关键字');
    const dup = parseQuery('关键字 +d +d');
    assert.deepStrictEqual(dup.types, ['document']);
});

test('完整结构：关键字 +类型 -标签', () => {
    const r = parseQuery('教程 +v -高清 风景');
    assert.strictEqual(r.keyword, '教程');
    assert.deepStrictEqual(r.types, ['video']);
    assert.deepStrictEqual(r.tags, ['高清', '风景']);
    assert.strictEqual(r.valid, true);
    // 严格标签同理
    const strict = parseQuery('教程 +v --高清');
    assert.deepStrictEqual(strict.tagsAll, ['高清']);
    assert.deepStrictEqual(strict.types, ['video']);
});

test('只有类型标记（无关键字、无标签）也可查询', () => {
    const r = parseQuery('+a');
    assert.strictEqual(r.keyword, '');
    assert.deepStrictEqual(r.types, ['audio']);
    assert.strictEqual(r.valid, true);
});

test('未知的 +xxx 不算类型标记，按关键字处理（避免误伤 +1 这类搜索词）', () => {
    const r = parseQuery('+1 备注');
    assert.strictEqual(r.valid, true);
    assert.deepStrictEqual(r.types, []);
    assert.strictEqual(r.keyword, '+1 备注');
});

// ---------------- 顺序校验：顺序不对 → 不予查询 ----------------

test('顺序不对：类型标记出现在关键字之前 → 无效', () => {
    const r = parseQuery('+d 关键字');
    assert.strictEqual(r.valid, false, '类型标记必须在关键字之后');
});

test('顺序不对：类型标记出现在标签之后 → 无效', () => {
    assert.strictEqual(parseQuery('-标签 +d').valid, false);
    assert.strictEqual(parseQuery('关键字 -标签 +d').valid, false);
});

test('顺序不对：关键字出现在类型标记之后 → 无效（类型标记后面只能是标签或结束）', () => {
    assert.strictEqual(parseQuery('+d 关键字 更多').valid, false);
    assert.strictEqual(parseQuery('关键字 +d 更多').valid, false, '类型标记后不能再写关键字');
    assert.strictEqual(parseQuery('+d -标签').valid, true, '类型标记后直接跟标签是合法的');
});

test('标签段是"黏"的：-图片 高清 里的 高清 也算标签（与 -图片、高清 等价）', () => {
    const r = parseQuery('-图片 高清');
    assert.deepStrictEqual(r.tags, ['图片', '高清']);
    assert.strictEqual(r.keyword, '');
    // 因此 `-标签 关键字` 会被理解成两个标签，而不是"关键字跑到标签后面"
    const two = parseQuery('-标签 关键字');
    assert.deepStrictEqual(two.tags, ['标签', '关键字']);
    assert.strictEqual(two.valid, true);
});

test('顺序正确：省略任意段都合法', () => {
    assert.strictEqual(parseQuery('关键字 +d -标签').valid, true);
    assert.strictEqual(parseQuery('关键字 +d').valid, true);
    assert.strictEqual(parseQuery('关键字 -标签').valid, true);
    assert.strictEqual(parseQuery('关键字').valid, true);
    assert.strictEqual(parseQuery('-标签').valid, true);
    assert.strictEqual(parseQuery('+d').valid, true);
});
