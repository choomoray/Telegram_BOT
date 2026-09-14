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

// ---------------- 删除媒体组后重新发送同一批文件（守卫不能误挡） ----------------

test('/send：媒体组发送完成后守卫立即解除 —— 删掉媒体组后能重新发送同一批文件', async () => {
    resetStore();
    startSendMode();
    const FILES = ['GW0', 'GW1', 'GW2'];
    const groupMsgOf = (gid, baseId) => FILES.map((f, i) => sendMsg(baseId + i, {
        media_group_id: gid, photo: [{ file_id: f, file_unique_id: f }]
    }));

    // 第一次发送：3 张图入库
    for (const m of groupMsgOf('GUARDG1', 7600)) {
        await handleSendMode(m, require('../states').getRawUserState(USER));
    }
    await sleep(3600);
    const groupId = `${TARGET}_GUARDG1`;
    assert.equal(getMedia().filter(d => d.group_id === groupId).length, 3, '第一次发送应入库 3 条');

    // 模拟 /delete_group：删掉该组的 media / message / group_list
    store.set('media', getMedia().filter(d => d.group_id !== groupId));
    store.set('message', getMessages().filter(d => d.group_id !== groupId));
    store.set('group_list', (store.get('group_list') || []).filter(d => d.group_id !== groupId));

    // 立即重新发送同一批文件（历史上会被 5 分钟"已发送守卫"静默忽略）
    for (const m of groupMsgOf('GUARDG2', 7700)) {
        await handleSendMode(m, require('../states').getRawUserState(USER));
    }
    await sleep(3600);

    const groupId2 = `${TARGET}_GUARDG2`;
    const resend = getMedia().filter(d => d.group_id === groupId2);
    assert.equal(resend.length, 3, '重新发送必须真的入库（不能被守卫当成重复消息忽略）');
    assert.deepStrictEqual(resend.map(d => d.file_unique_id).sort(), [...FILES].sort());
    deleteUserState(USER);
});

test('/send：同一批文件在发送过程中重复投递，只入库一次（守卫仍然生效）', async () => {
    resetStore();
    startSendMode();
    // 第二轮消息在第一次 flush 的发送窗口内重复投递：file_unique_id 相同、media_group_id 不同
    for (let i = 0; i < 2; i++) {
        await handleSendMode(sendMsg(7800 + i, {
            media_group_id: 'DUPA', photo: [{ file_id: 'DP0', file_unique_id: 'DP0' }]
        }), require('../states').getRawUserState(USER));
        await handleSendMode(sendMsg(7810 + i, {
            media_group_id: 'DUPB', photo: [{ file_id: 'DP0', file_unique_id: 'DP0' }]
        }), require('../states').getRawUserState(USER));
    }
    await sleep(4200);

    assert.equal(getMedia().filter(d => d.file_unique_id === 'DP0').length, 1, '同一文件只能入库一次');
    deleteUserState(USER);
});

// ---------------- 描述（注释）必须随相册一起发出去 ----------------

test('/send 媒体组：描述不在第一条时，发送时先把第一条注释带上，发完还原位置并清掉第一条', async () => {
    resetStore();
    startSendMode();
    const bot = require('../bot');   // 文件顶部已装入的 bot 桩（sendMode 持有同一个对象）

    const albums = [];       // 每次 sendMediaGroup 实际发出的 media 数组
    const captionEdits = []; // editMessageCaption 调用
    bot.sendMediaGroup = async (chatId, media) => {
        albums.push(media.map(m => ({ type: m.type, media: m.media, caption: m.caption })));
        return media.map((m, i) => ({
            message_id: 900 + i, chat: { id: chatId },
            photo: [{ file_id: `sent-${m.media}`, file_unique_id: `sent-U${m.media}` }]
        }));
    };
    bot.editMessageCaption = async (text, opts) => { captionEdits.push({ text, ...opts }); return true; };
    bot.sendMessage = async (chatId, text) => ({ message_id: 1000, chat: { id: chatId }, text });

    // 3 张图，描述在第 3 条（第 1 条没有描述）
    await handleSendMode(sendMsg(7900, { media_group_id: 'CAPG1', photo: [{ file_id: 'C0', file_unique_id: 'UC0' }] }), require('../states').getRawUserState(USER));
    await handleSendMode(sendMsg(7901, { media_group_id: 'CAPG1', photo: [{ file_id: 'C1', file_unique_id: 'UC1' }] }), require('../states').getRawUserState(USER));
    await handleSendMode(sendMsg(7902, { media_group_id: 'CAPG1', caption: '第三条才有描述', photo: [{ file_id: 'C2', file_unique_id: 'UC2' }] }), require('../states').getRawUserState(USER));
    await sleep(3600);
    deleteUserState(USER);

    assert.equal(albums.length, 1, '整组一次发出');
    assert.equal(albums[0][0].caption, '第三条才有描述',
        '发送那一刻第一条就带上描述（否则频道帖的自动转发副本会没有描述）');
    assert.equal(albums[0][2].caption, undefined, '原位置不重复带（发送后编辑还原）');
    // 发送后：还原到第 3 条 + 清掉第一条临时带上的
    assert.deepStrictEqual(captionEdits.map(e => e.text), ['第三条才有描述', ''],
        '先编辑回第 3 条，再清掉第 1 条');
    assert.equal(captionEdits[0].message_id, 902, '编辑的是第 3 条对应的消息');
    assert.equal(captionEdits[1].message_id, 900, '清空的是第 1 条对应的消息');
    // 描述照旧收录成 message（视频/图片的描述一律保留）
    const msg = getMessages().find(m => m.file_unique_id === 'UC2');
    assert.ok(msg, '带描述的媒体要写 message');
    assert.equal(msg.text, '第三条才有描述');
});

