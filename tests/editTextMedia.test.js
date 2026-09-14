// tests/editTextMedia.test.js
/**
 * 机器人发出的「文本消息」也能修改（此前只能编辑媒体的 caption）
 *
 * 文本消息 = `media_type='text'`（/send、/reply 发出的纯文本，正文存在 media.media_name，
 * 见 media.recordTextMedia），它的正文是消息 text，不是 caption：
 *   1. 群组/频道：管理员**回复该消息** + `/edit@Bot 新文本` 一步直改；
 *   2. 私聊 /edit：发送**消息链接**或**含转发源的消息**定位后修改；
 *   3. 文本消息不能清空（Telegram 不允许空文本）；
 *   4. 消息库里没有记录的消息（库外）也允许改，但只改 Telegram、不动数据库。
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
    resetStore,
    stubModule
} = require('./helpers/memoryDb');

relaxTimers();
installMemoryDb(root);
const USER = 4242;
// 管理员校验（isAdmin）在模块加载时读取 config
stubModule(path.join(root, 'config.js'), { ADMIN_CHAT_IDS: [USER], ADMIN_CHAT_ID: String(USER) });
const { bot } = installBotStub(root);
installLoggerStub(root);

const { handleGroupMessage } = require('../handlers/groupMessageHandlers');
const handleEditMode = require('../handlers/modes/editMode');
const { setUserState, getRawUserState, deleteUserState } = require('../states');
const { parseMessageLink, resolveMessageOrigin } = require('../utils/messageLocator');

const GROUP = -1009001;
const CHANNEL = -1007001;
const BOT_NAME = 'SexFavoritesBOT';

const getMedia = () => store.get('media') || [];
const getMessages = () => store.get('message') || [];
const findMedia = (id) => getMedia().find(d => d.file_unique_id === id);

const groupMsg = (messageId, extra = {}) => ({
    chat: { id: GROUP, type: 'supergroup' }, message_id: messageId, ...extra
});
const privateMsg = (messageId, extra = {}) => ({
    from: { id: USER }, chat: { id: USER, type: 'private' }, message_id: messageId, ...extra
});

/** 群组内机器人发出的一条文本消息（收录为 media_type='text'，位置=群组位置） */
function seedGroupTextMedia({ messageId = 6000, text = '机器人发的文本', entities = [{ type: 'bold', offset: 0, length: 3 }] } = {}) {
    store.set('group_list', [{ _id: 'g1', group_id: `${GROUP}_${messageId}`, is_group: 1, is_delete: 0 }]);
    store.set('media', [{
        _id: 'm1',
        group_id: `${GROUP}_${messageId}`,
        subgroup: 1,
        file_id: null,
        file_unique_id: `text:${GROUP}:${messageId}`,
        media_type: 'text',
        media_name: text,
        media_entities: entities,
        group: { chat_id: GROUP, message_id: messageId }
    }]);
}

/** 频道里机器人发出的一条文本消息（位置=频道位置） */
function seedChannelTextMedia({ messageId = 5000, text = '频道文本' } = {}) {
    store.set('group_list', [{ _id: 'c1', group_id: `${CHANNEL}_${messageId}`, is_group: 1, is_delete: 0 }]);
    store.set('media', [{
        _id: 'mc1',
        group_id: `${CHANNEL}_${messageId}`,
        subgroup: 1,
        file_id: null,
        file_unique_id: `text:${CHANNEL}:${messageId}`,
        media_type: 'text',
        media_name: text,
        channel: { chat_id: CHANNEL, message_id: messageId }
    }]);
}

let calls = { texts: [], captions: [], sent: [] };

/**
 * 记录 bot 调用：
 *   texts    = editMessageText（含"✅ 找到了"这类流程提示）
 *   captions = editMessageCaption
 *   sent     = sendMessage
 */
