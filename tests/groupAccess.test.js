// tests/groupAccess.test.js
/**
 * 群组/频道「谁能触发 bot」的门禁（用户要求）：
 *   1. 群/频道里**只处理管理员发送的内容**（`.env` 的 ADMIN_CHAT_ID）：
 *      非管理员的媒体/文本一律静默忽略，不进库、不提示；
 *      频道帖没有发送者（只有频道管理员能发帖）→ 天然放行；
 *      「频道 → 关联讨论群」的自动转发是频道自己的内容 → 放行（只补群组位置）；
 *   2. 群/频道里**指令一律忽略**，只有「回复一条消息 + /edit」这一种例外；
 *   3. 通知专用会话（启动/崩溃信息的话题群）：只发通知，**任何**消息都不处理；
 *   4. 私聊里没有权限的指令**不再提示"无权限"**，直接忽略（白名单命令照旧可用）。
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
const { bot } = installBotStub(root);
installLoggerStub(root);
// 必须在 require 被测模块之前：utils/permissions 在加载时持有 config 对象
stubModule(path.join(root, 'config.js'), {
    ADMIN_CHAT_IDS: [4242],
    ADMIN_CHAT_ID: '4242',
    STARTUP_NOTIFY_CHAT_ID: -1002223278475,
    STARTUP_NOTIFY_THREAD_ID: 85,
    IGNORED_CHAT_IDS: [-1002223278475]
});

const { handleGroupMessage, handleGroupEditedMessage } = require('../handlers/groupMessageHandlers');
const { handlePrivateMessage } = require('../handlers/messageHandlers');
const handleExecCmdCallback = require('../handlers/callbacks/execCmd');
const { getRawUserState, deleteUserState } = require('../states');
const { isIgnoredChat, isAdmin } = require('../utils/permissions');
const { COLLECTIONS } = require('../db/getCollection');

const ADMIN = 4242;
const MEMBER = 7;                  // 普通群成员（非管理员）
const GROUP = -1009001;
const CHANNEL = -1007001;
const NOTIFY_CHAT = -1002223278475;

const groupMsg = (messageId, extra = {}) => ({
    chat: { id: GROUP, type: 'supergroup' }, message_id: messageId, from: { id: MEMBER }, ...extra
});
const chanMsg = (messageId, extra = {}) => ({
    chat: { id: CHANNEL, type: 'channel' }, message_id: messageId, ...extra
});

/** 记录 bot 的全部外发消息 */
function trackBot() {
    const sent = [];
    const edits = [];
    const answers = [];
    let seq = 5000;
    bot.sendMessage = async (chatId, text, opts) => {
        sent.push({ chatId, text, opts });
        return { message_id: ++seq, chat: { id: chatId }, text };
    };
    bot.editMessageText = async (text, opts) => { edits.push({ text, opts }); return true; };
    bot.answerCallbackQuery = async (id, extra) => { answers.push({ id, extra }); };
    return { sent, edits, answers };
}

const media = () => store.get('media') || [];
const groupLists = () => store.get('group_list') || [];

// ---------------- 1. 只收录管理员发送的内容 ----------------

test('群组：非管理员发的媒体完全忽略（不进库、不提示）', async () => {
    resetStore();
    const { sent } = trackBot();

    await handleGroupMessage(groupMsg(1001, { photo: [{ file_id: 'P1', file_unique_id: 'UP1' }] }));

    assert.strictEqual(media().length, 0, '非管理员媒体不得入库');
    assert.strictEqual(groupLists().length, 0, '不得建媒体组');
    assert.strictEqual(sent.length, 0, '也不该有任何提示消息（静默忽略）');
});

test('群组：管理员发的媒体照常收录', async () => {
    resetStore();
    trackBot();

    await handleGroupMessage(groupMsg(1002, {
        from: { id: ADMIN },
        photo: [{ file_id: 'P2', file_unique_id: 'UP2' }]
    }));

    const doc = media().find(m => m.file_unique_id === 'UP2');
    assert.ok(doc, '管理员媒体应入库');
    assert.deepStrictEqual(doc.group, { chat_id: GROUP, message_id: 1002 }, '位置写在群组子文档');
    assert.ok(groupLists().some(g => g.group_id === `${GROUP}_1002`), '建了媒体组');
});

