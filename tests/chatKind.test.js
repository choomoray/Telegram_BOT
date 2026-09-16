// tests/chatKind.test.js
/**
 * 会话类型（频道 / 群组）权威解析 + /send 目标列表排序
 *
 * 覆盖用户反馈的两个真实故障：
 *   1. `channel_group.type` 把讨论群登记成了频道（历史脏数据）→ 只发在群组里的媒体
 *      被记成**频道位置**，回复它时文案写"回复在📢 频道"，实际却发在群里；
 *   2. `/send` 目标列表里频道与群组都显示 📢（两条记录 type 都是 channel），
 *      且没有把"互相绑定"的一对排在一起。
 *
 * 约定：类型一律以 Telegram（bot.getChat）为准，库里不一致就顺手改正（自愈）。
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
    sleep
} = require('./helpers/memoryDb');

relaxTimers();
installMemoryDb(root);
const { bot } = installBotStub(root);
installLoggerStub(root);

const chatKind = require('../utils/chatKind');
const { buildMediaLocation } = require('../db/media');
const sendMode = require('../handlers/modes/sendMode');
const { COLLECTIONS } = require('../db/getCollection');

const CHANNEL_CHAT = -1003100196312;   // 真·频道
const GROUP_CHAT = -1003719524881;     // 真·讨论群（历史数据里被登记成 channel）
const PLAIN_GROUP = -100555;
const USER_CHAT = 6161;

/** 安装 getChat 桩：map 里没登记的 id 一律"chat not found" */
function installGetChat(map) {
    bot.getChat = async (chatId) => {
        const type = map.get(Number(chatId));
        if (!type) throw new Error('ETELEGRAM: 400 Bad Request: chat not found');
        return { id: Number(chatId), type };
    };
}

function uninstallGetChat() {
    delete bot.getChat;
    chatKind.clearChatKindCache();
}

/** 种一条 channel_group 记录 */
function seedChat(id, type, bindId = null, name = `Chat${id}`) {
    if (!store.has(COLLECTIONS.CHANNEL_GROUP)) store.set(COLLECTIONS.CHANNEL_GROUP, []);
    const list = store.get(COLLECTIONS.CHANNEL_GROUP);
    list.push({ _id: `cg-${id}`, id, name, type, bind_id: bindId, is_bound: bindId !== null });
}

// ---------------- 类型归一 ----------------

test('normalizeKind：group/supergroup 都是群组，channel 是频道，其余为 null', () => {
    assert.strictEqual(chatKind.normalizeKind('channel'), 'channel');
    assert.strictEqual(chatKind.normalizeKind('group'), 'group');
    assert.strictEqual(chatKind.normalizeKind('supergroup'), 'group');
    assert.strictEqual(chatKind.normalizeKind('private'), null);
    assert.strictEqual(chatKind.normalizeKind(undefined), null);
});

// ---------------- 权威解析 ----------------

test('resolveChatKind：以 Telegram 真实类型为准，并顺手把库里错的 type 改正（自愈）', async () => {
    resetStore();
    chatKind.clearChatKindCache();
    seedChat(GROUP_CHAT, 'channel');          // 库里错记为频道
    installGetChat(new Map([[GROUP_CHAT, 'supergroup']]));

    const kind = await chatKind.resolveChatKind(GROUP_CHAT);
    assert.strictEqual(kind, 'group', '讨论群必须以 Telegram 为准判成群组');

    await sleep(20);   // 自愈是 fire-and-forget，等它写完
    const doc = store.get(COLLECTIONS.CHANNEL_GROUP).find(c => c.id === GROUP_CHAT);
    assert.strictEqual(doc.type, 'group', '库里 type 应被改成 group');

    uninstallGetChat();
});

test('resolveChatKind：取不到真实类型时退回库里的 type（不瞎猜）', async () => {
    resetStore();
    chatKind.clearChatKindCache();
    seedChat(CHANNEL_CHAT, 'channel');
    bot.getChat = async () => { throw new Error('ETELEGRAM: 400 Bad Request: chat not found'); };

    assert.strictEqual(await chatKind.resolveChatKind(CHANNEL_CHAT), 'channel', '拿不到真实类型就用库里记录');
    assert.strictEqual(await chatKind.resolveChatKind(USER_CHAT), null, '库里也没有 → null（调用方定默认值）');

    uninstallGetChat();
});

