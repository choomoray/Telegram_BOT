// tests/recordMedia.test.js
/**
 * 媒体收录 / group_list.is_delete 语义回归测试
 *
 * 语义（统一规则，见 db/groupList.js:syncGroupDeleteByText）：
 *   - 描述为空的媒体（组）照常收录进 media；
 *   - 组内没有任何文本（message 记录）时，group_list.is_delete = 时间戳（可被 /clean 清理）；
 *   - 之后补上 / 修改描述 → is_delete = 0（无需清理）；再清空 → 回到时间戳。
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
    sleep,
    resetStore
} = require('./helpers/memoryDb');

relaxTimers();
installMemoryDb(root);
installBotStub(root);
installLoggerStub(root);

const { handleGroupMessage, handleGroupEditedMessage } = require('../handlers/groupMessageHandlers');
const { handleSendMode } = require('../handlers/modes/sendMode');
const { updateMessageDb } = require('../handlers/modes/editMode');
const { setUserState, deleteUserState } = require('../states');
const { getCollection, COLLECTIONS } = require('../db/getCollection');

const GROUP = -1009001;
const CHANNEL = -1007001;
const USER = 999;
const TARGET = -1001234;

const getMedia = () => store.get('media') || [];
const getMessages = () => store.get('message') || [];
const findGroupList = (groupId) => (store.get('group_list') || []).find(d => d.group_id === groupId) || null;
const groupMsg = (messageId, extra = {}) => ({
    chat: { id: GROUP, type: 'supergroup' }, message_id: messageId, from: { id: 7 }, ...extra
});
const chanMsg = (messageId, extra = {}) => ({
    chat: { id: CHANNEL, type: 'channel' }, message_id: messageId, ...extra
});
const forwardMsg = (messageId, extra = {}) => groupMsg(messageId, {
    forward_origin: { type: 'channel', chat: { id: CHANNEL, type: 'channel' } }, ...extra
});

function startSendMode() {
    setUserState(USER, {
        mode: 'send', step: 'ready', targetChatId: TARGET, targetName: '测试群',
        targetType: 'group', lastActivity: Date.now()
    });
}
const sendMsg = (messageId, extra = {}) => ({
    from: { id: USER }, chat: { id: USER, type: 'private' }, message_id: messageId, ...extra
});

// ---------------- 群组自动收录 ----------------

test('群组自动收录：整组空描述的媒体组照常入库，is_delete 记为时间戳', async () => {
    resetStore();
    await handleGroupMessage(groupMsg(4001, { media_group_id: 'GG1', photo: [{ file_id: 'D0', file_unique_id: 'UD0' }] }));
    await handleGroupMessage(groupMsg(4002, { media_group_id: 'GG1', photo: [{ file_id: 'D1', file_unique_id: 'UD1' }] }));

    const groupId = `${GROUP}_GG1`;
    const media = getMedia().filter(d => d.group_id === groupId);
    assert.equal(media.length, 2, '两条空描述媒体都应收录进 media');
    assert.equal(getMessages().length, 0, '空描述不写 message');

    const gl = findGroupList(groupId);
    assert.equal(gl.is_group, 2);
    assert.ok(gl.is_delete > 0, `is_delete 应为时间戳（可清理），实际 ${gl.is_delete}`);
});

test('群组自动收录：空描述媒体组补上描述后 is_delete 归 0，再清空回到时间戳', async () => {
    resetStore();
    await handleGroupMessage(groupMsg(4101, { media_group_id: 'GG2', photo: [{ file_id: 'E0', file_unique_id: 'UE0' }] }));
    const groupId = `${GROUP}_GG2`;
    assert.ok(findGroupList(groupId).is_delete > 0);

    // 后续编辑补上描述
    await handleGroupEditedMessage(groupMsg(4101, {
        media_group_id: 'GG2', caption: '补上的描述', photo: [{ file_id: 'E0', file_unique_id: 'UE0' }]
    }));
    assert.equal(findGroupList(groupId).is_delete, 0, '补描述后无需清理');
    assert.equal(getMessages().length, 1);

    // 再清空描述
    await handleGroupEditedMessage(groupMsg(4101, {
        media_group_id: 'GG2', photo: [{ file_id: 'E0', file_unique_id: 'UE0' }]
    }));
    assert.equal(getMessages().length, 0);
    assert.ok(findGroupList(groupId).is_delete > 0, '清空描述后重新可清理');
});

test('群组自动收录：有描述的媒体 is_delete 为 0', async () => {
    resetStore();
    await handleGroupMessage(groupMsg(4201, { caption: '有描述', photo: [{ file_id: 'F0', file_unique_id: 'UF0' }] }));
    const gl = findGroupList(`${GROUP}_4201`);
    assert.equal(gl.is_delete, 0);
    assert.equal(gl.is_group, 1);
    assert.equal(getMessages().length, 1);
});

// ---------------- 频道转发兜底 ----------------

test('频道转发：媒体库中不存在且描述为空时照常收录 media（不丢数据）', async () => {
    resetStore();
    await handleGroupMessage(forwardMsg(6001, { photo: [{ file_id: 'G0', file_unique_id: 'UG0' }] }));

    const doc = getMedia().find(d => d.file_unique_id === 'UG0');
    assert.ok(doc, '频道转发且库中不存在时应照常收录进 media');
    assert.deepEqual(doc.group, { chat_id: GROUP, message_id: 6001 });
    assert.equal(doc.media_type, 'photo');

    const gl = findGroupList(`${GROUP}_6001`);
    assert.ok(gl, '应新建 group_list');
    assert.equal(gl.is_group, 1);
    assert.ok(gl.is_delete > 0, '空描述 → 可清理');
    assert.equal(getMessages().length, 0);
});

test('频道转发：媒体库中不存在但有描述时收录 media + message，is_delete 为 0', async () => {
    resetStore();
    await handleGroupMessage(forwardMsg(6101, {
        caption: '转发带描述', photo: [{ file_id: 'H0', file_unique_id: 'UH0' }]
    }));

    const doc = getMedia().find(d => d.file_unique_id === 'UH0');
    assert.ok(doc);
    const msg = getMessages().find(m => m.file_unique_id === 'UH0');
    assert.ok(msg, '有描述应写 message');
    assert.equal(msg.group_id, `${GROUP}_6101`, 'message 应归属新建的群组');
    assert.equal(findGroupList(`${GROUP}_6101`).is_delete, 0);
});

test('频道转发：媒体库中已存在时不重复收录，仅补双位置', async () => {
    resetStore();
    // 频道侧先收录
    await handleGroupMessage(chanMsg(5001, { photo: [{ file_id: 'I0', file_unique_id: 'UI0' }] }));
    assert.equal(getMedia().length, 1);

    // 讨论群组收到同一条自动转发
    await handleGroupMessage(forwardMsg(5002, { photo: [{ file_id: 'I0', file_unique_id: 'UI0' }] }));

    const docs = getMedia().filter(d => d.file_unique_id === 'UI0');
    assert.equal(docs.length, 1, '不应重复收录');
    assert.equal(docs[0].channel.chat_id, CHANNEL);
    assert.equal(docs[0].group.chat_id, GROUP, '应补群组位置');
    assert.equal(docs[0].group.message_id, 5002);
});

// ---------------- /send 发送模式 ----------------

test('/send：空描述单条媒体照常收录，is_delete 记为时间戳', async () => {
    resetStore();
    startSendMode();
    await handleSendMode(sendMsg(7001, { photo: [{ file_id: 'J0', file_unique_id: 'UJ0' }] }), require('../states').getRawUserState(USER));

    const groupId = `${TARGET}_7001`;
    const doc = getMedia().find(d => d.group_id === groupId);
    assert.ok(doc, '空描述媒体应收录进 media');
    // 位置只写子文档（不再写顶层 message_id）
    assert.equal(doc.group.chat_id, TARGET);
    assert.ok(doc.group.message_id > 0, '群组位置应带消息 ID');
    assert.ok(!('message_id' in doc), '顶层 message_id 已废弃，不应再写');
    assert.equal(getMessages().length, 0);
    assert.ok(findGroupList(groupId).is_delete > 0);
});

test('/send：有描述单条媒体收录 media + message，is_delete 为 0', async () => {
    resetStore();
    startSendMode();
    await handleSendMode(sendMsg(7101, {
        caption: '发送描述', photo: [{ file_id: 'K0', file_unique_id: 'UK0' }]
    }), require('../states').getRawUserState(USER));

    const groupId = `${TARGET}_7101`;
    assert.ok(getMedia().find(d => d.group_id === groupId));
    assert.equal(getMessages().length, 1);
    assert.equal(findGroupList(groupId).is_delete, 0);
});

test('/send：空描述媒体组整组收录，is_delete 记为时间戳', async () => {
    resetStore();
    startSendMode();
    for (let i = 0; i < 3; i++) {
        await handleSendMode(sendMsg(7200 + i, {
            media_group_id: 'SENDG1', photo: [{ file_id: `L${i}`, file_unique_id: `UL${i}` }]
        }), require('../states').getRawUserState(USER));
    }
    // 等待媒体组收集窗口（3s）后统一发送并落库
    await sleep(3600);

    const groupId = `${TARGET}_SENDG1`;
    assert.equal(getMedia().filter(d => d.group_id === groupId).length, 3, '整组空描述媒体都应入库');
    assert.equal(getMessages().length, 0);
    const gl = findGroupList(groupId);
    assert.equal(gl.is_group, 3);
    assert.ok(gl.is_delete > 0);
    deleteUserState(USER);
});

// ---------------- 编辑/清空描述 ----------------

test('清空描述：组内无其他文本 → is_delete 变时间戳；组内还有其他文本 → 保持 0', async () => {
    resetStore();
    // 组内两条媒体：一条有描述、一条空描述
    await handleGroupMessage(groupMsg(8001, { media_group_id: 'GG9', caption: '第一条描述', photo: [{ file_id: 'M0', file_unique_id: 'UM0' }] }));
    await handleGroupMessage(groupMsg(8002, { media_group_id: 'GG9', photo: [{ file_id: 'M1', file_unique_id: 'UM1' }] }));
    const groupId = `${GROUP}_GG9`;
    assert.equal(findGroupList(groupId).is_delete, 0);

    const messageCol = getCollection(COLLECTIONS.MESSAGE);
    // 清空第一条的描述：组内已无文本 → 时间戳
    await updateMessageDb(messageCol, {
        isClearing: true, targetChatId: GROUP, targetMessageId: 8001,
        targetGroupId: groupId, targetFileUniqueId: 'UM0', targetMediaType: 'photo', cleanText: '第一条描述'
    });
    assert.equal(getMessages().length, 0);
    assert.ok(findGroupList(groupId).is_delete > 0, '组内无文本 → 可清理');

    // 再给另一条补上描述 → 回到 0
    await updateMessageDb(messageCol, {
        isClearing: false, targetChatId: GROUP, targetMessageId: 8002,
        targetGroupId: groupId, targetFileUniqueId: 'UM1', targetMediaType: 'photo', cleanText: '补的描述'
    });
    assert.equal(findGroupList(groupId).is_delete, 0, '补文本后无需清理');
});