test('群组：管理员编辑消息才会同步数据库，非管理员编辑忽略', async () => {
    resetStore();
    trackBot();
    // 先收录一条管理员的带描述媒体
    await handleGroupMessage(groupMsg(1003, {
        from: { id: ADMIN },
        caption: '原描述',
        photo: [{ file_id: 'P3', file_unique_id: 'UP3' }]
    }));

    // 非管理员编辑：忽略（消息库仍是原描述）
    await handleGroupEditedMessage(groupMsg(1003, {
        caption: '被别人改了',
        photo: [{ file_id: 'P3', file_unique_id: 'UP3' }]
    }));
    const afterMember = (store.get('message') || []).find(m => m.file_unique_id === 'UP3');
    assert.strictEqual(afterMember.text, '原描述', '非管理员的编辑不得改库');

    // 管理员编辑：同步
    await handleGroupEditedMessage(groupMsg(1003, {
        from: { id: ADMIN },
        caption: '管理员改的',
        photo: [{ file_id: 'P3', file_unique_id: 'UP3' }]
    }));
    const afterAdmin = (store.get('message') || []).find(m => m.file_unique_id === 'UP3');
    assert.strictEqual(afterAdmin.text, '管理员改的', '管理员的编辑应同步');
});

test('频道：帖子没有发送者（只有频道管理员能发帖）→ 照常收录', async () => {
    resetStore();
    trackBot();

    await handleGroupMessage(chanMsg(5001, { photo: [{ file_id: 'C1', file_unique_id: 'UC1' }] }));

    assert.ok(media().some(m => m.file_unique_id === 'UC1'), '频道帖必须照常收录');
});

test('频道→讨论群自动转发：非管理员发出的转发副本仍按频道转发归属（只补群组位置）', async () => {
    resetStore();
    trackBot();
    // 频道侧已收录：media 只有频道位置 + message 指向频道源
    store.set(COLLECTIONS.MEDIA, [{
        _id: 'm-fwd', group_id: `${CHANNEL}_777`, subgroup: 1,
        file_id: 'F1', file_unique_id: 'FWD1', media_type: 'photo',
        channel: { chat_id: CHANNEL, message_id: 7001 }
    }]);
    store.set(COLLECTIONS.MESSAGE, [{
        _id: 'msg-fwd', group_id: `${CHANNEL}_777`, file_unique_id: 'FWD1',
        media_type: 'photo', chat_id: CHANNEL, message_id: 7001, text: '频道的描述'
    }]);

    await handleGroupMessage(groupMsg(9001, {
        is_automatic_forward: true,
        forward_origin: { type: 'channel', chat: { id: CHANNEL, type: 'channel' } },
        photo: [{ file_id: 'F1', file_unique_id: 'FWD1' }]
    }));

    const doc = media().find(m => m.file_unique_id === 'FWD1');
    assert.strictEqual(media().filter(m => m.file_unique_id === 'FWD1').length, 1, '不重复收录');
    assert.deepStrictEqual(doc.group, { chat_id: GROUP, message_id: 9001 }, '补上群组位置（回复时才能选回复在群组）');
});

test('普通成员手动转发频道帖：忽略（不抢走群组位置、不另建组）', async () => {
    resetStore();
    trackBot();
    store.set(COLLECTIONS.MEDIA, [{
        _id: 'm-hijack', group_id: `${CHANNEL}_778`, subgroup: 1,
        file_id: 'F2', file_unique_id: 'HIJ1', media_type: 'photo',
        channel: { chat_id: CHANNEL, message_id: 7002 }
    }]);
    store.set(COLLECTIONS.MESSAGE, [{
        _id: 'msg-hijack', group_id: `${CHANNEL}_778`, file_unique_id: 'HIJ1',
        media_type: 'photo', chat_id: CHANNEL, message_id: 7002, text: '频道的描述'
    }]);

    await handleGroupMessage(groupMsg(9002, {
        forward_origin: { type: 'channel', chat: { id: CHANNEL, type: 'channel' } },
        photo: [{ file_id: 'F2', file_unique_id: 'HIJ1' }]
    }));

    const doc = media().find(m => m.file_unique_id === 'HIJ1');
    assert.strictEqual(doc.group, undefined, '非管理员的转发不得改写群组位置');
    assert.strictEqual(groupLists().length, 0, '不得另建媒体组');
});

// ---------------- 2. 群/频道里只有「回复 + /edit」 ----------------

