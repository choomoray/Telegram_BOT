// tests/deleteGroupList.test.js
/**
 * 删除媒体后的 group_list 维护（以 media 实际记录为准，不看可能漂移的 is_group 计数）：
 *   - 删掉组内最后一个媒体 → group_list 记录必须一并删除（并清掉残留 message）；
 *   - is_group 计数漂移（大于真实媒体数）时同样要删掉，不能"计数减不到 0 就一直留着"；
 *   - is_group 计数偏小（小于真实媒体数）时不能误删整个组，要把计数重算回真实数量；
 *   - 组内还有媒体 → 只删当前媒体并重算 is_group / is_delete / tags；
 *   - 启动清理 cleanupOrphanGroupList 幂等清掉历史遗留的空组。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const root = path.join(__dirname, '..');
const {
    store,
    installMemoryDb,
    installBotStub,
    installLoggerStub,
    relaxTimers,
    resetStore
} = require('./helpers/memoryDb');

relaxTimers();
installMemoryDb(root);
installBotStub(root);
installLoggerStub(root);

const handleDeleteMode = require('../handlers/modes/deleteMode');
const handleDeleteGroupMode = require('../handlers/modes/deleteGroupMode');
const { removeMediaGroupIfEmpty, cleanupOrphanGroupList } = require('../db/groupList');
const { setUserState } = require('../states');
const { COLLECTIONS } = require('../db/getCollection');

const USER = 4242;
const GROUP_ID = '-100_71';

const findGroupList = (groupId) => (store.get(COLLECTIONS.GROUP_LIST) || []).find(d => d.group_id === groupId) || null;
const mediaOf = (groupId) => (store.get(COLLECTIONS.MEDIA) || []).filter(m => m.group_id === groupId);
const messagesOf = (groupId) => (store.get(COLLECTIONS.MESSAGE) || []).filter(m => m.group_id === groupId);

const sendMsg = (fileUniqueId, messageId = 900) => ({
    from: { id: USER },
    chat: { id: USER, type: 'private' },
    message_id: messageId,
    photo: [{ file_id: `file-${fileUniqueId}`, file_unique_id: fileUniqueId }]
});

function seedGroup({ isGroup, mediaCount, withText = [] }) {
    store.set(COLLECTIONS.GROUP_LIST, [{
        _id: 'g1', group_id: GROUP_ID, is_group: isGroup, is_delete: 0, mark: 0
    }]);
    const media = [];
    const messages = [];
    for (let i = 0; i < mediaCount; i++) {
        const fid = `F${i}`;
        media.push({
            _id: `m${i}`, group_id: GROUP_ID, subgroup: 1, file_unique_id: fid, media_type: 'photo',
            group: { chat_id: -100, message_id: 100 + i }
        });
        if (withText.includes(fid)) {
            messages.push({
                _id: `s${i}`, group_id: GROUP_ID, file_unique_id: fid, text: `描述${i}`,
                chat_id: -100, message_id: 100 + i, tags: ['T' + i]
            });
        }
    }
    store.set(COLLECTIONS.MEDIA, media);
    store.set(COLLECTIONS.MESSAGE, messages);
}

function startDeleteMode() {
    setUserState(USER, { mode: 'delete', step: 'ready', lastActivity: Date.now() });
}

// ---------------- 删除最后一个媒体 ----------------

test('删除最后一个媒体：group_list 一并删除（含残留 message）', async () => {
    resetStore();
    seedGroup({ isGroup: 1, mediaCount: 1, withText: ['F0'] });
    startDeleteMode();

    await handleDeleteMode(sendMsg('F0'), { mode: 'delete', step: 'ready' });

    assert.equal(mediaOf(GROUP_ID).length, 0, '媒体已删除');
    assert.equal(findGroupList(GROUP_ID), null, '组内已无媒体 → group_list 必须删除');
    assert.equal(messagesOf(GROUP_ID).length, 0, '残留 message 一并清理');
});

test('is_group 计数漂移偏大：删最后一个媒体也要删掉 group_list', async () => {
    resetStore();
    // 真实只有 1 条媒体，但计数写成 3（历史漂移 / 重复计数）
    seedGroup({ isGroup: 3, mediaCount: 1, withText: ['F0'] });
    startDeleteMode();

    await handleDeleteMode(sendMsg('F0'), { mode: 'delete', step: 'ready' });

    assert.equal(mediaOf(GROUP_ID).length, 0);
    assert.equal(findGroupList(GROUP_ID), null, '不能因为计数减不到 0 就把空组留在库里');
});

test('is_group 计数漂移偏小：不能误删整个组，计数重算为真实数量', async () => {
    resetStore();
    // 真实有 2 条媒体，但计数写成 1（旧实现会因此把整个组删掉）
    seedGroup({ isGroup: 1, mediaCount: 2, withText: ['F0', 'F1'] });
    startDeleteMode();

    await handleDeleteMode(sendMsg('F0'), { mode: 'delete', step: 'ready' });

    assert.equal(mediaOf(GROUP_ID).length, 1, '组内还剩 1 条媒体');
    const gl = findGroupList(GROUP_ID);
    assert.ok(gl, '组内还有媒体 → group_list 保留');
    assert.equal(gl.is_group, 1, 'is_group 重算为真实剩余数量');
    assert.equal(gl.is_delete, 0, '组内仍有描述 → 保留');
});

// ---------------- 组内还有媒体 ----------------

test('组内还有媒体：只删当前媒体，重算 is_group / is_delete / tags', async () => {
    resetStore();
    seedGroup({ isGroup: 2, mediaCount: 2, withText: ['F0', 'F1'] });
    startDeleteMode();

    await handleDeleteMode(sendMsg('F0'), { mode: 'delete', step: 'ready' });

    const gl = findGroupList(GROUP_ID);
    assert.equal(mediaOf(GROUP_ID).length, 1);
    assert.equal(gl.is_group, 1);
    assert.equal(gl.is_delete, 0, '组内仍有 F1 的描述 → 无需清理');
    assert.deepStrictEqual(gl.tags, ['T1'], '唯一带标签的那条被删掉后 tags 同步为剩余并集');
});

test('删掉唯一带描述的媒体：is_delete 变回可清理，tags 字段移除', async () => {
    resetStore();
    seedGroup({ isGroup: 2, mediaCount: 2, withText: ['F0'] });
    startDeleteMode();

    await handleDeleteMode(sendMsg('F0'), { mode: 'delete', step: 'ready' });

    const gl = findGroupList(GROUP_ID);
    assert.ok(gl, '组内还有媒体 → group_list 保留');
    assert.equal(gl.is_group, 1);
    assert.ok(gl.is_delete > 0, '组内已无任何描述 → 可被 /clean 清理');
    assert.ok(!('tags' in gl), '组内已无标签 → 移除 tags 字段');
});

// ---------------- 删除整个媒体组 ----------------

test('/delete_group：媒体、message、group_list 一起删除', async () => {
    resetStore();
    seedGroup({ isGroup: 2, mediaCount: 2, withText: ['F0', 'F1'] });
    setUserState(USER, { mode: 'delete_group', step: 'ready', lastActivity: Date.now() });

    await handleDeleteGroupMode(sendMsg('F0'), { mode: 'delete_group', step: 'ready' });

    assert.equal(mediaOf(GROUP_ID).length, 0);
    assert.equal(messagesOf(GROUP_ID).length, 0);
    assert.equal(findGroupList(GROUP_ID), null);
});

// ---------------- 工具函数与启动清理 ----------------

test('removeMediaGroupIfEmpty：无媒体删组、有媒体重算计数', async () => {
    resetStore();
    seedGroup({ isGroup: 5, mediaCount: 2 });

    const kept = await removeMediaGroupIfEmpty(GROUP_ID);
    assert.deepStrictEqual(kept, { removed: false, remaining: 2 });
    assert.equal(findGroupList(GROUP_ID).is_group, 2);

    store.set(COLLECTIONS.MEDIA, []);
    const gone = await removeMediaGroupIfEmpty(GROUP_ID);
    assert.deepStrictEqual(gone, { removed: true, remaining: 0 });
    assert.equal(findGroupList(GROUP_ID), null);
});

test('cleanupOrphanGroupList：清理历史遗留的空组并幂等', async () => {
    resetStore();
    store.set(COLLECTIONS.GROUP_LIST, [
        { _id: 'g1', group_id: 'EMPTY_1', is_group: 3, is_delete: 0, mark: 0 },
        { _id: 'g2', group_id: 'ALIVE_1', is_group: 1, is_delete: 0, mark: 0 }
    ]);
    store.set(COLLECTIONS.MEDIA, [
        { _id: 'm1', group_id: 'ALIVE_1', subgroup: 1, file_unique_id: 'A1', media_type: 'photo' }
    ]);
    store.set(COLLECTIONS.MESSAGE, [
        { _id: 's1', group_id: 'EMPTY_1', file_unique_id: 'ORPHAN', text: '孤儿描述' },
        { _id: 's2', group_id: 'ALIVE_1', file_unique_id: 'A1', text: '正常描述' }
    ]);

    const first = await cleanupOrphanGroupList();
    assert.deepStrictEqual(first, { removed: 1, messages: 1 }, '只清理没有媒体的组，并清掉其孤儿 message');
    assert.equal(findGroupList('EMPTY_1'), null);
    assert.ok(findGroupList('ALIVE_1'), '有媒体的组不受影响');
    assert.ok(messagesOf('ALIVE_1').length === 1, '正常组的描述保留');

    const second = await cleanupOrphanGroupList();
    assert.deepStrictEqual(second, { removed: 0, messages: 0 }, '幂等：再跑一次不再清理');
});
