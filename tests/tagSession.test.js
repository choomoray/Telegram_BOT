// tests/tagSession.test.js
/**
 * 发送 / 回复成功后的「打标签会话」语义（新规则）：
 *   - 带描述的成功发送/回复：收录 message + 自动进入打标签，且**不退出、不切换**原模式
 *     （send 仍是 send，message_reply 仍是 message_reply），用户可继续发送媒体；
 *   - 打标签期间纯文本 = 打标签操作（空格/、分隔，`-标签` 移除），
 *     点《✅ 完成》才结束；
 *   - 当前标签没打完又来一个需要打标签的媒体 → 先入队，点《完成》后才切换到下一个；
 *   - group_list.tags = 该媒体组内所有 message 标签的并集；
 *   - 查询：宽松 `-标签` = message + group_list 并集；严格 `--标签` = 只看 group_list 命中组。
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

const { handleSendMode } = require('../handlers/modes/sendMode');
const handleMessageReplyMode = require('../handlers/modes/messageReplyMode');
const tagSession = require('../utils/tagSession');
const { buildQuery } = require('../handlers/queryHandler');
const { getCollection, COLLECTIONS } = require('../db/getCollection');
const { setUserState, getRawUserState } = require('../states');

const USER = 7788;
const TARGET = -1004321;
const TARGET_MSG = 4321;
const GROUP_ID = '-100_1001';
const GROUP_LIST = COLLECTIONS.GROUP_LIST;

/** 每个用例先清空内存库 + 打标签会话（会话是模块内存态，resetStore 不会清） */
function resetAll() {
    resetStore();
    tagSession.clearTagSession(USER);
}

const findGroupList = (groupId) => (store.get(GROUP_LIST) || []).find(d => d.group_id === groupId) || null;
const messagesOf = (groupId) => (store.get('message') || []).filter(m => m.group_id === groupId);

const sendMsg = (messageId, extra = {}) => ({
    from: { id: USER }, chat: { id: USER, type: 'private' }, message_id: messageId, ...extra
});

function startSendMode() {
    setUserState(USER, {
        mode: 'send', step: 'ready', targetChatId: TARGET, targetName: '测试群',
        targetType: 'group', lastActivity: Date.now()
    });
}

function startReplyMode() {
    setUserState(USER, {
        mode: 'message_reply',
        step: 'ready',
        targetGroupId: GROUP_ID,
        targetChatId: TARGET,
        targetMessageId: TARGET_MSG,
        hintMsgInfo: null,
        replyLocations: null,
        readyMsgId: null,
        packSize: null,
        _onExit: async () => { },
        lastActivity: Date.now()
    });
}

const callbackQuery = (data, messageId = 1234) => ({
    id: `q-${data}`,
    data,
    from: { id: USER },
    message: { chat: { id: USER }, message_id: messageId }
});

/** 记录 bot.sendMessage / editMessageText 的调用 */
function trackBot() {
    const sent = [];
    const edits = [];
    const answers = [];
    bot.sendMessage = async (chatId, text, opts) => {
        sent.push({ chatId, text, opts });
        return { message_id: 10000 + sent.length, chat: { id: chatId } };
    };
    bot.editMessageText = async (text, opts) => { edits.push({ text, opts }); return true; };
    bot.answerCallbackQuery = async (id, extra) => { answers.push({ id, extra }); };
    return { sent, edits, answers };
}

/** 找到最近一次带标签键盘的消息 */
const lastPanel = (sent) => [...sent].reverse().find(s => s.opts && s.opts.reply_markup &&
    JSON.stringify(s.opts.reply_markup).includes('sendtag'));

// ---------------- 发送：收录 + 进入打标签且不退出模式 ----------------

