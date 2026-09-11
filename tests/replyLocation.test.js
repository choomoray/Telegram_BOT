// tests/replyLocation.test.js
/**
 * 消息回复模式的"回复位置"语义：
 *   - 频道转发消息（message.channel_forward 双位置）→ **必须弹出「👥 回复在群组 / 📢 回复在频道」按钮**，
 *     不能静默选一个位置；
 *   - 未指定位置时**默认回复在群组**（不是频道）；
 *   - 选定位置后就绪消息上要有「🔄 更改为发送至…」一键切换按钮；
 *   - 位置选择不能"粘住"状态：否则后续媒体既不询问、也不按默认群组，会静默回复到频道；
 *   - 只有单边位置（缺群组位置等）时按可用位置直接进入就绪，不弹空按钮。
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
const { bot } = installBotStub(root);
installLoggerStub(root);

const replyMode = require('../handlers/modes/messageReplyMode');
const handleMessageReplyMode = require('../handlers/modes/messageReplyMode');
const { setUserState, getRawUserState } = require('../states');
const { COLLECTIONS } = require('../db/getCollection');

const USER = 6161;
const GROUP_CHAT = -100777;
const CHANNEL_CHAT = -100888;
const GROUP_ID = `${GROUP_CHAT}_500`;
const FILE_ID = 'RF1';
const CHANNEL_MESSAGE_ID = 77;
const GROUP_MESSAGE_ID = 501;

const sendMsg = (messageId, extra = {}) => ({
    from: { id: USER }, chat: { id: USER, type: 'private' }, message_id: messageId, ...extra
});

const callbackQuery = (data, messageId = 4000) => ({
    id: `q-${data}`, data, from: { id: USER },
    message: { chat: { id: USER }, message_id: messageId }
});

/** 频道转发消息：message 记录带 channel_forward 双位置 */
function seedForwardMessage() {
    store.set(COLLECTIONS.MESSAGE, [{
        _id: 's1', group_id: GROUP_ID, file_unique_id: FILE_ID, text: '转发描述',
        chat_id: CHANNEL_CHAT, message_id: CHANNEL_MESSAGE_ID, media_type: 'photo', tags: [],
        channel_forward: {
            is_channel: true,
            channel_chat_id: CHANNEL_CHAT,
            channel_message_id: CHANNEL_MESSAGE_ID,
            group_chat_id: GROUP_CHAT,
            group_message_id: GROUP_MESSAGE_ID
        }
    }]);
    store.set(COLLECTIONS.MEDIA, [{
        _id: 'm1', group_id: GROUP_ID, subgroup: 1, file_unique_id: FILE_ID, media_type: 'photo',
        file_id: 'AgACRF1', group: { chat_id: GROUP_CHAT, message_id: GROUP_MESSAGE_ID },
        channel: { chat_id: CHANNEL_CHAT, message_id: CHANNEL_MESSAGE_ID }
    }]);
    store.set(COLLECTIONS.GROUP_LIST, [{ _id: 'g1', group_id: GROUP_ID, is_group: 1, is_delete: 0, mark: 0 }]);
}

/** 记录 bot 调用 */
function trackBot() {
    const sent = [];
    const edits = [];
    const answers = [];
    bot.sendMessage = async (chatId, text, opts) => {
        sent.push({ chatId, text, opts });
        return { message_id: 7000 + sent.length, chat: { id: chatId } };
    };
    bot.editMessageText = async (text, opts) => { edits.push({ text, opts }); return true; };
    bot.answerCallbackQuery = async (id, extra) => { answers.push({ id, extra }); };
    bot.sendPhoto = async () => ({ message_id: 8001, chat: { id: GROUP_CHAT }, photo: [{ file_id: 'x', file_unique_id: 'new1' }] });
    return { sent, edits, answers };
}

function startReplyMode(replyTarget = null) {
    setUserState(USER, {
        mode: 'message_reply', step: 'waiting_for_target', replyTarget,
        packSize: null, targetGroupId: null, targetChatId: null, targetMessageId: null,
        processingMsgId: null, hintMsgInfo: null,
        _onExit: async () => { }, lastActivity: Date.now()
    });
}