function trackBot() {
    calls = { texts: [], captions: [], sent: [] };
    bot.editMessageText = async (text, opts) => { calls.texts.push({ text, ...(opts || {}) }); return true; };
    bot.editMessageCaption = async (text, opts) => { calls.captions.push({ text, ...(opts || {}) }); return true; };
    bot.sendMessage = async (chatId, text, opts) => {
        calls.sent.push({ chatId, text, ...(opts || {}) });
        return { message_id: 9000 + calls.sent.length, chat: { id: chatId }, text };
    };
    return calls;
}

/** 真正的"改正文"编辑（排除"✅ 找到了…"流程提示） */
const contentEdits = () => calls.texts.filter(e => !/找到了/.test(e.text));
const foundPrompt = () => calls.texts.filter(e => /找到了/.test(e.text));
const sentText = (re) => calls.sent.some(m => re.test(m.text));

const startEditMode = () => setUserState(USER, {
    mode: 'edit', step: 'waiting_for_media', lastActivity: Date.now(), _onExit: async () => { }
});

// ---------------- 群组：回复文本消息 + /edit@Bot 一步直改 ----------------

test('群组回复文本消息：/edit@机器人 新文本 直接改消息 text + 同步 media_name', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6000, text: '机器人发的文本' });
    trackBot();

    // 被回复的是机器人发出的文本消息（没有媒体字段，只有 text）
    const replied = groupMsg(6000, { from: { id: 777, is_bot: true }, text: '机器人发的文本' });
    await handleGroupMessage(groupMsg(6001, {
        from: { id: USER }, reply_to_message: replied, text: `/edit@${BOT_NAME} 改好的新文本`
    }));

    assert.strictEqual(contentEdits().length, 1, '文本消息用 editMessageText 改，不是 editMessageCaption');
    assert.strictEqual(contentEdits()[0].text, '改好的新文本');
    assert.strictEqual(contentEdits()[0].chat_id, GROUP);
    assert.strictEqual(contentEdits()[0].message_id, 6000);
    assert.strictEqual(calls.captions.length, 0, '文本消息没有 caption 可改');

    const doc = findMedia(`text:${GROUP}:6000`);
    assert.strictEqual(doc.media_name, '改好的新文本', '正文（media_name）同步更新');
    assert.ok(!('media_entities' in doc), '旧 entities 已清掉（新正文是纯文本）');
    assert.strictEqual(getMessages().length, 0, '文本媒体不写 message 记录');
    assert.ok(sentText(/✅ 修改完毕/), '群里有成功提示');
});

test('群组回复文本消息：不带文字时进入两步等待（提示语不提 /null），下一条文本即新正文', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6100, text: '原文本' });
    trackBot();

    const replied = groupMsg(6100, { from: { id: 777, is_bot: true }, text: '原文本' });
    await handleGroupMessage(groupMsg(6101, { from: { id: USER }, reply_to_message: replied, text: '/edit' }));

    const state = getRawUserState(USER);
    assert.ok(state, '进入等待状态');
    assert.strictEqual(state.step, 'waiting_for_group_text');
    assert.strictEqual(state.targetKind, 'text', '记下正文载体是 text');
    assert.ok(sentText(/请发送新的文本内容/), '文本消息的提示语');
    assert.ok(!sentText(/\/null/), '文本消息不能清空，提示语不提 /null');
    assert.strictEqual(contentEdits().length, 0, '还没输入正文，不做编辑');

    // 管理员的下一条文本 = 新正文
    await handleGroupMessage(groupMsg(6102, { from: { id: USER }, text: '两步改的新文本' }));

    assert.strictEqual(contentEdits().length, 1);
    assert.strictEqual(contentEdits()[0].chat_id, GROUP);
    assert.strictEqual(contentEdits()[0].message_id, 6100);
    assert.strictEqual(findMedia(`text:${GROUP}:6100`).media_name, '两步改的新文本');
    assert.strictEqual(getRawUserState(USER), undefined, '完成后退出编辑模式');
});

test('群组回复文本消息：/edit null 被拒绝（Telegram 不允许空文本）', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6200, text: '不该被清空' });
    trackBot();

    const replied = groupMsg(6200, { from: { id: 777, is_bot: true }, text: '不该被清空' });
    await handleGroupMessage(groupMsg(6201, { from: { id: USER }, reply_to_message: replied, text: '/edit null' }));

    assert.strictEqual(contentEdits().length, 0, '不应尝试编辑');
    assert.ok(sentText(/无法清空/), '给出明确提示');
    assert.strictEqual(findMedia(`text:${GROUP}:6200`).media_name, '不该被清空', '数据库不变');
});