test('群组：其它指令一律忽略（管理员发 /send 也不执行）', async () => {
    resetStore();
    deleteUserState(ADMIN);
    const { sent } = trackBot();

    await handleGroupMessage(groupMsg(1100, { from: { id: ADMIN }, text: '/send' }));
    await handleGroupMessage(groupMsg(1101, { from: { id: ADMIN }, text: '/clean' }));

    assert.strictEqual(getRawUserState(ADMIN), undefined, '不得进入任何模式');
    assert.strictEqual(sent.length, 0, '不得回"正在获取列表"之类的任何消息');
});

test('群组：管理员「回复 + /edit」被处理；非管理员同样操作被忽略', async () => {
    resetStore();
    const { sent } = trackBot();
    const replied = { message_id: 1200, photo: [{ file_id: 'X1', file_unique_id: 'UX1' }] };

    // 非管理员：静默
    await handleGroupMessage(groupMsg(1201, {
        reply_to_message: replied, text: '/edit 新描述'
    }));
    assert.strictEqual(sent.length, 0, '非管理员的 /edit 必须静默忽略');

    // 管理员：进入快捷编辑（库里没有该媒体 → 回「未在媒体库中找到」）
    await handleGroupMessage(groupMsg(1202, {
        from: { id: ADMIN }, reply_to_message: replied, text: '/edit 新描述'
    }));
    assert.ok(sent.some(s => /未在媒体库中找到/.test(s.text || '')), '管理员的 /edit 应被处理');
});

// ---------------- 3. 通知专用会话：完全不处理 ----------------

test('通知专用群：管理员发的媒体/文本也不处理（只当通知出口）', async () => {
    resetStore();
    deleteUserState(ADMIN);
    const { sent } = trackBot();
    const notifyMsg = (messageId, extra = {}) => ({
        chat: { id: NOTIFY_CHAT, type: 'supergroup' }, message_id: messageId, from: { id: ADMIN }, ...extra
    });

    assert.strictEqual(isIgnoredChat(NOTIFY_CHAT), true, '通知群应在"完全不处理"名单里');

    await handleGroupMessage(notifyMsg(1301, { photo: [{ file_id: 'N1', file_unique_id: 'UN1' }] }));
    await handleGroupMessage(notifyMsg(1302, { text: '/send' }));
    await handleGroupMessage(notifyMsg(1303, { text: '随便一句话' }));

    assert.strictEqual(media().length, 0, '不得收录任何媒体');
    assert.strictEqual(groupLists().length, 0, '不得建媒体组');
    assert.strictEqual(getRawUserState(ADMIN), undefined, '不得进入任何模式');
    assert.strictEqual(sent.length, 0, '不得回任何消息');
});

// ---------------- 4. 私聊：无权限指令静默忽略 ----------------

test('私聊：无权限指令静默忽略；白名单命令照旧可用', async () => {
    resetStore();
    trackBot();
    const WHITELIST_USER = 555;
    // 白名单用户（非管理员）
    store.set(COLLECTIONS.USERS, [{ _id: 'u1', id: WHITELIST_USER, state: 1, white: 1 }]);
    const sent = [];
    bot.sendMessage = async (chatId, text, opts) => {
        sent.push({ chatId, text, opts });
        return { message_id: 6000 + sent.length, chat: { id: chatId } };
    };
    const priv = (messageId, text, userId = WHITELIST_USER) => ({
        from: { id: userId }, chat: { id: userId, type: 'private' },
        message_id: messageId, text
    });

    assert.strictEqual(isAdmin(WHITELIST_USER), false);

    // /clean 不在白名单里 → 静默（以前会回"❌ 无权使用该指令"）
    await handlePrivateMessage(priv(1, '/clean'));
    assert.strictEqual(sent.length, 0, '无权限指令不得有任何回复');

    // /search 在白名单里 → 照旧可用
    await handlePrivateMessage(priv(2, '/search'));
    assert.ok(sent.some(s => /已进入查找模式/.test(s.text || '')), '白名单命令仍然可用');
});

// ---------------- 5. 普通用户：随机视频 / 随机图片 ----------------