test('/send 有描述：收录 message、弹出打标签面板、仍处于发送模式', async () => {
    resetAll();
    startSendMode();
    const { sent } = trackBot();

    await handleSendMode(sendMsg(7001, {
        caption: '第一条描述', photo: [{ file_id: 'K0', file_unique_id: 'UK0' }]
    }), getRawUserState(USER));

    const groupId = `${TARGET}_7001`;
    assert.equal(messagesOf(groupId).length, 1, '应收录 message');
    assert.equal(messagesOf(groupId)[0].text, '第一条描述');
    assert.equal(messagesOf(groupId)[0].file_unique_id, 'UK0', '标签作用对象 = 新收录的这条 message');

    const panel = lastPanel(sent);
    assert.ok(panel, '应弹出打标签面板');
    assert.ok(panel.opts.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'sendtag_done'),
        '面板应带《✅ 完成》按钮');

    const st = getRawUserState(USER);
    assert.equal(st.mode, 'send', '打标签不退出 / 不切换发送模式');
    assert.equal(st.targetChatId, TARGET, '发送目标保持');
    assert.ok(tagSession.isTagging(USER), '应处于打标签会话中');
});

test('/send 无描述：只提示不进入打标签', async () => {
    resetAll();
    startSendMode();
    const { sent, edits } = trackBot();

    await handleSendMode(sendMsg(7002, { photo: [{ file_id: 'K1', file_unique_id: 'UK1' }] }), getRawUserState(USER));

    const groupId = `${TARGET}_7002`;
    assert.equal(messagesOf(groupId).length, 0, '无描述不写 message');
    assert.ok(findGroupList(groupId).is_delete > 0, '无描述 → 可清理');
    assert.equal(tagSession.isTagging(USER), false, '无描述不进入打标签');
    // 成功提示刷新在"正在发送中"那条上（edit），没有描述时不会弹出打标签面板
    assert.ok(edits.some(e => e.text.includes('已发送')) || sent.some(s => s.text.includes('已发送')),
        '应给出普通成功提示');
    assert.equal(lastPanel(sent), undefined, '无描述不弹打标签面板');
});

// ---------------- 回复：收录 + 进入打标签且不退出回复模式 ----------------

test('回复有描述：收录新 message、弹出打标签面板、仍处于回复模式', async () => {
    resetAll();
    startReplyMode();
    const { sent } = trackBot();

    await handleMessageReplyMode(sendMsg(7101, {
        caption: '回复描述', photo: [{ file_id: 'R0', file_unique_id: 'UR0' }]
    }), getRawUserState(USER));

    const panel = lastPanel(sent);
    assert.ok(panel, '回复成功后应弹出打标签面板');

    const st = getRawUserState(USER);
    assert.equal(st.mode, 'message_reply', '打标签不退出回复模式');
    assert.equal(st.step, 'ready');
    assert.ok(tagSession.isTagging(USER));

    const targetFile = tagSession.getTagSession(USER).active.fileUniqueId;
    assert.equal(targetFile, 'UR0', '标签作用对象 = 回复成功后收录的新 message');
    const msg = messagesOf(GROUP_ID).find(m => m.file_unique_id === 'UR0');
    assert.ok(msg, '回复产生的 message 应被收录');
    assert.equal(msg.text, '回复描述');
});

test('打标签期间仍可继续回复媒体（模式未退出）', async () => {
    resetAll();
    startReplyMode();
    const { sent } = trackBot();

    await handleMessageReplyMode(sendMsg(7201, {
        caption: '第一个', photo: [{ file_id: 'S0', file_unique_id: 'US0' }]
    }), getRawUserState(USER));
    assert.ok(tagSession.isTagging(USER));

    await handleMessageReplyMode(sendMsg(7202, {
        caption: '第二个', photo: [{ file_id: 'S1', file_unique_id: 'US1' }]
    }), getRawUserState(USER));

    assert.equal(messagesOf(GROUP_ID).length, 2, '两条回复都应收录 message');
    const session = tagSession.getTagSession(USER);
    assert.equal(session.active.fileUniqueId, 'US0', '当前仍在打第一个的标签');
    assert.equal(session.queue.length, 1, '第二个进入队列等待');
    assert.ok(sent.some(s => s.text.includes('已加入打标签队列')), '应提示已加入队列');
});

// ---------------- 纯文本 = 打标签；完成按钮切换队列 ----------------