test('群组回复：库里没有记录的机器人文本消息也能改（只改 Telegram，不动数据库）', async () => {
    resetStore();
    deleteUserState(USER);
    trackBot();

    const replied = groupMsg(6300, { from: { id: 777, is_bot: true }, text: '库外提示文本' });
    await handleGroupMessage(groupMsg(6301, { from: { id: USER }, reply_to_message: replied, text: '/edit 库外新文本' }));

    assert.strictEqual(contentEdits().length, 1);
    assert.strictEqual(contentEdits()[0].message_id, 6300);
    assert.strictEqual(contentEdits()[0].text, '库外新文本');
    assert.strictEqual(getMedia().length, 0, '不凭空建 media 记录');
    assert.strictEqual(getMessages().length, 0, '不凭空建 message 记录');
    assert.ok(sentText(/媒体库中无该消息记录/), '提示只改了 Telegram');
});

test('群组回复媒体消息：仍然走 caption（回归）', async () => {
    resetStore();
    deleteUserState(USER);
    store.set('group_list', [{ _id: 'g1', group_id: `${GROUP}_6400`, is_group: 1, is_delete: 0 }]);
    store.set('media', [{
        _id: 'mp', group_id: `${GROUP}_6400`, subgroup: 1, file_id: 'P1', file_unique_id: 'UP1',
        media_type: 'photo', group: { chat_id: GROUP, message_id: 6400 }
    }]);
    store.set('message', [{
        _id: 'sp', group_id: `${GROUP}_6400`, file_unique_id: 'UP1', text: '旧描述',
        media_type: 'photo', chat_id: GROUP, message_id: 6400
    }]);
    trackBot();

    const replied = groupMsg(6400, { photo: [{ file_id: 'P1', file_unique_id: 'UP1' }], caption: '旧描述' });
    await handleGroupMessage(groupMsg(6401, { from: { id: USER }, reply_to_message: replied, text: '/edit 新描述' }));

    assert.strictEqual(contentEdits().length, 0, '媒体消息不该用 editMessageText');
    assert.strictEqual(calls.captions.length, 1);
    assert.strictEqual(calls.captions[0].text, '新描述');
    assert.strictEqual(calls.captions[0].message_id, 6400);
    assert.strictEqual((getMessages().find(m => m.file_unique_id === 'UP1') || {}).text, '新描述');
});

// ---------------- 私聊：消息链接 / 转发来源定位 ----------------

test('私聊 /edit + 私有消息链接（t.me/c/...）→ 定位到文本消息并修改', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6000, text: '链接定位前的文本' });
    trackBot();
    startEditMode();

    // -1009001 → 链接里的内部 ID 是 9001
    await handleEditMode(privateMsg(7001, { text: 'https://t.me/c/9001/6000' }), getRawUserState(USER));

    const state = getRawUserState(USER);
    assert.ok(state, '保持编辑模式');
    assert.strictEqual(state.step, 'waiting_for_text');
    assert.strictEqual(state.targetKind, 'text');
    assert.strictEqual(state.targetChatId, GROUP);
    assert.strictEqual(state.targetMessageId, 6000);
    assert.ok(foundPrompt().some(e => /找到了（文本消息）/.test(e.text)), '提示已定位到文本消息');

    await handleEditMode(privateMsg(7002, { text: '私聊链接改的新文本' }), getRawUserState(USER));

    assert.strictEqual(contentEdits().length, 1);
    assert.strictEqual(contentEdits()[0].chat_id, GROUP);
    assert.strictEqual(contentEdits()[0].message_id, 6000);
    assert.strictEqual(contentEdits()[0].text, '私聊链接改的新文本');
    assert.strictEqual(findMedia(`text:${GROUP}:6000`).media_name, '私聊链接改的新文本');
    assert.strictEqual(getRawUserState(USER), undefined, '完成后退出编辑模式');
});