const locate = (messageId = 500) => handleMessageReplyMode(
    sendMsg(messageId, { photo: [{ file_id: 'AgACRF1', file_unique_id: FILE_ID }] }),
    getRawUserState(USER)
);

/** 找出带指定 callback_data 的按钮 */
function findButton(edits, callbackData) {
    for (const e of edits) {
        const rows = e.opts && e.opts.reply_markup && e.opts.reply_markup.inline_keyboard;
        if (!rows) continue;
        for (const row of rows) {
            const hit = row.find(b => b.callback_data === callbackData);
            if (hit) return hit;
        }
    }
    return null;
}

// ---------------- 询问回复位置 ----------------

test('/message_reply 定位到频道转发消息：弹出「回复在群组 / 回复在频道」按钮询问', async () => {
    resetStore();
    seedForwardMessage();
    startReplyMode();
    const { edits } = trackBot();

    await locate();

    const groupBtn = findButton(edits, 'mreply_loc:group');
    const channelBtn = findButton(edits, 'mreply_loc:channel');
    assert.ok(groupBtn, '必须有「回复在群组」按钮');
    assert.ok(channelBtn, '必须有「回复在频道」按钮');
    assert.deepStrictEqual([groupBtn.text, channelBtn.text], ['👥 回复在群组', '📢 回复在频道']);

    const prompt = edits.find(e => e.text.includes('请选择回复位置'));
    assert.ok(prompt, '应提示"请选择回复位置"');

    const st = getRawUserState(USER);
    assert.strictEqual(st.step, 'waiting_reply_location');
    assert.ok(st.pendingMessageDoc, '应暂存待回复的 message');

    // 还没选位置就发媒体 → 只提示先点按钮，不静默回复
    await handleMessageReplyMode(sendMsg(501, {
        photo: [{ file_id: 'AgACX', file_unique_id: 'PX1' }]
    }), getRawUserState(USER));
    assert.ok(!store.get(COLLECTIONS.MEDIA).some(m => m.file_unique_id === 'PX1'), '未选位置前不应回复任何媒体');
});

test('默认回复位置是群组：解析 null 位置时取群组位置而不是频道', async () => {
    resetStore();
    seedForwardMessage();
    startReplyMode();
    const { edits } = trackBot();

    await locate();
    // 直接走"未指定位置"的解析（与按钮选择无关的默认值）
    const resolved = replyMode.resolveReplyLocation(store.get(COLLECTIONS.MESSAGE)[0], null);
    assert.strictEqual(resolved.chatId, GROUP_CHAT, '默认应回复在群组');
    assert.strictEqual(resolved.messageId, GROUP_MESSAGE_ID);

    // 用户点「回复在群组」后进入就绪，提示消息也发到群组
    await replyMode.handleLocationCallback(callbackQuery('mreply_loc:group'));
    const ready = getRawUserState(USER);
    assert.strictEqual(ready.step, 'ready');
    assert.strictEqual(ready.targetChatId, GROUP_CHAT);
    assert.strictEqual(ready.targetMessageId, GROUP_MESSAGE_ID);
    assert.ok(edits.some(e => e.text.includes('已选择回复在👥 群组')), '就绪提示应显示已选择群组');

    // 未选位置时（replyTarget 为空）也要按默认群组走
    resetStore();
    seedForwardMessage();
    startReplyMode('group');
    const t2 = trackBot();
    await locate();
    const st2 = getRawUserState(USER);
    assert.strictEqual(st2.step, 'ready', '显式指定 /message_reply_group 时不询问');
    assert.strictEqual(st2.targetChatId, GROUP_CHAT);
    assert.ok(t2.edits.some(e => e.text.includes('已选择回复在👥 群组')));
});

// ---------------- 一键切换按钮 ----------------

