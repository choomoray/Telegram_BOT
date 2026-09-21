// tests/sendFeedback.test.js
/**
 * /send 的「及时反馈」：
 *   bot 与云端数据库交互要时间（取频道/群组列表还要按 Telegram 真实类型逐个补正），
 *   这期间用户端必须**立刻**看到状态，而不是一片安静：
 *     - 进入 /send：先回「正在获取频道 / 群组 列表」，拿到后**就地刷新**它（不残留两条消息）；
 *     - 翻页 / 选择目标：先回执 + 把面板换成加载中，再刷新成结果；
 *     - 发送文本 / 单个媒体：先回「正在发送并收录中」，成功后就地刷新为结果。
 *
 * 断言口径：先有"处理中"提示，**再**才发生真正的工作（发到目标会话 / 查库），
 * 结果刷新的是同一条提示消息（edit），不是又发一条。
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

const chatKind = require('../utils/chatKind');
const sendMode = require('../handlers/modes/sendMode');
const handleSendCommand = require('../handlers/commands/send');
const { getRawUserState, setUserState, deleteUserState } = require('../states');
const { COLLECTIONS } = require('../db/getCollection');

const USER = 6161;
const TARGET_CHAT = -100777;

/** 记录 bot 的每一次调用（顺序敏感：要能断言"先提示、后干活"） */
function trackBot() {
    const sent = [];
    const edits = [];
    const answers = [];
    const events = [];
    let seq = 9000;
    bot.sendMessage = async (chatId, text, opts) => {
        const msg = { message_id: ++seq, chat: { id: chatId }, text };
        sent.push({ chatId, text, opts, message_id: msg.message_id });
        events.push({ kind: 'sendMessage', chatId, text });
        return msg;
    };
    bot.editMessageText = async (text, opts) => {
        edits.push({ text, opts });
        events.push({ kind: 'editMessageText', text, messageId: opts && opts.message_id });
        return true;
    };
    bot.answerCallbackQuery = async (id, extra) => { answers.push({ id, extra }); };
    bot.sendPhoto = async (chatId, fileId, opts) => {
        events.push({ kind: 'sendPhoto', chatId });
        return { message_id: ++seq, chat: { id: chatId }, photo: [{ file_id: fileId, file_unique_id: 'SENT-FU1' }] };
    };
    return { sent, edits, answers, events };
}

function seedChat(id, type, bindId = null, name = `Chat${id}`) {
    if (!store.has(COLLECTIONS.CHANNEL_GROUP)) store.set(COLLECTIONS.CHANNEL_GROUP, []);
    store.get(COLLECTIONS.CHANNEL_GROUP).push({ _id: `cg-${id}`, id, name, type, bind_id: bindId, is_bound: bindId !== null });
}

function readySendState() {
    setUserState(USER, {
        mode: 'send', step: 'ready',
        targetChatId: TARGET_CHAT, targetName: '群A', targetType: 'group',
        pendingMediaGroup: null, lastActivity: Date.now(), _onExit: async () => { }
    });
}

// ---------------- 进入 /send：先提示"正在获取列表"，再就地刷新 ----------------

test('/send：先回「正在获取频道/群组列表」，取到后就地刷新成选择面板（不残留两条消息）', async () => {
    resetStore();
    deleteUserState(USER);
    chatKind.clearChatKindCache();
    seedChat(TARGET_CHAT, 'group', null, '群A');
    const t = trackBot();

    await handleSendCommand(USER, { message_id: 700, chat: { id: USER, type: 'private' }, from: { id: USER } });

    const notice = t.sent.find(s => s.chatId === USER && /正在获取频道 \/ 群组 列表/.test(s.text));
    assert.ok(notice, '进入发送模式必须先给「正在获取列表」的即时反馈');
    assert.strictEqual(t.sent.filter(s => s.chatId === USER).length, 1, '只发一条消息（提示本身）');

    assert.strictEqual(t.edits.length, 1, '取到列表后应就地刷新那条提示');
    assert.strictEqual(t.edits[0].opts.message_id, notice.message_id, '刷新的是加载提示本身');
    assert.match(t.edits[0].text, /请选择要发送到的群组\/频道/);
    assert.ok(t.edits[0].opts.reply_markup.inline_keyboard.length >= 1, '面板要带目标按钮');
});

test('/send 取列表出错：加载提示要刷新成错误提示，不能一直停在"正在获取"', async () => {
    resetStore();
    deleteUserState(USER);
    chatKind.clearChatKindCache();
    const { stubModule } = require('./helpers/memoryDb');
    const chatKindPath = require.resolve('../utils/chatKind');
    const savedChatKind = require.cache[chatKindPath];
    const t = trackBot();
    // 列表取不出来（取会话真实类型时打 Telegram 失败等）：把补正函数换成抛错版
    stubModule(chatKindPath, {
        ...require('../utils/chatKind'),
        withRealTypes: async () => { throw new Error('boom'); }
    });

    try {
        await handleSendCommand(USER, { message_id: 701, chat: { id: USER, type: 'private' }, from: { id: USER } });
    } finally {
        if (savedChatKind) require.cache[chatKindPath] = savedChatKind;
        else delete require.cache[chatKindPath];
    }

    const last = t.edits[t.edits.length - 1];
    assert.ok(last, '加载提示必须被刷新（不能停在"正在获取…"）');
    assert.match(last.text, /获取频道 \/ 群组列表失败/, '失败要有明确结果');
});

// ---------------- 翻页 / 选择目标 ----------------