test('私聊 /edit + 含转发源的消息（频道帖带 message_id）→ 定位频道源消息并修改', async () => {
    resetStore();
    deleteUserState(USER);
    seedChannelTextMedia({ messageId: 5000, text: '频道原文本' });
    trackBot();
    startEditMode();

    await handleEditMode(privateMsg(7101, {
        forward_origin: { type: 'channel', date: 1, chat: { id: CHANNEL, type: 'channel', title: '频道' }, message_id: 5000 }
    }), getRawUserState(USER));

    const state = getRawUserState(USER);
    assert.strictEqual(state.step, 'waiting_for_text');
    assert.strictEqual(state.targetChatId, CHANNEL, '定位到频道源消息（改它 Telegram 会同步讨论群副本）');
    assert.strictEqual(state.targetMessageId, 5000);

    await handleEditMode(privateMsg(7102, { text: '转发定位改的文本' }), getRawUserState(USER));
    assert.strictEqual(contentEdits().length, 1);
    assert.strictEqual(contentEdits()[0].chat_id, CHANNEL);
    assert.strictEqual(contentEdits()[0].message_id, 5000);
    assert.strictEqual(findMedia(`text:${CHANNEL}:5000`).media_name, '转发定位改的文本');
});

test('私聊 /edit + 公开用户名链接（t.me/<用户名>/<消息ID>）→ getChat 解析出 chat_id', async () => {
    resetStore();
    deleteUserState(USER);
    seedChannelTextMedia({ messageId: 5000, text: '公开频道文本' });
    trackBot();
    const asked = [];
    bot.getChat = async (name) => { asked.push(name); return { id: CHANNEL, type: 'channel', username: 'somechannel' }; };
    startEditMode();

    await handleEditMode(privateMsg(7201, { text: 'https://t.me/somechannel/5000' }), getRawUserState(USER));

    assert.deepStrictEqual(asked, ['@somechannel'], '用用户名解析 chat_id');
    const state = getRawUserState(USER);
    assert.strictEqual(state.step, 'waiting_for_text');
    assert.strictEqual(state.targetChatId, CHANNEL);

    await handleEditMode(privateMsg(7202, { text: '公开链接改的文本' }), getRawUserState(USER));
    assert.strictEqual(contentEdits()[0].chat_id, CHANNEL);
    assert.strictEqual(findMedia(`text:${CHANNEL}:5000`).media_name, '公开链接改的文本');
});

test('私聊 /edit + 链接指向库里没有的消息 → 仍可改 Telegram（只改 Telegram）', async () => {
    resetStore();
    deleteUserState(USER);
    trackBot();
    startEditMode();

    await handleEditMode(privateMsg(7301, { text: 'https://t.me/c/9001/7300' }), getRawUserState(USER));

    const state = getRawUserState(USER);
    assert.strictEqual(state.step, 'waiting_for_text');
    assert.strictEqual(state.targetKind, 'auto', '库里没有记录：先按 caption 试，报没有 caption 再按文本试');
    assert.strictEqual(state.targetFileUniqueId, null);

    await handleEditMode(privateMsg(7302, { text: '库外消息新正文' }), getRawUserState(USER));

    assert.strictEqual(calls.captions.length, 1, 'auto：先尝试 caption');
    assert.strictEqual(calls.captions[0].chat_id, GROUP);
    assert.strictEqual(calls.captions[0].message_id, 7300);
    assert.strictEqual(contentEdits().length, 0, 'caption 成功就不再改 text');
    assert.ok(sentText(/媒体库中无该消息记录/), '明确告知只改了 Telegram');
    assert.strictEqual(getMedia().length, 0);
    assert.strictEqual(getMessages().length, 0);
});