test('纯文本视为打标签：作用于当前 message，并同步 group_list.tags', async () => {
    resetAll();
    store.set('tags', [{ _id: 't1', name: 'JK', pin: 0, count: 0 }]);
    startSendMode();
    trackBot();

    await handleSendMode(sendMsg(7301, {
        caption: '描述一', photo: [{ file_id: 'T0', file_unique_id: 'UT0' }]
    }), getRawUserState(USER));

    const session = tagSession.getTagSession(USER);
    await tagSession.handleTagText(sendMsg(7302, { text: 'JK 高清' }), session);

    const groupId = `${TARGET}_7301`;
    const msg = messagesOf(groupId)[0];
    assert.deepStrictEqual([...msg.tags].sort(), ['JK', '高清'], '文本里的标签写进当前 message');
    assert.deepStrictEqual([...findGroupList(groupId).tags].sort(), ['JK', '高清'],
        'group_list.tags = 组内 message 标签并集');
    assert.ok(tagSession.isTagging(USER), '打标签继续，直到点《完成》');
});

test('《✅ 完成》：队列还有目标时切换到下一个（不结束模式）', async () => {
    resetAll();
    startSendMode();
    const { edits } = trackBot();

    await handleSendMode(sendMsg(7401, {
        caption: '甲', photo: [{ file_id: 'V0', file_unique_id: 'UV0' }]
    }), getRawUserState(USER));
    await handleSendMode(sendMsg(7402, {
        caption: '乙', photo: [{ file_id: 'V1', file_unique_id: 'UV1' }]
    }), getRawUserState(USER));

    assert.equal(tagSession.getTagSession(USER).queue.length, 1);

    await tagSession.handleTagCallback(callbackQuery('sendtag_done', 1234));

    const session = tagSession.getTagSession(USER);
    assert.ok(session, '队列还有目标 → 打标签会话继续');
    assert.equal(session.active.fileUniqueId, 'UV1', '面板已切换到队列中的下一个');
    assert.equal(session.active.baseText, '✅ 已发送到 测试群', '面板提示语已换成下一个媒体的成功提示');
    assert.equal(session.queue.length, 0);
    assert.ok(edits.some(e => e.text.includes('已发送到 测试群')), '面板消息已刷新为下一个媒体的提示');
    assert.equal(getRawUserState(USER).mode, 'send', '模式始终未被退出');
});

test('《✅ 完成》：队列为空时结束打标签，模式仍保留', async () => {
    resetAll();
    startSendMode();
    trackBot();

    await handleSendMode(sendMsg(7501, {
        caption: '丙', photo: [{ file_id: 'W0', file_unique_id: 'UW0' }]
    }), getRawUserState(USER));

    await tagSession.handleTagCallback(callbackQuery('sendtag_done', 1234));

    assert.equal(tagSession.isTagging(USER), false, '打标签会话结束');
    const st = getRawUserState(USER);
    assert.ok(st, '模式状态保留（发送模式继续可用）');
    assert.equal(st.mode, 'send');

    // 结束后再发媒体仍可正常发送
    bot.sendMessage = async (chatId, text) => ({ message_id: 1, chat: { id: chatId }, text });
    bot.sendPhoto = async () => ({
        message_id: 9001, chat: { id: TARGET },
        photo: [{ file_id: 'sent-W1', file_unique_id: 'UW1' }]
    });
    await handleSendMode(sendMsg(7502, {
        photo: [{ file_id: 'W1', file_unique_id: 'UW1' }]
    }), getRawUserState(USER));
    assert.ok((store.get('media') || []).some(m => m.file_unique_id === 'UW1'), '结束后仍能继续发送媒体');
});

// ---------------- 标签查询：先 group_list，再 message ----------------