test('/send 媒体组：描述本来就在第一条 → 只内联带上，不做多余的编辑', async () => {
    resetStore();
    startSendMode();
    const bot = require('../bot');   // 文件顶部已装入的 bot 桩（sendMode 持有同一个对象）
    const albums = [];
    const captionEdits = [];
    bot.sendMediaGroup = async (chatId, media) => {
        albums.push(media.map(m => m.caption));
        return media.map((m, i) => ({
            message_id: 950 + i, chat: { id: chatId },
            photo: [{ file_id: `sent-${m.media}`, file_unique_id: `sent-U${m.media}` }]
        }));
    };
    bot.editMessageCaption = async (text, opts) => { captionEdits.push({ text, ...opts }); return true; };
    bot.sendMessage = async (chatId, text) => ({ message_id: 1100, chat: { id: chatId }, text });

    await handleSendMode(sendMsg(7950, { media_group_id: 'CAPG2', caption: '第一条描述', photo: [{ file_id: 'D0', file_unique_id: 'UD0' }] }), require('../states').getRawUserState(USER));
    await handleSendMode(sendMsg(7951, { media_group_id: 'CAPG2', photo: [{ file_id: 'D1', file_unique_id: 'UD1' }] }), require('../states').getRawUserState(USER));
    await sleep(3600);
    deleteUserState(USER);

    assert.deepStrictEqual(albums[0], ['第一条描述', undefined], '第一条内联带描述');
    assert.deepStrictEqual(captionEdits, [], '描述本来就在第一条 → 不需要任何编辑');
});

// ---------------- 频道帖自动转发抢跑：不另建"无描述"的影子媒体组 ----------------

test('频道转发抢跑：该文件正在被 /send 发送时，等落库完成再收录（不另建影子组）', async () => {
    resetStore();
    const { markInFlight, clearInFlight } = require('../utils/inflight');
    const groupId = `${GROUP}_9001`;

    // 模拟"机器人正在把这两个视频发给频道"：标记 in-flight，并延迟落库
    markInFlight('FR1');
    markInFlight('FR2');
    setTimeout(() => {
        getMedia().push(
            { _id: 'fr1', group_id: `${CHANNEL}_777`, subgroup: 1, file_id: 'F1', file_unique_id: 'FR1', media_type: 'video', channel: { chat_id: CHANNEL, message_id: 7001 } },
            { _id: 'fr2', group_id: `${CHANNEL}_777`, subgroup: 1, file_id: 'F2', file_unique_id: 'FR2', media_type: 'video', channel: { chat_id: CHANNEL, message_id: 7002 } }
        );
        store.set('message', [{ _id: 'fr1m', group_id: `${CHANNEL}_777`, file_unique_id: 'FR1', media_type: 'video', chat_id: CHANNEL, message_id: 7001, text: '频道的描述' }]);
        clearInFlight('FR1');
        clearInFlight('FR2');
    }, 500);

    // 频道帖子立刻被自动转发到讨论群
    await handleGroupMessage(forwardMsg(9001, {
        media_group_id: 'FWDGROUP1', video: { file_id: 'F1', file_unique_id: 'FR1', duration: 10 }
    }));

    const docs = getMedia().filter(d => d.file_unique_id === 'FR1');
    assert.equal(docs.length, 1, '不另建影子记录：整库只有一条该媒体');
    assert.equal(docs[0].group_id, `${CHANNEL}_777`, '仍归属 /send 建的那个组（描述也在那条 message 上）');
    assert.deepStrictEqual(docs[0].group, { chat_id: GROUP, message_id: 9001 }, '只补一个群组位置（双位置）');
    assert.ok(!findGroupList(groupId), '不应为转发另建媒体组（历史上会多出一组"无描述、可清理"的影子组）');
});

// ---------------- in-flight 登记表（/send 发送窗口） ----------------

test('in-flight 登记：只覆盖发送窗口，TTL 兜底后自动失效（不会永久挡住重新发送）', () => {
    const { markInFlight, clearInFlight, isInFlight, sweepInFlight, TTL_MS } = require('../utils/inflight');
    const FILE = 'IF_TEST_1';
    assert.strictEqual(isInFlight(FILE), false, '初始未登记');
    markInFlight(FILE);
    assert.strictEqual(isInFlight(FILE), true, '发送中 → 为真');
    clearInFlight(FILE);
    assert.strictEqual(isInFlight(FILE), false, '发送流程结束（finally）即解除 → delete_group 后能重新发送');

    const FILE2 = 'IF_TEST_2';
    markInFlight(FILE2);
    sweepInFlight(Date.now() + TTL_MS + 1);
    assert.strictEqual(isInFlight(FILE2), false, '超过 TTL 自动失效，不会永久挡路');
    assert.strictEqual(isInFlight(null), false);
    assert.strictEqual(isInFlight(''), false);
});

