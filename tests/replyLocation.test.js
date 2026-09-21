// tests/replyLocation.test.js
/**
 * 消息回复模式的"回复位置"语义：
 *   - **默认回复在群组**，不再先弹「👥 回复在群组 / 📢 回复在频道」让用户点一下
 *     （多一步操作，而且用户在选之前发媒体会被拦下）；
 *   - 群组/频道双位置都在（频道转发消息）时，就绪消息下带
 *     「🔄 更改为发送至📢 频道」按钮，随时一键切换；
 *   - 只有单边位置（缺群组位置等）时按可用位置直接进入就绪，不弹空按钮；
 *   - 老消息上遗留的「回复在群组/频道」按钮仍可用（兼容：就绪态下等价于切换位置）。
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
const chatKind = require('../utils/chatKind');
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

// ---------------- 默认回复位置：群组（+ 一键切到频道） ----------------

test('/message_reply 定位到频道转发消息：默认回复在群组，就绪消息上带「切换到频道」按钮', async () => {
    resetStore();
    seedForwardMessage();
    startReplyMode();
    const { sent, edits } = trackBot();

    await locate();

    // 不再弹「请选择回复位置」：直接按默认位置（群组）进入就绪，
    // 双位置都在时给一个「🔄 更改为发送至📢 频道」按钮即可
    assert.ok(!findButton(edits, 'mreply_loc:group'), '不再弹位置选择按钮');
    assert.ok(!findButton(edits, 'mreply_loc:channel'), '不再弹位置选择按钮');

    const st = getRawUserState(USER);
    assert.strictEqual(st.step, 'ready', '定位后直接就绪（不必先点按钮）');
    assert.strictEqual(st.targetChatId, GROUP_CHAT, '默认回复在群组');
    assert.strictEqual(st.targetMessageId, GROUP_MESSAGE_ID);
    assert.ok(edits.some(e => (e.text || '').includes('已选择回复在👥 群组')),
        `就绪文案应显示群组，实际：${edits.map(e => e.text).join(' | ')}`);
    assert.ok(sent.some(s => s.chatId === GROUP_CHAT && s.text.includes('正在回复该消息')), '提示消息发在群里');

    const toChannel = findButton(edits, 'mreply_switch:channel');
    assert.ok(toChannel, '双位置都在时应提供一键切换到频道的按钮');
    assert.ok(toChannel.text.includes('频道'), `按钮文案应指向频道，实际：${toChannel.text}`);
    assert.ok(!findButton(edits, 'mreply_switch:group'), '当前就在群组，不该再给"切回群组"的按钮');

    // 默认位置立即可用：不必先点任何按钮，直接发媒体就回复到群组
    const NEW_FILE = 'RF_DEFAULT';
    const replyCalls = [];
    bot.sendPhoto = async (chatId, fileId, opts) => {
        replyCalls.push({ chatId, opts });
        return { message_id: 9500, chat: { id: chatId }, photo: [{ file_id: fileId, file_unique_id: NEW_FILE }] };
    };
    replyMode.clearUserContext(USER);
    await handleMessageReplyMode(sendMsg(520, {
        photo: [{ file_id: 'AgACDEF', file_unique_id: NEW_FILE }]
    }), getRawUserState(USER));
    assert.deepStrictEqual(replyCalls.map(c => c.chatId), [GROUP_CHAT], '未点任何按钮也应回复到默认的群组位置');
    assert.strictEqual(replyCalls[0].opts.reply_to_message_id, GROUP_MESSAGE_ID);
});

test('默认回复位置是群组：解析 null 位置时取群组位置而不是频道', async () => {
    resetStore();
    seedForwardMessage();
    startReplyMode();
    trackBot();

    await locate();
    // 直接走"未指定位置"的解析（与按钮选择无关的默认值）
    const resolved = replyMode.resolveReplyLocation(store.get(COLLECTIONS.MESSAGE)[0], null);
    assert.strictEqual(resolved.chatId, GROUP_CHAT, '默认应回复在群组');
    assert.strictEqual(resolved.messageId, GROUP_MESSAGE_ID);

    // 显式指定 /message_reply_group：不弹按钮、直接群组
    resetStore();
    seedForwardMessage();
    startReplyMode('group');
    const t2 = trackBot();
    await locate();
    const st2 = getRawUserState(USER);
    assert.strictEqual(st2.step, 'ready');
    assert.strictEqual(st2.targetChatId, GROUP_CHAT);
    assert.ok(t2.edits.some(e => e.text.includes('已选择回复在👥 群组')));

    // 显式指定 /message_reply_channel：直接频道，并给"切回群组"的按钮
    resetStore();
    seedForwardMessage();
    startReplyMode('channel');
    const t3 = trackBot();
    await locate();
    const st3 = getRawUserState(USER);
    assert.strictEqual(st3.step, 'ready');
    assert.strictEqual(st3.targetChatId, CHANNEL_CHAT);
    assert.ok(t3.edits.some(e => e.text.includes('已选择回复在📢 频道')));
    assert.ok(findButton(t3.edits, 'mreply_switch:group'), '频道就绪时应提供切回群组的按钮');
});

// ---------------- 一键切换按钮 ----------------

test('就绪后点「更改为发送至…」：位置随之改变，后续媒体沿用新位置', async () => {
    resetStore();
    seedForwardMessage();
    startReplyMode();
    const { edits } = trackBot();

    await locate();

    // 当前在群组 → 按钮指向频道
    const before = edits.length;
    await replyMode.handleSwitchLocationCallback(callbackQuery('mreply_switch:channel'));

    const st = getRawUserState(USER);
    assert.strictEqual(st.step, 'ready');
    assert.strictEqual(st.targetChatId, CHANNEL_CHAT, '应已切换到频道');
    assert.strictEqual(st.targetMessageId, CHANNEL_MESSAGE_ID);
    assert.strictEqual(st.replyTarget, 'channel', '切换结果要落进状态，后续媒体沿用');
    assert.ok(edits.slice(before).some(e => (e.text || '').includes('已选择回复在📢 频道')));
    assert.ok(findButton(edits.slice(before), 'mreply_switch:group'), '切换后按钮应反过来指向群组');

    // 后续媒体真的回复到频道（沿用切换后的位置）
    const NEW_FILE = 'RF_SWITCH';
    const replyCalls = [];
    bot.sendPhoto = async (chatId, fileId, opts) => {
        replyCalls.push({ chatId, opts });
        return { message_id: 9600, chat: { id: chatId }, photo: [{ file_id: fileId, file_unique_id: NEW_FILE }] };
    };
    replyMode.clearUserContext(USER);
    await handleMessageReplyMode(sendMsg(530, {
        photo: [{ file_id: 'AgACSW', file_unique_id: NEW_FILE }]
    }), getRawUserState(USER));
    assert.deepStrictEqual(replyCalls.map(c => c.chatId), [CHANNEL_CHAT], '切换后应回复到频道位置');
    assert.strictEqual(replyCalls[0].opts.reply_to_message_id, CHANNEL_MESSAGE_ID);

    // 再切回群组 → 后续媒体回到群组
    await replyMode.handleSwitchLocationCallback(callbackQuery('mreply_switch:group'));
    assert.strictEqual(getRawUserState(USER).targetChatId, GROUP_CHAT, '一键切换后回复群组');
    assert.ok(findButton(edits, 'mreply_switch:channel'), '切换后按钮反过来指向频道');
});

test('老消息上的「回复在群组/频道」按钮仍可用（向后兼容）', async () => {
    resetStore();
    seedForwardMessage();
    trackBot();

    // 老流程留下的状态（新版定位后不再产生 waiting_reply_location）
    setUserState(USER, {
        mode: 'message_reply', step: 'waiting_reply_location',
        targetGroupId: GROUP_ID,
        pendingMessageDoc: store.get(COLLECTIONS.MESSAGE)[0],
        pendingMediaDoc: store.get(COLLECTIONS.MEDIA)[0],
        processingMsgId: 4000, packSize: null,
        _onExit: async () => { }, lastActivity: Date.now()
    });
    await replyMode.handleLocationCallback(callbackQuery('mreply_loc:channel'));
    const st = getRawUserState(USER);
    assert.strictEqual(st.step, 'ready');
    assert.strictEqual(st.targetChatId, CHANNEL_CHAT);

    // 就绪态下再点老按钮 = 切换位置（等价于新的切换按钮）
    await replyMode.handleLocationCallback(callbackQuery('mreply_loc:group'));
    assert.strictEqual(getRawUserState(USER).targetChatId, GROUP_CHAT);
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

test('message 无 channel_forward：用 media 双位置照样默认群组 + 给切换按钮', async () => {
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

    const st = getRawUserState(USER);
    assert.strictEqual(st.step, 'ready', '只有 media 双位置时也直接就绪');
    assert.strictEqual(st.targetChatId, GROUP_CHAT, '默认群组位置（media.group）');
    assert.strictEqual(st.targetMessageId, GROUP_MESSAGE_ID);
    assert.ok(findButton(edits, 'mreply_switch:channel'), '双位置都在 → 应给"切换到频道"的按钮');
});

test('空描述媒体（没有 message 记录）：也能定位，默认回复在群组', async () => {
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

    const st = getRawUserState(USER);
    assert.strictEqual(st.step, 'ready');
    assert.strictEqual(st.targetChatId, GROUP_CHAT, '空描述媒体默认也回复在群组位置');
    assert.ok(findButton(edits, 'mreply_switch:channel'), '空描述媒体同样给切换按钮');

    // 直接回复一条新媒体：回复目标 = media.group 的位置
    const NEW_FILE = 'RF_NEW2';
    const replyCalls = [];
    bot.sendPhoto = async (chatId, fileId, opts) => {
        replyCalls.push({ chatId, opts });
        return { message_id: 9200, chat: { id: chatId }, photo: [{ file_id: fileId, file_unique_id: NEW_FILE }] };
    };
    replyMode.clearUserContext(USER);
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

// ---------------- 位置名骗人：只发在群组里、却被记成频道位置（用户反馈） ----------------

test('只发在群组里的媒体（位置被错记成 channel）→ 文案按实际会话显示「👥 群组」', async () => {
    resetStore();
    chatKind.clearChatKindCache();
    // 历史脏数据：讨论群在 channel_group 里被登记成 channel，于是回复它时
    // buildMediaLocation 把"只发在群组里"的媒体写成了 channel 位置
    store.set(COLLECTIONS.CHANNEL_GROUP, [
        { _id: 'cg1', id: GROUP_CHAT, name: '讨论群', type: 'channel', bind_id: null, is_bound: false }
    ]);
    store.set(COLLECTIONS.MESSAGE, [{
        _id: 's7', group_id: GROUP_ID, file_unique_id: FILE_ID, text: '群里的描述',
        chat_id: GROUP_CHAT, message_id: 960, media_type: 'document', tags: []
    }]);
    store.set(COLLECTIONS.MEDIA, [{
        _id: 'm7', group_id: GROUP_ID, subgroup: 1, file_unique_id: FILE_ID, media_type: 'document',
        file_id: 'AgACRF1',
        group: null,
        channel: { chat_id: GROUP_CHAT, message_id: 960 }   // ← 位置名是 channel，实际是群
    }]);
    store.set(COLLECTIONS.GROUP_LIST, [{ _id: 'g7', group_id: GROUP_ID, is_group: 1, is_delete: 0, mark: 0 }]);

    // Telegram 真实类型：这是个超级群组（不是频道）
    bot.getChat = async (chatId) => ({ id: Number(chatId), type: 'supergroup' });

    startReplyMode();
    const { sent, edits } = trackBot();

    await locate();

    const st = getRawUserState(USER);
    assert.strictEqual(st.step, 'ready');
    assert.strictEqual(st.targetChatId, GROUP_CHAT, '回复位置本来就是群（只是位置名写错了）');
    assert.ok(edits.some(e => (e.text || '').includes('已选择回复在👥 群组')),
        `文案必须显示群组，实际编辑内容：${edits.map(e => e.text).join(' | ')}`);
    assert.ok(!edits.some(e => (e.text || '').includes('已选择回复在📢 频道')), '不能再说"回复在频道"');
    assert.ok(sent.some(s => s.chatId === GROUP_CHAT && s.text.includes('正在回复该消息')), '提示消息发在群里');

    delete bot.getChat;
    chatKind.clearChatKindCache();
    resetStore();
});