test('telegramChatKind：同一会话只问一次 Telegram（缓存），并支持并发去重', async () => {
    resetStore();
    chatKind.clearChatKindCache();
    let calls = 0;
    bot.getChat = async (chatId) => { calls++; await sleep(5); return { id: chatId, type: 'channel' }; };

    const results = await Promise.all([
        chatKind.telegramChatKind(CHANNEL_CHAT),
        chatKind.telegramChatKind(CHANNEL_CHAT),
        chatKind.telegramChatKind(CHANNEL_CHAT)
    ]);
    assert.deepStrictEqual(results, ['channel', 'channel', 'channel']);
    assert.strictEqual(calls, 1, '并发调用应合并成一次 getChat');

    await chatKind.telegramChatKind(CHANNEL_CHAT);
    assert.strictEqual(calls, 1, '缓存命中不再请求 Telegram');

    uninstallGetChat();
});

test('repairChannelGroupTypes：全库按 Telegram 真实类型修正（只改错的那条）', async () => {
    resetStore();
    chatKind.clearChatKindCache();
    seedChat(CHANNEL_CHAT, 'channel');
    seedChat(GROUP_CHAT, 'channel');      // 错
    seedChat(PLAIN_GROUP, 'group');

    installGetChat(new Map([
        [CHANNEL_CHAT, 'channel'],
        [GROUP_CHAT, 'supergroup'],
        [PLAIN_GROUP, 'supergroup']
    ]));

    const stats = await chatKind.repairChannelGroupTypes();
    assert.strictEqual(stats.total, 3);
    assert.strictEqual(stats.checked, 3);
    assert.strictEqual(stats.fixed, 1, '只有讨论群那一条需要修');

    const docs = store.get(COLLECTIONS.CHANNEL_GROUP);
    assert.strictEqual(docs.find(c => c.id === GROUP_CHAT).type, 'group');
    assert.strictEqual(docs.find(c => c.id === CHANNEL_CHAT).type, 'channel');

    uninstallGetChat();
});

// ---------------- 媒体位置写入（故障 1 的源头） ----------------

test('buildMediaLocation：群组里的媒体写成 group 位置（库里 type 错了也不受影响）', async () => {
    resetStore();
    chatKind.clearChatKindCache();
    seedChat(GROUP_CHAT, 'channel');      // 历史脏数据：讨论群被登记成频道
    installGetChat(new Map([[GROUP_CHAT, 'supergroup']]));

    const loc = await buildMediaLocation(GROUP_CHAT, 12858, null);
    assert.deepStrictEqual(loc, { group: { chat_id: GROUP_CHAT, message_id: 12858 } },
        '只发在群组里的媒体必须记成 group 位置，而不是 channel');

    // 真频道仍然写 channel
    seedChat(CHANNEL_CHAT, 'channel');
    await chatKind.resolveChatKind(CHANNEL_CHAT);
    const chanLoc = await buildMediaLocation(CHANNEL_CHAT, 2273, null);
    assert.deepStrictEqual(chanLoc, { channel: { chat_id: CHANNEL_CHAT, message_id: 2273 } });

    uninstallGetChat();
});

test('buildMediaLocation：调用方显式传 Telegram 的 chat.type（含 supergroup）时按它归类，不问库', async () => {
    resetStore();
    chatKind.clearChatKindCache();
    seedChat(PLAIN_GROUP, 'channel');     // 库里错记成频道
    let asked = 0;
    bot.getChat = async () => { asked++; throw new Error('不应该被调用'); };

    assert.deepStrictEqual(
        await buildMediaLocation(PLAIN_GROUP, 10, 'supergroup'),
        { group: { chat_id: PLAIN_GROUP, message_id: 10 } }
    );
    assert.deepStrictEqual(
        await buildMediaLocation(CHANNEL_CHAT, 11, 'channel'),
        { channel: { chat_id: CHANNEL_CHAT, message_id: 11 } }
    );
    assert.strictEqual(asked, 0, '显式给了类型就不该再问 Telegram');

    uninstallGetChat();
});