// ---------------- 文件 / 音乐名称（media_name） ----------------

test('收录：文档/音频记录文件（音乐）名称，图片/视频不记录', async () => {
    resetStore();
    await handleGroupMessage(groupMsg(4301, {
        document: { file_id: 'DN0', file_unique_id: 'UDN0', file_name: '报告 2026.pdf' }
    }));
    await handleGroupMessage(groupMsg(4302, {
        audio: { file_id: 'AU0', file_unique_id: 'UAU0', file_name: 'song.mp3', title: '歌名', performer: '歌手' }
    }));
    await handleGroupMessage(groupMsg(4303, {
        audio: { file_id: 'AU1', file_unique_id: 'UAU1', title: '只有标题', performer: '某艺术家' }
    }));
    await handleGroupMessage(groupMsg(4304, { photo: [{ file_id: 'PH0', file_unique_id: 'UPH0' }] }));
    await handleGroupMessage(groupMsg(4305, {
        video: { file_id: 'VI0', file_unique_id: 'UVI0', duration: 12, file_name: '不该记录.mp4' }
    }));

    const byId = (id) => getMedia().find(d => d.file_unique_id === id);
    assert.equal(byId('UDN0').media_name, '报告 2026.pdf', '文档记录 file_name');
    assert.equal(byId('UAU0').media_name, 'song.mp3', '音频优先用 file_name');
    assert.equal(byId('UAU1').media_name, '只有标题 - 某艺术家', '音频没有 file_name 时用「标题 - 艺术家」');
    assert.ok(!('media_name' in byId('UPH0')), '图片不记录名称');
    assert.ok(!('media_name' in byId('UVI0')), '视频不记录名称（即使 Telegram 带了 file_name）');
});

test('收录：音频不再自动生成描述（严格按用户发送的内容）', async () => {
    resetStore();
    await handleGroupMessage(groupMsg(4401, {
        audio: { file_id: 'AU2', file_unique_id: 'UAU2', title: '歌名', performer: '歌手' }
    }));

    const groupId = `${GROUP}_4401`;
    assert.equal(getMessages().length, 0, '没有 caption 就不该写 message（以前会自动拼「标题 - 艺术家」）');
    assert.ok(findGroupList(groupId).is_delete > 0, '没有描述 → 仍按空描述组处理');
    // 但名称要记下来，供按文件名/音乐名搜索
    assert.equal(getMedia().find(d => d.file_unique_id === 'UAU2').media_name, '歌名 - 歌手');
});

test('/send：文档记录文件名（按文件名可搜索）', async () => {
    resetStore();
    startSendMode();
    await handleSendMode(sendMsg(7301, {
        document: { file_id: 'DN1', file_unique_id: 'UDN1', file_name: '设计稿.psd' }
    }), require('../states').getRawUserState(USER));

    const doc = getMedia().find(d => d.file_unique_id === 'UDN1');
    assert.equal(doc.media_name, '设计稿.psd');
});

// ---------------- 文本媒体（/send、/reply 的纯文本） ----------------

test('/send 发文本：收录为 media_type=text，内容进 media_name，entities 保留格式', async () => {
    resetStore();
    startSendMode();
    const entities = [{ type: 'bold', offset: 0, length: 2 }];
    await handleSendMode(sendMsg(7401, { text: '加粗文本内容', entities }), require('../states').getRawUserState(USER));

    const groupId = `${TARGET}_7401`;
    const doc = getMedia().find(d => d.group_id === groupId);
    assert.ok(doc, '文本应被收录进 media');
    assert.equal(doc.media_type, 'text', '新增的文本类型');
    assert.equal(doc.media_name, '加粗文本内容', '文本内容借用文件名那个字段存放');
    assert.deepEqual(doc.media_entities, entities, 'entities 一起存 → 保留 Telegram 文本格式');
    assert.match(doc.file_unique_id, /^text:/, '文本没有 Telegram file，用位置造唯一 ID');
    assert.equal(getMessages().length, 0, '不写 message（message 是描述 + 标签的载体）');
    assert.equal(findGroupList(groupId).is_delete, 0, '文本本身就是内容，不能被当成空描述组清掉');
});

test('/send 发文本：没有格式时不写 media_entities', async () => {
    resetStore();
    startSendMode();
    await handleSendMode(sendMsg(7501, { text: '纯文本' }), require('../states').getRawUserState(USER));
    const doc = getMedia().find(d => d.group_id === `${TARGET}_7501`);
    assert.equal(doc.media_name, '纯文本');
    assert.ok(!('media_entities' in doc), '无 entities 不写该字段');
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
