// tests/mediaPosition.test.js
/**
 * media 位置语义（回归）：
 *   - 位置以 group / channel 子文档为唯一权威，新数据**不再写顶层 message_id**；
 *   - 旧数据（只有顶层 message_id、没有子文档）仍要能解析出位置（group_id 前缀当 chat_id）；
 *   - 排序（列表/相册顺序）与 Web 接口取值都走解析结果，新旧两种结构表现一致；
 *   - 启动时一次性清理：顶层 message_id 与子文档重复的删掉，旧数据保留。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const root = path.join(__dirname, '..');
const { store, installMemoryDb, installLoggerStub, resetStore } = require('./helpers/memoryDb');

installMemoryDb(root);
installLoggerStub(root);

const {
    insertMedia,
    findMediaByGroupId,
    findMediaByGroupIdAndSubgroup,
    resolveMediaPosition,
    mediaPositionMessageId,
    sortMediaDocsByPosition,
    cleanupDuplicateMediaMessageId
} = require('../db/media');

// ---------------- 位置解析 ----------------

test('新结构：位置取 group_id 前缀对应的子文档（频道收录 → channel）', () => {
    const doc = {
        group_id: '-1003719524881_50737',
        subgroup: 1,
        channel: { chat_id: -1003719524881, message_id: 11187 }
    };
    assert.deepStrictEqual(resolveMediaPosition(doc), {
        chatId: -1003719524881, messageId: 11187, via: 'channel'
    });
    assert.strictEqual(mediaPositionMessageId(doc), 11187);
});

test('新结构：群组收录取 group 位置；频道转发双位置时取首次收录的那个（前缀匹配）', () => {
    const groupFirst = {
        group_id: '-1003100196312_14301541155232421',
        group: { chat_id: -1003100196312, message_id: 50737 },
        channel: { chat_id: -1003719524881, message_id: 11187 }
    };
    assert.deepStrictEqual(resolveMediaPosition(groupFirst), {
        chatId: -1003100196312, messageId: 50737, via: 'group'
    });

    const channelFirst = {
        group_id: '-1003719524881_50737',
        group: { chat_id: -1003100196312, message_id: 50737 },
        channel: { chat_id: -1003719524881, message_id: 11187 }
    };
    assert.deepStrictEqual(resolveMediaPosition(channelFirst), {
        chatId: -1003719524881, messageId: 11187, via: 'channel'
    });
});

test('旧结构：没有子文档时退回顶层 message_id（chat 用 group_id 前缀）', () => {
    const legacy = { group_id: '-1003719524881_50737', message_id: 11187 };
    assert.deepStrictEqual(resolveMediaPosition(legacy), {
        chatId: -1003719524881, messageId: 11187, via: 'legacy'
    });
    assert.strictEqual(mediaPositionMessageId(legacy), 11187);
    assert.strictEqual(resolveMediaPosition({ group_id: 'x' }), null, '完全没有位置信息 → null');
    assert.strictEqual(mediaPositionMessageId({ group_id: 'x' }), 0);
});

// ---------------- 排序（列表 / 相册顺序） ----------------

test('排序：subgroup 升序，再按位置消息 ID 升序（新旧结构混排结果一致）', () => {
    const docs = [
        { group_id: 'G_1', subgroup: 1, group: { chat_id: 10, message_id: 300 } },        // 新结构
        { group_id: 'G_1', subgroup: 1, channel: { chat_id: 10, message_id: 100 } },       // 新结构（频道）
        { group_id: 'G_1', subgroup: 1, message_id: 200 },                                 // 旧结构
        { group_id: 'G_1', subgroup: 2, group: { chat_id: 10, message_id: 1 } }
    ];
    assert.deepStrictEqual(sortMediaDocsByPosition(docs).map(mediaPositionMessageId), [100, 200, 300, 1]);
    assert.deepStrictEqual(sortMediaDocsByPosition(docs).map(d => d.subgroup), [1, 1, 1, 2]);
});

test('排序：findMediaByGroupIdAndSubgroup 也按位置排序（相册顺序）', async () => {
    resetStore();
    store.set('media', [
        { _id: 'm2', group_id: 'G_1', subgroup: 1, group: { chat_id: 10, message_id: 300 } },
        { _id: 'm1', group_id: 'G_1', subgroup: 1, group: { chat_id: 10, message_id: 100 } }
    ]);
    const list = await findMediaByGroupIdAndSubgroup('G_1', 1);
    assert.deepStrictEqual(list.map(d => d._id), ['m1', 'm2']);
    const all = await findMediaByGroupId('G_1');
    assert.deepStrictEqual(all.map(d => d._id), ['m1', 'm2']);
});

// ---------------- 写库：不再产生重复字段 ----------------

test('insertMedia：只写位置子文档，不写顶层 message_id（传入也会被忽略）', async () => {
    resetStore();
    await insertMedia({
        group_id: 'G_1',
        subgroup: 1,
        file_id: 'F',
        file_unique_id: 'U1',
        media_type: 'video',
        message_id: 11187,
        group: { chat_id: -1003719524881, message_id: 11187 }
    });
    const doc = store.get('media')[0];
    assert.deepStrictEqual(doc.group, { chat_id: -1003719524881, message_id: 11187 });
    assert.ok(!('message_id' in doc), '顶层 message_id 不应再写入');
    assert.strictEqual(mediaPositionMessageId(doc), 11187, '解析出来的位置仍然是那条消息');
});

// ---------------- 一次性清理 ----------------

test('清理：删掉与子文档重复的顶层 message_id，旧数据保留，幂等', async () => {
    resetStore();
    store.set('media', [
        // 频道收录：顶层与 channel 重复 → 删除顶层
        { _id: 'a', group_id: '-100_1', channel: { chat_id: -1003719524881, message_id: 11187 }, message_id: 11187 },
        // 群组收录：顶层与 group 重复 → 删除顶层
        { _id: 'b', group_id: 'G_2', group: { chat_id: 10, message_id: 500 }, message_id: 500 },
        // 旧数据：只有顶层，删了就没位置了 → 保留
        { _id: 'c', group_id: 'G_3', message_id: 900 },
        // 新数据：本来就没有顶层字段 → 不受影响
        { _id: 'd', group_id: 'G_4', group: { chat_id: 10, message_id: 700 } }
    ]);

    const cleaned = await cleanupDuplicateMediaMessageId();
    assert.strictEqual(cleaned, 2);
    const byId = Object.fromEntries(store.get('media').map(d => [d._id, d]));
    assert.ok(!('message_id' in byId.a));
    assert.ok(!('message_id' in byId.b));
    assert.strictEqual(byId.c.message_id, 900, '旧数据必须保留（它是唯一位置来源）');
    assert.strictEqual(mediaPositionMessageId(byId.c), 900);
    assert.strictEqual(await cleanupDuplicateMediaMessageId(), 0, '幂等：再跑一次没有可清理的');
});