test('选定位置后：就绪消息带「🔄 更改为发送至…」一键切换按钮，点击即切换', async () => {
    resetStore();
    seedForwardMessage();
    startReplyMode();
    const { edits } = trackBot();

    await locate();
    await replyMode.handleLocationCallback(callbackQuery('mreply_loc:group'));

    // 当前在群组 → 按钮指向频道
    const toChannel = findButton(edits, 'mreply_switch:channel');
    assert.ok(toChannel, '群组就绪时应提供切换到频道的按钮');
    assert.ok(toChannel.text.includes('频道'), `按钮文案应指向频道，实际：${toChannel.text}`);

    // 点击切换 → 位置变成频道，并且按钮反过来指向群组
    const before = edits.length;
    await replyMode.handleSwitchLocationCallback(callbackQuery('mreply_switch:channel'));

    const st = getRawUserState(USER);
    assert.strictEqual(st.targetChatId, CHANNEL_CHAT, '应已切换到频道');
    assert.strictEqual(st.targetMessageId, CHANNEL_MESSAGE_ID);
    assert.ok(edits.slice(before).some(e => (e.text || '').includes('已选择回复在📢 频道')));
    assert.ok(findButton(edits.slice(before), 'mreply_switch:group'), '切换后按钮应反过来指向群组');
});

test('位置选择只在用户点过按钮后才生效：后续媒体沿用选择、可用切换按钮改回群组', async () => {
    resetStore();
    seedForwardMessage();
    startReplyMode();
    const { edits } = trackBot();

    // 未点按钮前：replyTarget 为空 → 必须询问（默认群组的按钮先给出）
    await locate();
    assert.ok(!getRawUserState(USER).replyTarget, '未点按钮前不应有位置偏好');
    assert.strictEqual(getRawUserState(USER).step, 'waiting_reply_location');

    // 用户点「回复在频道」→ 选择落在状态里
    await replyMode.handleLocationCallback(callbackQuery('mreply_loc:channel'));
    const stAfterPick = getRawUserState(USER);
    assert.strictEqual(stAfterPick.targetChatId, CHANNEL_CHAT);
    assert.strictEqual(stAfterPick.replyTarget, 'channel', '按钮选择应成为当前回复位置（后续媒体沿用）');
    assert.ok(findButton(edits, 'mreply_switch:group'), '应提供一键切换回群组的按钮');

    // 用切换按钮改回群组 → 后续媒体回到群组
    await replyMode.handleSwitchLocationCallback(callbackQuery('mreply_switch:group'));
    assert.strictEqual(getRawUserState(USER).targetChatId, GROUP_CHAT, '一键切换后回复群组');
    assert.ok(findButton(edits, 'mreply_switch:channel'), '切换后按钮反过来指向频道');
});

// ---------------- 单边位置 ----------------

test('只有频道位置（缺群组位置）时不弹空按钮，直接进入就绪', async () => {
    resetStore();
    store.set(COLLECTIONS.MESSAGE, [{
        _id: 's2', group_id: GROUP_ID, file_unique_id: FILE_ID, text: '转发描述',
        chat_id: CHANNEL_CHAT, message_id: CHANNEL_MESSAGE_ID, media_type: 'photo', tags: [],
        channel_forward: {
            is_channel: true,
            channel_chat_id: CHANNEL_CHAT,
            channel_message_id: CHANNEL_MESSAGE_ID,
            group_chat_id: null,
            group_message_id: null
        }
    }]);
    store.set(COLLECTIONS.MEDIA, [{
        _id: 'm2', group_id: GROUP_ID, subgroup: 1, file_unique_id: FILE_ID, media_type: 'photo',
        file_id: 'AgACRF1', group: null, channel: { chat_id: CHANNEL_CHAT, message_id: CHANNEL_MESSAGE_ID }
    }]);
    store.set(COLLECTIONS.GROUP_LIST, [{ _id: 'g2', group_id: GROUP_ID, is_group: 1, is_delete: 0, mark: 0 }]);
    startReplyMode();
    const { edits } = trackBot();
    // 回复媒体走 bot.sendPhoto，这里记录实际回复目标（用一条库里没有的新媒体）
    const NEW_FILE = 'RF_NEW';
    const replyCalls = [];
    bot.sendPhoto = async (chatId, fileId, opts) => {
        replyCalls.push({ chatId, opts });
        return { message_id: 9100, chat: { id: chatId }, photo: [{ file_id: fileId, file_unique_id: NEW_FILE }] };
    };

    // 已是回复模式就绪态时再发媒体 = 直接回复该位置（本条路径不涉及"询问/切换"）
    replyMode.clearUserContext(USER);
    setUserState(USER, {
        mode: 'message_reply', step: 'ready', replyTarget: null,
        targetGroupId: GROUP_ID, targetChatId: CHANNEL_CHAT, targetMessageId: CHANNEL_MESSAGE_ID,
        hintMsgInfo: null, replyLocations: replyMode.deriveReplyLocations(store.get(COLLECTIONS.MESSAGE)[0]),
        readyMsgId: null, packSize: null,
        _onExit: async () => { }, lastActivity: Date.now()
    });

    await handleMessageReplyMode(sendMsg(600, {
        photo: [{ file_id: 'AgACNEW', file_unique_id: NEW_FILE }]
    }), getRawUserState(USER));

    // 媒体已回复到这个唯一可用的位置（仅断言没有弹位置选择/切换按钮）
    assert.ok(replyCalls.some(c => c.chatId === CHANNEL_CHAT), '应回复到唯一可用的频道位置');
    assert.ok(replyCalls.every(c => c.opts.reply_to_message_id === CHANNEL_MESSAGE_ID), '应回复在该频道消息下');
    assert.ok(!findButton(edits, 'mreply_loc:channel'), '只有一边位置时不应弹位置选择按钮');
    assert.ok(!findButton(edits, 'mreply_switch:group'), '只有一边位置时不应给切换按钮');
});