// ---------------- /send 目标列表排序（故障 2） ----------------

test('sortChatGroups：互相绑定的一对相邻且先频道后群组，未绑定的排后面；不改入参', () => {
    const list = [
        { id: -300, name: '孤群', type: 'group', bind_id: null },
        { id: -200, name: '讨论群', type: 'group', bind_id: -100 },
        { id: -100, name: '频道', type: 'channel', bind_id: -200 },
        { id: -50, name: '孤频道', type: 'channel', bind_id: null }
    ];
    const snapshot = JSON.stringify(list);

    const sorted = chatKind.sortChatGroups(list);
    assert.deepStrictEqual(sorted.map(g => g.id), [-100, -200, -300, -50],
        '绑定对（频道→群组）在最前，然后未绑定的按 id 升序');
    assert.strictEqual(JSON.stringify(list), snapshot, '不能修改入参');
});

test('sortChatGroups：两端 type 都错记成 channel 时，先按 id 稳定排列', () => {
    const sorted = chatKind.sortChatGroups([
        { id: -200, type: 'channel', bind_id: -100 },
        { id: -100, type: 'channel', bind_id: -200 }
    ]);
    assert.deepStrictEqual(sorted.map(g => g.id), [-200, -100], '类型无法区分时 id 小的在前，顺序稳定');
});

test('withRealTypes：返回按真实类型补正的副本，且库里也已自愈', async () => {
    resetStore();
    chatKind.clearChatKindCache();
    seedChat(CHANNEL_CHAT, 'channel', GROUP_CHAT);
    seedChat(GROUP_CHAT, 'channel', CHANNEL_CHAT);      // 错：讨论群被登记成频道
    installGetChat(new Map([
        [CHANNEL_CHAT, 'channel'],
        [GROUP_CHAT, 'supergroup']
    ]));

    const raw = store.get(COLLECTIONS.CHANNEL_GROUP);
    const fixed = await chatKind.withRealTypes(raw);
    assert.deepStrictEqual(fixed.map(g => g.type), ['channel', 'group'], '群组那条的 type 被补正成 group');

    await sleep(20);
    assert.strictEqual(store.get(COLLECTIONS.CHANNEL_GROUP).find(c => c.id === GROUP_CHAT).type, 'group');

    // 直接用于选择列表：图标区分开 + 绑定对相邻
    const sorted = chatKind.sortChatGroups(fixed);
    assert.deepStrictEqual(sorted.map(g => g.id), [CHANNEL_CHAT, GROUP_CHAT]);

    uninstallGetChat();
});

test('/send 目标列表：频道 📢 / 群组 👥 图标区分，且绑定对相邻（频道在前）', async () => {
    resetStore();
    chatKind.clearChatKindCache();
    seedChat(CHANNEL_CHAT, 'channel', GROUP_CHAT, '频道A');
    seedChat(GROUP_CHAT, 'channel', CHANNEL_CHAT, '群组B');   // 历史脏数据：群被登记成频道
    seedChat(PLAIN_GROUP, 'group', null, '孤群');
    installGetChat(new Map([
        [CHANNEL_CHAT, 'channel'],
        [GROUP_CHAT, 'supergroup'],
        [PLAIN_GROUP, 'supergroup']
    ]));

    const captured = [];
    bot.sendMessage = async (chatId, text, opts) => {
        captured.push({ chatId, text, opts });
        return { message_id: 1, chat: { id: chatId } };
    };

    await sendMode.showGroupList(USER_CHAT, null, 1);

    const rows = captured[0].opts.reply_markup.inline_keyboard;
    assert.deepStrictEqual(rows.map(r => r[0].text), ['📢 频道A', '👥 群组B', '👥 孤群'],
        '频道用 📢、群组用 👥；绑定对相邻且频道在前，未绑定的排最后');
    assert.deepStrictEqual(rows.map(r => r[0].callback_data), [`sendg:${CHANNEL_CHAT}`, `sendg:${GROUP_CHAT}`, `sendg:${PLAIN_GROUP}`]);

    uninstallGetChat();
});