test('私聊 /edit + 库外文本消息：caption 报"没有 caption"时自动改 text', async () => {
    resetStore();
    deleteUserState(USER);
    trackBot();
    // 目标其实是文本消息：editMessageCaption 会报 Telegram 的 "there is no caption in the message to edit"
    bot.editMessageCaption = async (text, opts) => {
        calls.captions.push({ text, ...(opts || {}) });
        throw new Error('ETELEGRAM: 400 Bad Request: there is no caption in the message to edit');
    };
    startEditMode();

    await handleEditMode(privateMsg(7351, { text: 'https://t.me/c/9001/7350' }), getRawUserState(USER));
    await handleEditMode(privateMsg(7352, { text: '库外文本新正文' }), getRawUserState(USER));

    assert.strictEqual(contentEdits().length, 1, '改成 editMessageText');
    assert.strictEqual(contentEdits()[0].chat_id, GROUP);
    assert.strictEqual(contentEdits()[0].message_id, 7350);
    assert.strictEqual(contentEdits()[0].text, '库外文本新正文');
    assert.ok(sentText(/媒体库中无该消息记录/));
});

test('群组回复媒体消息：两步流程输入 null 仍能清空 caption（回归）', async () => {
    resetStore();
    deleteUserState(USER);
    store.set('group_list', [{ _id: 'g1', group_id: `${GROUP}_6500`, is_group: 1, is_delete: 0 }]);
    store.set('media', [{
        _id: 'mp', group_id: `${GROUP}_6500`, subgroup: 1, file_id: 'P2', file_unique_id: 'UP2',
        media_type: 'photo', group: { chat_id: GROUP, message_id: 6500 }
    }]);
    store.set('message', [{
        _id: 'sp', group_id: `${GROUP}_6500`, file_unique_id: 'UP2', text: '待清空的描述',
        media_type: 'photo', chat_id: GROUP, message_id: 6500
    }]);
    trackBot();

    const replied = groupMsg(6500, { photo: [{ file_id: 'P2', file_unique_id: 'UP2' }], caption: '待清空的描述' });
    await handleGroupMessage(groupMsg(6501, { from: { id: USER }, reply_to_message: replied, text: '/edit' }));
    assert.strictEqual(getRawUserState(USER).targetKind, 'caption', '媒体目标仍是 caption');

    await handleGroupMessage(groupMsg(6502, { from: { id: USER }, text: 'null' }));

    assert.strictEqual(calls.captions.length, 1, '清空走 editMessageCaption');
    assert.strictEqual(calls.captions[0].text, '', '清空传空 caption');
    assert.strictEqual(calls.captions[0].message_id, 6500);
    assert.strictEqual(getMessages().filter(m => m.file_unique_id === 'UP2').length, 0, '清空后删除 message 记录');
    assert.strictEqual(getRawUserState(USER), undefined);
});

test('私聊 /edit + 无法解析的消息（群组转发没有原消息 ID）→ 提示改用链接', async () => {
    resetStore();
    deleteUserState(USER);
    trackBot();
    startEditMode();

    await handleEditMode(privateMsg(7401, {
        forward_origin: { type: 'chat', date: 1, sender_chat: { id: GROUP, type: 'supergroup' } }
    }), getRawUserState(USER));

    assert.ok(sentText(/请发送媒体消息/) && sentText(/链接/), '给出可操作的提示');
    assert.strictEqual(getRawUserState(USER).step, 'waiting_for_media', '仍在等待输入');
});

test('私聊编辑文本消息：发送 null 被拒绝，状态保留且正文不变', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6000, text: '不该被清空' });
    trackBot();
    startEditMode();

    await handleEditMode(privateMsg(7501, { text: 'https://t.me/c/9001/6000' }), getRawUserState(USER));
    await handleEditMode(privateMsg(7502, { text: 'null' }), getRawUserState(USER));

    assert.strictEqual(contentEdits().length, 0, '不应尝试编辑');
    assert.ok(sentText(/无法清空/));
    assert.strictEqual(findMedia(`text:${GROUP}:6000`).media_name, '不该被清空');
    assert.strictEqual(getRawUserState(USER).step, 'waiting_for_text', '还能重新输入');
});

// ---------------- 严格保留用户发送的文本格式（entities） ----------------