test('非转发消息：直接用消息自身位置，不弹位置按钮', async () => {
    resetStore();
    store.set(COLLECTIONS.MESSAGE, [{
        _id: 's3', group_id: GROUP_ID, file_unique_id: FILE_ID, text: '普通描述',
        chat_id: GROUP_CHAT, message_id: 900, media_type: 'photo', tags: []
    }]);
    store.set(COLLECTIONS.MEDIA, [{
        _id: 'm3', group_id: GROUP_ID, subgroup: 1, file_unique_id: FILE_ID, media_type: 'photo',
        file_id: 'AgACRF1', group: { chat_id: GROUP_CHAT, message_id: 900 }, channel: null
    }]);
    store.set(COLLECTIONS.GROUP_LIST, [{ _id: 'g3', group_id: GROUP_ID, is_group: 1, is_delete: 0, mark: 0 }]);
    startReplyMode();
    const { edits } = trackBot();

    await locate();

    const st = getRawUserState(USER);
    assert.strictEqual(st.step, 'ready');
    assert.strictEqual(st.targetChatId, GROUP_CHAT, '非转发消息回复在消息自身位置');
    assert.ok(!findButton(edits, 'mreply_loc:group'), '非转发消息不弹位置选择按钮');
});

// ---------------- 真实数据形态：位置只存在 media 上 / 空描述媒体 ----------------

test('message 无 channel_forward：用 media 双位置照样弹「群组/频道」按钮', async () => {
    resetStore();
    // 真实库里大量媒体是这样：message 只有文本（没有 channel_forward），双位置只在 media 上
    store.set(COLLECTIONS.MESSAGE, [{
        _id: 's4', group_id: GROUP_ID, file_unique_id: FILE_ID, text: '频道转发的描述',
        chat_id: CHANNEL_CHAT, message_id: CHANNEL_MESSAGE_ID, media_type: 'photo', tags: []
    }]);
    store.set(COLLECTIONS.MEDIA, [{
        _id: 'm4', group_id: GROUP_ID, subgroup: 1, file_unique_id: FILE_ID, media_type: 'photo',
        file_id: 'AgACRF1',
        group: { chat_id: GROUP_CHAT, message_id: GROUP_MESSAGE_ID },
        channel: { chat_id: CHANNEL_CHAT, message_id: CHANNEL_MESSAGE_ID }
    }]);
    store.set(COLLECTIONS.GROUP_LIST, [{ _id: 'g4', group_id: GROUP_ID, is_group: 1, is_delete: 0, mark: 0 }]);
    startReplyMode();
    const { edits } = trackBot();

    await locate();

    assert.ok(findButton(edits, 'mreply_loc:group'), '只有 media 双位置时也要能选群组');
    assert.ok(findButton(edits, 'mreply_loc:channel'));
    assert.strictEqual(getRawUserState(USER).step, 'waiting_reply_location');

    // 选群组 → 回复到群组位置（media.group）
    await replyMode.handleLocationCallback(callbackQuery('mreply_loc:group'));
    const st = getRawUserState(USER);
    assert.strictEqual(st.targetChatId, GROUP_CHAT);
    assert.strictEqual(st.targetMessageId, GROUP_MESSAGE_ID);
});