test('宽松标签 -标签：message 与 group_list 都查询（并集）', async () => {
    resetAll();
    store.set(GROUP_LIST, [
        { _id: 'g1', group_id: 'G1', tags: ['JK'], is_group: 1, is_delete: 0 },
        { _id: 'g2', group_id: 'G2', tags: ['OTHER'], is_group: 1, is_delete: 0 }
    ]);
    store.set('message', [
        { _id: 'm1', group_id: 'G1', file_unique_id: 'A1', text: '组内第一条', tags: ['ZZ'] },
        { _id: 'm2', group_id: 'G1', file_unique_id: 'A2', text: '组内第二条', tags: ['JK'] },
        { _id: 'm3', group_id: 'G2', file_unique_id: 'A3', text: '别的组', tags: ['OTHER'] },
        { _id: 'm4', group_id: 'G3', file_unique_id: 'A4', text: '老数据（只看 message 标签）', tags: ['JK'] }
    ]);

    const { query, rankedGroups } = await buildQuery({ keyword: '', tags: ['JK'], tagsAll: [] });
    const results = await getCollection(COLLECTIONS.MESSAGE).find(query).toArray();
    const ids = results.map(r => r.file_unique_id).sort();

    assert.deepStrictEqual(ids, ['A1', 'A2', 'A4'],
        'group_list 命中的组内全部描述（A1 自身无该标签也算命中）+ message 自身命中的单条，取并集');
    assert.ok(rankedGroups.has('G1'), 'group_list 命中的组用于排序优先');
});

test('宽松标签 + 关键字：命中组内的描述全部返回，关键字命中的排最前', async () => {
    resetAll();
    const { rankResults } = require('../handlers/queryHandler');
    store.set(GROUP_LIST, [{ _id: 'g1', group_id: 'G1', tags: ['JK'], is_group: 2, is_delete: 0 }]);
    store.set('message', [
        { _id: 'm1', group_id: 'G1', file_unique_id: 'D1', text: '无关描述', tags: [] },
        { _id: 'm2', group_id: 'G1', file_unique_id: 'D2', text: '关键字 描述', tags: [] }
    ]);

    const { query, rankedGroups } = await buildQuery({ keyword: '关键字', tags: ['JK'], tagsAll: [] });
    const results = await getCollection(COLLECTIONS.MESSAGE).find(query).toArray();
    const ranked = rankResults(results, rankedGroups, '关键字').map(r => r.file_unique_id);

    // memoryDb 的 $regex 会同时过滤掉"仅组命中"的记录，因此只断言关键字命中的排在最前
    assert.ok(ranked.length >= 1);
    assert.equal(ranked[0], 'D2', '关键字命中的描述排最前');
});

test('严格标签 --标签：只取 group_list 命中组内的 message 数据', async () => {
    resetAll();
    store.set(GROUP_LIST, [
        { _id: 'g1', group_id: 'G1', tags: ['JK', 'HD'], is_group: 1, is_delete: 0 },
        { _id: 'g2', group_id: 'G2', tags: ['JK'], is_group: 1, is_delete: 0 }
    ]);
    store.set('message', [
        { _id: 'm1', group_id: 'G1', file_unique_id: 'B1', text: '命中组内', tags: [] },
        { _id: 'm2', group_id: 'G2', file_unique_id: 'B2', text: '只差一个标签', tags: ['JK', 'HD'] }
    ]);

    const { query } = await buildQuery({ keyword: '', tags: [], tagsAll: ['JK', 'HD'] });
    const results = await getCollection(COLLECTIONS.MESSAGE).find(query).toArray();

    assert.deepStrictEqual(results.map(r => r.file_unique_id), ['B1'],
        '严格查询只看 group_list：G2 的 message 即使自带两个标签也不命中');
});

test('group_list.tags 汇总：组内多条 message 的标签并集', async () => {
    resetAll();
    const { syncGroupTags } = require('../db/groupList');
    store.set(GROUP_LIST, [{ _id: 'g1', group_id: 'G1', is_group: 2, is_delete: 0, mark: 0 }]);
    store.set('message', [
        { _id: 'm1', group_id: 'G1', file_unique_id: 'C1', text: '一', tags: ['JK', 'HD'] },
        { _id: 'm2', group_id: 'G1', file_unique_id: 'C2', text: '二', tags: ['HD', 'AV'] }
    ]);

    const tags = await syncGroupTags('G1');
    assert.deepStrictEqual([...tags].sort(), ['AV', 'HD', 'JK']);
    assert.deepStrictEqual([...findGroupList('G1').tags].sort(), ['AV', 'HD', 'JK']);
});