test('群组回复：命令里的 entities 原样带上（偏移量按截取后的正文平移）', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6600, text: '原文本' });
    trackBot();

    const replied = groupMsg(6600, { from: { id: 777, is_bot: true }, text: '原文本' });
    // Telegram 会给命令本身加一条 bot_command entity，正文部分的加粗 entity 从第 22 个字符开始
    const command = `/edit@${BOT_NAME} 加粗的新文本`;
    const entities = [
        { type: 'bot_command', offset: 0, length: 5 },
        { type: 'bold', offset: command.indexOf('加'), length: 6 }
    ];
    await handleGroupMessage(groupMsg(6601, {
        from: { id: USER }, reply_to_message: replied, text: command, entities
    }));

    const edit = contentEdits()[0];
    assert.strictEqual(edit.text, '加粗的新文本', '发给 Telegram 的是截取后的正文');
    assert.deepStrictEqual(edit.entities, [{ type: 'bold', offset: 0, length: 6 }],
        'bot_command 被丢掉、加粗 entity 平移到位');
    assert.ok(!('parse_mode' in edit), '有 entities 就不该再用 parse_mode 解析原文');

    const doc = findMedia(`text:${GROUP}:6600`);
    assert.strictEqual(doc.media_name, '加粗的新文本');
    assert.deepStrictEqual(doc.media_entities, [{ type: 'bold', offset: 0, length: 6 }],
        '库里也存下格式（查看媒体组重新发出时不会丢格式）');
});

test('群组两步：管理员第二条文本的 entities 原样保留（含 #X 后缀清理后的偏移）', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6610, text: '原文本' });
    trackBot();

    const replied = groupMsg(6610, { from: { id: 777, is_bot: true }, text: '原文本' });
    await handleGroupMessage(groupMsg(6611, { from: { id: USER }, reply_to_message: replied, text: '/edit' }));

    // 新正文带格式，并且末尾有一个历史遗留的 #A 等级后缀（落库会被清掉）
    const newText = '斜体新文本 #A';
    const entities = [{ type: 'italic', offset: 0, length: 5 }];
    await handleGroupMessage(groupMsg(6612, { from: { id: USER }, text: newText, entities }));

    const edit = contentEdits()[0];
    assert.strictEqual(edit.text, newText, 'Telegram 上按管理员发的原文（含后缀）');
    assert.deepStrictEqual(edit.entities, entities, 'entities 原样带上');

    const doc = findMedia(`text:${GROUP}:6610`);
    assert.strictEqual(doc.media_name, '斜体新文本', '库里清掉 #A 后缀');
    assert.deepStrictEqual(doc.media_entities, [{ type: 'italic', offset: 0, length: 5 }],
        '清理后缀不影响前面的格式（偏移量对齐 cleanText）');
});

test('私聊两步：新文本的 entities 原样保留并写回 media_entities', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6000, text: '原文本' });
    trackBot();
    startEditMode();

    await handleEditMode(privateMsg(7601, { text: 'https://t.me/c/9001/6000' }), getRawUserState(USER));
    const entities = [
        { type: 'bold', offset: 0, length: 2 },
        { type: 'text_link', offset: 2, length: 3, url: 'https://example.com' }
    ];
    await handleEditMode(privateMsg(7602, { text: '粗体链接正文', entities }), getRawUserState(USER));

    const edit = contentEdits()[0];
    assert.strictEqual(edit.text, '粗体链接正文');
    assert.deepStrictEqual(edit.entities, entities, '加粗 + 自定义链接锚文本都保留');
    assert.ok(!('parse_mode' in edit));
    const doc = findMedia(`text:${GROUP}:6000`);
    assert.strictEqual(doc.media_name, '粗体链接正文');
    assert.deepStrictEqual(doc.media_entities, entities);
});