test('空描述媒体（没有 message 记录）：也能定位并弹出「群组/频道」按钮', async () => {
    resetStore();
    // 真实库里"有位置的媒体"绝大多数没有 message 记录（空描述）
    store.set(COLLECTIONS.MESSAGE, []);
    store.set(COLLECTIONS.MEDIA, [{
        _id: 'm5', group_id: GROUP_ID, subgroup: 1, file_unique_id: FILE_ID, media_type: 'photo',
        file_id: 'AgACRF1',
        group: { chat_id: GROUP_CHAT, message_id: GROUP_MESSAGE_ID },
        channel: { chat_id: CHANNEL_CHAT, message_id: CHANNEL_MESSAGE_ID }
    }]);
    store.set(COLLECTIONS.GROUP_LIST, [{ _id: 'g5', group_id: GROUP_ID, is_group: 1, is_delete: 0, mark: 0 }]);
    startReplyMode();
    const { edits } = trackBot();

    await locate();

    assert.ok(findButton(edits, 'mreply_loc:group'), '空描述媒体也要能选群组');
    assert.ok(findButton(edits, 'mreply_loc:channel'));
    assert.strictEqual(getRawUserState(USER).step, 'waiting_reply_location');

    // 选群组并真正回复一条新媒体（回复目标 = media.group 的位置）
    const NEW_FILE = 'RF_NEW2';
    const replyCalls = [];
    bot.sendPhoto = async (chatId, fileId, opts) => {
        replyCalls.push({ chatId, opts });
        return { message_id: 9200, chat: { id: chatId }, photo: [{ file_id: fileId, file_unique_id: NEW_FILE }] };
    };
    await replyMode.handleLocationCallback(callbackQuery('mreply_loc:group'));
    await handleMessageReplyMode(sendMsg(700, {
        photo: [{ file_id: 'AgACNEW2', file_unique_id: NEW_FILE }]
    }), getRawUserState(USER));

    assert.deepStrictEqual(replyCalls.map(c => c.chatId), [GROUP_CHAT], '复盘：回复落到群组位置');
    assert.strictEqual(replyCalls[0].opts.reply_to_message_id, GROUP_MESSAGE_ID);
});

test('media 双位置指向同一聊天（数据异常）时不误判为频道转发', async () => {
    resetStore();
    store.set(COLLECTIONS.MESSAGE, [{
        _id: 's6', group_id: GROUP_ID, file_unique_id: FILE_ID, text: '群内媒体的描述',
        chat_id: GROUP_CHAT, message_id: 950, media_type: 'photo', tags: []
    }]);
    store.set(COLLECTIONS.MEDIA, [{
        _id: 'm6', group_id: GROUP_ID, subgroup: 1, file_unique_id: FILE_ID, media_type: 'photo',
        file_id: 'AgACRF1',
        group: { chat_id: GROUP_CHAT, message_id: 950 },
        channel: { chat_id: GROUP_CHAT, message_id: 950 }
    }]);
    store.set(COLLECTIONS.GROUP_LIST, [{ _id: 'g6', group_id: GROUP_ID, is_group: 1, is_delete: 0, mark: 0 }]);
    startReplyMode();
    const { edits } = trackBot();

    await locate();

    assert.strictEqual(getRawUserState(USER).step, 'ready', '同一个位置不算双位置，不该弹选择按钮');
    assert.strictEqual(getRawUserState(USER).targetChatId, GROUP_CHAT);
    assert.ok(!findButton(edits, 'mreply_loc:group'));
});
