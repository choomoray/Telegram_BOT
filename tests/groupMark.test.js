// tests/groupMark.test.js
/**
 * group_list 标记字段语义（回归）：
 *   - 建组不写 last_mark_time（没标记过的组不该有这个字段）；
 *   - /mark 标记时 mark +1 并写入 last_mark_time；
 *   - 历史数据里 last_mark_time 为 null 的，启动时一次性清理掉（幂等）；
 *   - 字段缺失时，标记记录列表的排序/格式化仍要正常。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const root = path.join(__dirname, '..');
const { store, installMemoryDb, installLoggerStub, resetStore } = require('./helpers/memoryDb');

installMemoryDb(root);
installLoggerStub(root);

const { upsertGroupList, incrementMark, cleanupNullMarkTime, findGroupList } = require('../db/groupList');
const { sortMarkRecords } = require('../utils/markFormatter');

test('建组：不写 last_mark_time，mark 从 0 开始', async () => {
    resetStore();
    await upsertGroupList('G1');

    const doc = await findGroupList('G1');
    assert.ok(doc, '建组后应能查到记录');
    assert.strictEqual(doc.mark, 0);
    assert.ok(!('last_mark_time' in doc), '没标记过的组不该有 last_mark_time 字段');
});

test('标记：mark +1 并写入 last_mark_time；再标记刷新时间', async () => {
    resetStore();
    await upsertGroupList('G1');
    assert.ok(!('last_mark_time' in (await findGroupList('G1'))));

    const first = await incrementMark('G1');
    assert.strictEqual(first, 1);
    const afterFirst = await findGroupList('G1');
    assert.strictEqual(typeof afterFirst.last_mark_time, 'number', '标记后应写入时间戳');
    assert.ok(afterFirst.last_mark_time > 0);

    await new Promise(r => setTimeout(r, 5));
    const second = await incrementMark('G1');
    assert.strictEqual(second, 2);
    const afterSecond = await findGroupList('G1');
    assert.strictEqual(afterSecond.mark, 2);
    assert.ok(afterSecond.last_mark_time >= afterFirst.last_mark_time, '时间戳被刷新');
});

test('标记不存在的组：返回 null，不误建记录', async () => {
    resetStore();
    const res = await incrementMark('NOT_EXIST');
    assert.strictEqual(res, null);
    assert.strictEqual(store.get('group_list').length, 0, '不应凭空建组');
});

test('清理：只删 null，保留真实时间，可重复执行', async () => {
    resetStore();
    store.set('group_list', [
        { _id: 'a', group_id: 'A', is_group: 1, mark: 0, last_mark_time: null },
        { _id: 'b', group_id: 'B', is_group: 1, mark: 2, last_mark_time: 1700000000000 },
        { _id: 'c', group_id: 'C', is_group: 1, mark: 0 }
    ]);

    const cleaned = await cleanupNullMarkTime();
    assert.strictEqual(cleaned, 1);
    const docs = store.get('group_list');
    assert.ok(!('last_mark_time' in docs.find(d => d.group_id === 'A')), 'null 字段被删除');
    assert.strictEqual(docs.find(d => d.group_id === 'B').last_mark_time, 1700000000000, '真实时间保留');
    assert.ok(!('last_mark_time' in docs.find(d => d.group_id === 'C')), '本来就没有的字段不受影响');
    assert.strictEqual(await cleanupNullMarkTime(), 0, '幂等：再跑一次没有可清理的');
});

test('标记记录：字段缺失时排序与展示不炸', async () => {
    const records = [
        { group_id: 'x', mark: 2 },                       // 未标记过（没有 last_mark_time）
        { group_id: 'y', mark: 1, last_mark_time: 5000 }
    ];
    assert.deepStrictEqual(sortMarkRecords(records, 'time').map(r => r.group_id), ['y', 'x']);
    assert.deepStrictEqual(sortMarkRecords(records, 'count').map(r => r.group_id), ['x', 'y']);
});