test('私聊两步：新文本没有格式时清掉旧 media_entities', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6000, text: '带格式的旧文本' });
    trackBot();
    startEditMode();

    await handleEditMode(privateMsg(7611, { text: 'https://t.me/c/9001/6000' }), getRawUserState(USER));
    await handleEditMode(privateMsg(7612, { text: '纯文本新正文' }), getRawUserState(USER));

    assert.ok(!('entities' in contentEdits()[0]), '没有 entities 就不下发该字段');
    const doc = findMedia(`text:${GROUP}:6000`);
    assert.strictEqual(doc.media_name, '纯文本新正文');
    assert.ok(!('media_entities' in doc), '旧格式已清掉（偏移量对新正文已无意义）');
});

test('编辑媒体描述：caption 用 caption_entities 保留格式，并过滤 caption 不支持的类型', async () => {
    resetStore();
    deleteUserState(USER);
    store.set('group_list', [{ _id: 'g1', group_id: `${GROUP}_6700`, is_group: 1, is_delete: 0 }]);
    store.set('media', [{
        _id: 'mp', group_id: `${GROUP}_6700`, subgroup: 1, file_id: 'P3', file_unique_id: 'UP3',
        media_type: 'photo', group: { chat_id: GROUP, message_id: 6700 }
    }]);
    store.set('message', [{
        _id: 'sp', group_id: `${GROUP}_6700`, file_unique_id: 'UP3', text: '旧描述',
        media_type: 'photo', chat_id: GROUP, message_id: 6700
    }]);
    trackBot();

    const command = `/edit@${BOT_NAME} 加粗描述 @someone`;
    const replied = groupMsg(6700, { photo: [{ file_id: 'P3', file_unique_id: 'UP3' }], caption: '旧描述' });
    await handleGroupMessage(groupMsg(6701, {
        from: { id: USER },
        reply_to_message: replied,
        text: command,
        entities: [
            { type: 'bot_command', offset: 0, length: 5 },
            { type: 'bold', offset: command.indexOf('加'), length: 4 },
            { type: 'mention', offset: command.indexOf('@'), length: 8 }
        ]
    }));

    assert.strictEqual(calls.captions.length, 1);
    assert.strictEqual(calls.captions[0].text, '加粗描述 @someone');
    assert.deepStrictEqual(calls.captions[0].caption_entities, [{ type: 'bold', offset: 0, length: 4 }],
        'bold 保留、mention 这类 caption 不支持的类型被过滤');
    assert.ok(!('parse_mode' in calls.captions[0]), '有 entities 就不用 parse_mode');
});

test('群组回复：正文与机器人用户名重合时，entities 仍按精确下标平移（不能按内容猜）', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6650, text: '原文本' });
    trackBot();

    const replied = groupMsg(6650, { from: { id: 777, is_bot: true }, text: '原文本' });
    // 正文 "BOT" 与机器人用户名 SexFavoritesBOT 里的 "BOT" 重合：按 indexOf 猜会平移错位置
    const command = `/edit@${BOT_NAME} BOT`;
    // 22 = '/edit@' + 'SexFavoritesBOT' + 空格
    const start = command.length - 3;
    const entities = [{ type: 'bold', offset: start, length: 3 }];
    await handleGroupMessage(groupMsg(6651, {
        from: { id: USER }, reply_to_message: replied, text: command, entities
    }));

    assert.strictEqual(contentEdits()[0].text, 'BOT');
    assert.deepStrictEqual(contentEdits()[0].entities, [{ type: 'bold', offset: 0, length: 3 }]);
    assert.deepStrictEqual(findMedia(`text:${GROUP}:6650`).media_entities, [{ type: 'bold', offset: 0, length: 3 }]);
});

test('群组回复：命令后多余空白不影响 entities 平移', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6660, text: '原文本' });
    trackBot();

    const replied = groupMsg(6660, { from: { id: 777, is_bot: true }, text: '原文本' });
    const command = `/edit@${BOT_NAME}   带格式正文  `;
    const entities = [{ type: 'underline', offset: command.indexOf('带'), length: 5 }];
    await handleGroupMessage(groupMsg(6661, {
        from: { id: USER }, reply_to_message: replied, text: command, entities
    }));

    assert.strictEqual(contentEdits()[0].text, '带格式正文');
    assert.deepStrictEqual(contentEdits()[0].entities, [{ type: 'underline', offset: 0, length: 5 }]);
});