test('普通用户：私聊可以用 /random_pictures 与 /random_videos（其它指令仍静默）', async () => {
    resetStore();
    trackBot();
    const MEMBER_USER = 666;
    // 普通用户：在库、未封禁、非白名单
    store.set(COLLECTIONS.USERS, [{ _id: 'u2', id: MEMBER_USER, state: 1, white: 0 }]);
    const { getUserAccessTier } = require('../db/users');
    assert.strictEqual(await getUserAccessTier(MEMBER_USER), 'member', '口径：在库 + 未封禁 + 非白名单 = 普通用户');

    const sent = [];
    bot.sendMessage = async (chatId, text, opts) => {
        sent.push({ chatId, text, opts });
        return { message_id: 6100 + sent.length, chat: { id: chatId } };
    };
    bot.editMessageText = async () => true;
    const priv = (messageId, text) => ({
        from: { id: MEMBER_USER }, chat: { id: MEMBER_USER, type: 'private' },
        message_id: messageId, text
    });

    await handlePrivateMessage(priv(10, '/random_pictures'));
    assert.ok(sent.some(s => /正在搜集图片中/.test(s.text || '')), '普通用户应能用 /random_pictures');

    sent.length = 0;
    await handlePrivateMessage(priv(11, '/random_videos'));
    assert.ok(sent.some(s => /正在搜集视频中/.test(s.text || '')), '普通用户应能用 /random_videos');

    // 其它指令（含白名单命令 /search、管理员命令 /clean）→ 静默，且不出现"无权限/封禁"提示
    sent.length = 0;
    await handlePrivateMessage(priv(12, '/search'));
    await handlePrivateMessage(priv(13, '/clean'));
    assert.strictEqual(sent.length, 0, '普通用户的其它指令必须静默忽略');
});

test('普通用户：私聊里发普通文本不做查询（静默）', async () => {
    resetStore();
    trackBot();
    const MEMBER_USER = 667;
    store.set(COLLECTIONS.USERS, [{ _id: 'u3', id: MEMBER_USER, state: 1, white: 0 }]);
    const sent = [];
    bot.sendMessage = async (chatId, text, opts) => {
        sent.push({ chatId, text, opts });
        return { message_id: 6200 + sent.length, chat: { id: chatId } };
    };

    await handlePrivateMessage({
        from: { id: MEMBER_USER }, chat: { id: MEMBER_USER, type: 'private' },
        message_id: 20, text: '随便搜点什么'
    });
    assert.strictEqual(sent.length, 0, '普通用户不能搜索，也不该收到任何提示');
});

test('被封禁 / 未授权用户：仍然拒绝（随机看片也不给）', async () => {
    resetStore();
    trackBot();
    const BANNED = 668;
    const STRANGER = 669;
    store.set(COLLECTIONS.USERS, [{ _id: 'u4', id: BANNED, state: 0, white: 0 }]);
    const sent = [];
    bot.sendMessage = async (chatId, text, opts) => {
        sent.push({ chatId, text, opts });
        return { message_id: 6300 + sent.length, chat: { id: chatId } };
    };
    const priv = (messageId, text, userId) => ({
        from: { id: userId }, chat: { id: userId, type: 'private' },
        message_id: messageId, text
    });

    await handlePrivateMessage(priv(30, '/random_pictures', BANNED));
    assert.ok(sent.some(s => /被封禁或未被加入白名单/.test(s.text || '')), '封禁用户仍被拒绝');
    assert.ok(!sent.some(s => /正在搜集图片中/.test(s.text || '')), '封禁用户不得触发随机看片');

    sent.length = 0;
    await handlePrivateMessage(priv(31, '/random_pictures', STRANGER));
    assert.ok(sent.some(s => /被封禁或未被加入白名单/.test(s.text || '')), '未授权用户仍被拒绝');
    assert.ok(!sent.some(s => /正在搜集图片中/.test(s.text || '')), '未授权用户不得触发随机看片');
});

test('exec_cmd 按钮：非管理员点击静默忽略（不回"无权限"）', async () => {
    resetStore();
    const { answers, sent } = trackBot();

    await handleExecCmdCallback({
        id: 'q-exec', data: `exec_cmd:${encodeURIComponent('/restart')}`,
        from: { id: MEMBER }, message: { chat: { id: MEMBER }, message_id: 700 }
    });

    assert.strictEqual(answers.length, 1, '只回执一次（停掉按钮转圈）');
    assert.ok(!answers[0].extra || !answers[0].extra.text, '回执里不得带"无权限"文案');
    assert.strictEqual(sent.length, 0, '不得发任何消息');
});