test('/send 翻页：先回执 + 面板换成加载中，再刷新成新一页列表', async () => {
    resetStore();
    deleteUserState(USER);
    chatKind.clearChatKindCache();
    seedChat(TARGET_CHAT, 'group', null, '群A');
    const t = trackBot();

    await sendMode.handleCallback({
        id: 'q-page', data: 'sendpage:1', from: { id: USER },
        message: { chat: { id: USER }, message_id: 902 }
    });

    assert.match(t.answers[0].extra.text, /正在获取列表/, '点翻页要先给回执（按钮转圈立刻停）');
    assert.strictEqual(t.edits[0].opts.message_id, 902);
    assert.match(t.edits[0].text, /正在获取频道 \/ 群组 列表/, '面板先换成加载中');
    assert.match(t.edits[t.edits.length - 1].text, /请选择要发送到的群组\/频道/, '随后刷新成列表');
});

test('/send 选择目标：先回执 + 面板换成「正在切换目标」，再刷新成「已选择」', async () => {
    resetStore();
    deleteUserState(USER);
    chatKind.clearChatKindCache();
    seedChat(TARGET_CHAT, 'group', null, '群A');
    const t = trackBot();

    await sendMode.handleCallback({
        id: 'q-pick', data: `sendg:${TARGET_CHAT}`, from: { id: USER },
        message: { chat: { id: USER }, message_id: 903 }
    });

    assert.strictEqual(t.answers.length, 1, '回执只能答一次（答两次第二个必然报 query 失效）');
    assert.match(t.answers[0].extra.text, /正在切换目标/);
    assert.match(t.edits[0].text, /正在切换目标/, '面板先给加载态');
    assert.match(t.edits[t.edits.length - 1].text, /已选择：👥 群A/, '随后刷新成结果');

    const st = getRawUserState(USER);
    assert.strictEqual(st.mode, 'send');
    assert.strictEqual(st.step, 'ready');
    assert.strictEqual(st.targetChatId, TARGET_CHAT);
});

// ---------------- 发送 / 收录 ----------------

test('/send 发送文本：先回「正在发送并收录中」，成功后就地刷新为结果', async () => {
    resetStore();
    chatKind.clearChatKindCache();
    const t = trackBot();
    readySendState();

    await sendMode.handleSendMode({
        from: { id: USER }, chat: { id: USER, type: 'private' },
        message_id: 801, text: '一段文本'
    }, getRawUserState(USER));

    const notice = t.sent.find(s => s.chatId === USER && /正在发送并收录中/.test(s.text));
    assert.ok(notice, '发送前必须先给「正在发送并收录中」的反馈');

    const sentIndex = t.events.findIndex(e => e.kind === 'sendMessage' && e.chatId === TARGET_CHAT);
    const noticeIndex = t.events.findIndex(e => e.kind === 'sendMessage' && e.chatId === USER && /正在发送并收录中/.test(e.text));
    assert.ok(noticeIndex >= 0 && noticeIndex < sentIndex, '提示必须先于"发到目标会话"出现');

    const done = t.edits.find(e => /已发送到 群A/.test(e.text));
    assert.ok(done, '结果要刷新出来');
    assert.strictEqual(done.opts.message_id, notice.message_id, '刷新的是那条提示，不新发一条');
});

test('/send 发送单个媒体：先回「正在发送并收录中」（去重查询之前），成功后就地刷新', async () => {
    resetStore();
    chatKind.clearChatKindCache();
    const t = trackBot();
    readySendState();

    await sendMode.handleSendMode({
        from: { id: USER }, chat: { id: USER, type: 'private' },
        message_id: 810, photo: [{ file_id: 'AgAC1', file_unique_id: 'FU1' }]
    }, getRawUserState(USER));

    const notice = t.sent.find(s => s.chatId === USER && /正在发送并收录中/.test(s.text));
    assert.ok(notice, '发媒体同样要先给反馈');

    const photoIndex = t.events.findIndex(e => e.kind === 'sendPhoto');
    const noticeIndex = t.events.findIndex(e => e.kind === 'sendMessage' && /正在发送并收录中/.test(e.text));
    assert.ok(noticeIndex >= 0 && noticeIndex < photoIndex, '提示必须先于实际发送（含去重查询）');

    const done = t.edits.find(e => /已发送到 群A/.test(e.text));
    assert.ok(done);
    assert.strictEqual(done.opts.message_id, notice.message_id);
});

test('/send 重复媒体：即时反馈要刷新成"已存在"，不留一条假的"正在发送"', async () => {
    resetStore();
    chatKind.clearChatKindCache();
    const t = trackBot();
    readySendState();
    // 该媒体已在库里（media 唯一索引）
    store.set(COLLECTIONS.MEDIA, [{
        _id: 'm-dup', group_id: `${TARGET_CHAT}_1`, subgroup: 1,
        file_unique_id: 'FU-DUP', media_type: 'photo', file_id: 'AgACDup', group: { chat_id: TARGET_CHAT, message_id: 1 }
    }]);

    await sendMode.handleSendMode({
        from: { id: USER }, chat: { id: USER, type: 'private' },
        message_id: 820, photo: [{ file_id: 'AgACDup', file_unique_id: 'FU-DUP' }]
    }, getRawUserState(USER));

    const notice = t.sent.find(s => s.chatId === USER && /正在发送并收录中/.test(s.text));
    assert.ok(notice, '先给反馈');
    const done = t.edits.find(e => /该媒体已存在/.test(e.text));
    assert.ok(done, '结果要覆盖掉"正在发送"');
    assert.strictEqual(done.opts.message_id, notice.message_id);
    assert.ok(!t.events.some(e => e.kind === 'sendPhoto'), '已存在的媒体不该真的发出去');
});