test('编辑消息：entities 被 Telegram 拒绝时降级为纯文本，正文不能丢', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6800, text: '原文本' });
    trackBot();
    const attempts = [];
    bot.editMessageText = async (text, opts) => {
        attempts.push({ text, ...(opts || {}) });
        if (opts && opts.entities) throw new Error("ETELEGRAM: 400 Bad Request: can't parse entities: Bad Request");
        return true;
    };

    const replied = groupMsg(6800, { from: { id: 777, is_bot: true }, text: '原文本' });
    // entity 覆盖正文部分（'/edit ' 之后），Telgeram 拒绝 entities 时要能降级写出正文
    await handleGroupMessage(groupMsg(6801, {
        from: { id: USER }, reply_to_message: replied, text: '/edit 新正文',
        entities: [{ type: 'bold', offset: 6, length: 3 }]
    }));

    assert.strictEqual(attempts.length, 2, '先带 entities 试，失败后重试');
    assert.ok(attempts[0].entities, '第一次带 entities');
    assert.ok(!attempts[1].entities, '第二次不带 entities');
    assert.strictEqual(attempts[1].text, '新正文');
    assert.strictEqual(findMedia(`text:${GROUP}:6800`).media_name, '新正文', '正文仍然改成功');
});

test('编辑消息：没有 entities 时保持原有 HTML → 纯文本降级行为', async () => {
    resetStore();
    deleteUserState(USER);
    seedGroupTextMedia({ messageId: 6900, text: '原文本' });
    trackBot();

    const replied = groupMsg(6900, { from: { id: 777, is_bot: true }, text: '原文本' });
    await handleGroupMessage(groupMsg(6901, { from: { id: USER }, reply_to_message: replied, text: '/edit 纯文本新正文' }));

    const edit = contentEdits()[0];
    assert.strictEqual(edit.parse_mode, 'HTML', '没有 entities 时仍先按 HTML 解析');
    assert.ok(!('entities' in edit));
});

// ---------------- 定位解析（纯函数 / 转发来源） ----------------

test('parseMessageLink：私有链接、公开链接、非消息链接', () => {
    assert.deepStrictEqual(parseMessageLink('https://t.me/c/1980542381/2094'), {
        chatId: -1001980542381, username: null, messageId: 2094, via: 'link'
    });
    assert.deepStrictEqual(parseMessageLink('t.me/c/1980542381/2094?single'), {
        chatId: -1001980542381, username: null, messageId: 2094, via: 'link'
    });
    assert.deepStrictEqual(parseMessageLink('https://t.me/xuexiziliao2/3610'), {
        chatId: null, username: 'xuexiziliao2', messageId: 3610, via: 'link'
    });
    assert.strictEqual(parseMessageLink('https://t.me/joinchat/AAAA'), null, '邀请链接不是消息链接');
    assert.strictEqual(parseMessageLink('https://t.me/c/1980542381'), null, '没有消息 ID');
    assert.strictEqual(parseMessageLink('普通文本'), null);
    assert.strictEqual(parseMessageLink(''), null);
});

test('resolveMessageOrigin：forward_origin / 旧版转发字段 / 群组转发（无消息 ID）', async () => {
    const byOrigin = await resolveMessageOrigin({
        forward_origin: { type: 'channel', chat: { id: CHANNEL, type: 'channel' }, message_id: 5000 }
    }, bot);
    assert.deepStrictEqual(byOrigin, { chatId: CHANNEL, messageId: 5000, via: 'forward_origin' });

    const legacy = await resolveMessageOrigin({
        forward_from_chat: { id: CHANNEL, type: 'channel' }, forward_from_message_id: 5001
    }, bot);
    assert.deepStrictEqual(legacy, { chatId: CHANNEL, messageId: 5001, via: 'forward_legacy' });

    const groupForward = await resolveMessageOrigin({
        forward_origin: { type: 'chat', sender_chat: { id: GROUP, type: 'supergroup' } }
    }, bot);
    assert.strictEqual(groupForward, null, '群组转发不带原消息 ID，无法定位（需改用消息链接）');
});
