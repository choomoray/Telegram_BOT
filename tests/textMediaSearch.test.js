// tests/textMediaSearch.test.js
/**
 * 关键字查询的两个数据源 + 文本媒体（media_type='text'）
 *
 * 用户要求：
 *   1. 查询结构 `关键字 +类型 -标签`：先在 **message** 库查描述，再去 **media** 库查
 *      文件/音乐名称（media_name），两边都命中的按 file_unique_id 去重；
 *   2. `+d` 文件 / `+a` 音频 / `+p` 仅图片 / `+v` 视频 / `+t` 文本 是类型筛选，顺序错不予查询；
 *   3. /send、/reply 发出的纯文本要收录进 media（media_type='text'）：
 *      内容存 media_name、entities 存 media_entities（保留 Telegram 格式）。
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
    resetStore,
    stubModule
} = require('./helpers/memoryDb');

relaxTimers();
installMemoryDb(root);
const USER = 4321;
// 查询入口要先过管理员校验：把 config 打成"当前用户就是管理员"
stubModule(path.join(root, 'config.js'), { ADMIN_CHAT_IDS: [USER], ADMIN_CHAT_ID: String(USER) });
const { bot, sent } = installBotStub(root);
installLoggerStub(root);

const handleMessageReplyMode = require('../handlers/modes/messageReplyMode');
const { getRawUserState, setUserState } = require('../states');
const {
    handleQuery,
    searchMediaByName,
    mergeNameHits,
    buildQuery
} = require('../handlers/queryHandler');

const GROUP_ID = '-100_1001';

/** 构造关键字查询用的夹具：描述命中 + 文件名命中 + 纯音频（只有名称） */
function seed() {
    resetStore();
    store.set('media', [
        { _id: 'm1', group_id: 'g1', subgroup: 1, file_id: 'F1', file_unique_id: 'M1', media_type: 'document', media_name: '季度报告2026.pdf', group: { chat_id: -100, message_id: 101 } },
        { _id: 'm2', group_id: 'g2', subgroup: 1, file_id: 'F2', file_unique_id: 'M2', media_type: 'audio', media_name: '夜曲 - 周杰伦', group: { chat_id: -100, message_id: 201 } },
        { _id: 'm3', group_id: 'g3', subgroup: 1, file_id: 'F3', file_unique_id: 'M3', media_type: 'photo', group: { chat_id: -100, message_id: 301 } },
        { _id: 'm4', group_id: 'g4', subgroup: 1, file_id: null, file_unique_id: 'text:-100:401', media_type: 'text', media_name: '这是一条纯文本记录', group: { chat_id: -100, message_id: 401 } }
    ]);
    store.set('message', [
        // M1 同时命中描述与文件名（→ 合并后只应出现一次）
        { _id: 's1', group_id: 'g1', file_unique_id: 'M1', text: '季度报告的说明', tags: ['JK'], media_type: 'document', chat_id: -100, message_id: 101 },
        // 只有描述命中
        { _id: 's2', group_id: 'g3', file_unique_id: 'M3', text: '报告封面照片', tags: [], media_type: 'photo', chat_id: -100, message_id: 301 }
    ]);
    store.set('group_list', [
        { _id: 'g1', group_id: 'g1', is_group: 1, is_delete: 0 },
        { _id: 'g2', group_id: 'g2', is_group: 1, is_delete: 0 },
        { _id: 'g3', group_id: 'g3', is_group: 1, is_delete: 0 },
        { _id: 'g4', group_id: 'g4', is_group: 1, is_delete: 0 }
    ]);
}

const queryMsg = (text) => ({
    from: { id: USER }, chat: { id: USER, type: 'private' }, message_id: 900, text
});

/** 跑一次查询并返回最终回给用户的那条消息文本（handleQuery 内部是异步 IIFE） */
async function runQuery(text) {
    const msgs = [];
    bot.editMessageText = async (t) => { msgs.push(t); return true; };
    bot.sendMessage = async (chatId, t) => { msgs.push(t); return { message_id: 1, chat: { id: chatId }, text: t }; };
    await handleQuery(queryMsg(text));
    await sleep(30);
    return msgs.length ? msgs[msgs.length - 1] : null;
}

// ---------------- 双数据源合并 ----------------

test('关键字查询：先查 message 描述，再查 media 名称，两边都命中的去重', async () => {
    seed();
    const out = await runQuery('报告');
    assert.ok(out, '应给出查询结果');
    assert.match(out, /找到 2 条数据/, 'M1（描述 + 文件名都命中）只算一条，加上 M3 共 2 条');
    assert.match(out, /季度报告的说明/, 'message 描述命中');
    assert.match(out, /报告封面照片/, '另一条描述命中');
});

test('关键字查询：只命中文件名（没有描述）也能被搜到，并显示名称', async () => {
    seed();
    const out = await runQuery('夜曲');
    assert.match(out, /找到 1 条数据/);
    assert.match(out, /夜曲 - 周杰伦/, '结果行显示 media.media_name');
});

test('类型标记：+d 只搜文件、+p 只搜图片、+a 只搜音频', async () => {
    seed();
    const doc = await runQuery('报告 +d');
    assert.match(doc, /找到 1 条数据/, '+d 时只有文档类命中');
    assert.match(doc, /季度报告的说明/);
    assert.ok(!/报告封面照片/.test(doc), '图片描述不应出现在 +d 结果里');

    const photo = await runQuery('报告 +p');
    assert.match(photo, /报告封面照片/);
    assert.ok(!/季度报告2026\.pdf/.test(photo), '+p 不搜文件名（图片没有名称）');

    const audio = await runQuery('夜曲 +a');
    assert.match(audio, /找到 1 条数据/);
    assert.match(audio, /夜曲 - 周杰伦/);
});

test('只有类型标记（没有关键字）时列出该类型下带名称的媒体', async () => {
    seed();
    const out = await runQuery('+a');
    assert.match(out, /找到 1 条数据/);
    assert.match(out, /夜曲 - 周杰伦/);
});

test('顺序不对（+d 在关键字前 / +d 在标签后）不予查询，只回一条语法提示', async () => {
    seed();
    const out = await runQuery('+d 报告');
    assert.match(out, /查询格式不对/, '格式错误应回提示而不是执行查询');
    assert.match(out, /关键字 \+类型 -标签/);
    const out2 = await runQuery('报告 -JK +d');
    assert.match(out2, /查询格式不对/);
});

test('纯标签查询不带出全库文件（没有关键字 / 类型标记时不查 media 名称）', async () => {
    seed();
    const out = await runQuery('-JK');
    assert.match(out, /找到 1 条数据/, '只有带 JK 标签的那条 message');
    assert.match(out, /季度报告的说明/);
    assert.ok(!/夜曲/.test(out), '不带关键字的标签查询不应把文件/音乐也列出来');
});

test('searchMediaByName：按名称匹配 + 类型筛选（类型为空时全部）', async () => {
    seed();
    const all = await searchMediaByName('报告');
    assert.deepStrictEqual(all.map(d => d.file_unique_id), ['M1']);
    const audio = await searchMediaByName('', ['audio']);
    assert.deepStrictEqual(audio.map(d => d.file_unique_id), ['M2'], '只按类型列时要求有名称');
    const none = await searchMediaByName('夜曲', ['document']);
    assert.deepStrictEqual(none, [], '类型不匹配时为空');
});

test('mergeNameHits：同一条媒体既有描述又命中文件名时只保留 message 行', () => {
    const messageRows = [{ group_id: 'g1', file_unique_id: 'M1', text: '描述命中' }];
    const mediaHits = [
        { group_id: 'g1', file_unique_id: 'M1', media_type: 'document', media_name: '报告.pdf', group: { chat_id: -100, message_id: 101 } },
        { group_id: 'g9', file_unique_id: 'M9', media_type: 'document', media_name: '别的报告.pdf', group: { chat_id: -100, message_id: 901 } }
    ];
    const merged = mergeNameHits(messageRows, mediaHits);
    assert.strictEqual(merged.length, 2, 'M1 去重、M9 补充进来');
    assert.strictEqual(merged[0].text, '描述命中', '保留信息更全的 message 行');
    assert.strictEqual(merged[1].text, '别的报告.pdf', '只有文件名的命中用名称当展示文本');
    assert.strictEqual(merged[1].chat_id, -100);
    assert.strictEqual(merged[1].message_id, 901);
});

test('buildQuery：类型标记会限定 message.media_type', async () => {
    seed();
    const withTypes = await buildQuery({ keyword: '报告', tags: [], tagsAll: [], types: ['document'] });
    assert.deepStrictEqual(withTypes.query.media_type, { $in: ['document'] });
    const without = await buildQuery({ keyword: '报告', tags: [], tagsAll: [] });
    assert.ok(!('media_type' in without.query), '没有类型标记时不加类型条件');
});

// ---------------- 文本媒体收录（/reply 文本） ----------------

test('/reply 发文本：收录为 media_type=text（内容 + entities），is_delete=0', async () => {
    resetStore();
    store.set('group_list', [{ _id: 'g', group_id: GROUP_ID, is_group: 2, is_delete: 0 }]);
    store.set('media', [{ _id: 'm1', group_id: GROUP_ID, subgroup: 1, file_id: 'F1', file_unique_id: 'F1', media_type: 'photo', group: { chat_id: -100, message_id: 11 } }]);
    store.set('message', [{ _id: 's1', group_id: GROUP_ID, file_unique_id: 'F1', text: '原有描述', tags: [], media_type: 'photo', chat_id: -100, message_id: 11 }]);

    setUserState(USER, {
        mode: 'message_reply',
        step: 'ready',
        targetGroupId: GROUP_ID,
        targetChatId: -100,
        targetMessageId: 11,
        hintMsgInfo: null,
        replyLocations: null,
        readyMsgId: null,
        packSize: null,
        _onExit: async () => { },
        lastActivity: Date.now()
    });
    const entities = [{ type: 'italic', offset: 0, length: 2 }];
    bot.sendMessage = async (chatId, text, opts) => ({ message_id: 5000, chat: { id: chatId }, text, ...(opts || {}) });
    bot.editMessageText = async () => true;

    await handleMessageReplyMode({
        from: { id: USER }, chat: { id: USER, type: 'private' }, message_id: 5100,
        text: '斜体文本', entities
    }, getRawUserState(USER));
    await sleep(20);

    const doc = (store.get('media') || []).find(d => d.media_type === 'text');
    assert.ok(doc, '文本回复应被收录进 media');
    assert.strictEqual(doc.group_id, GROUP_ID);
    assert.strictEqual(doc.subgroup, 2, '按媒体回复的规则新增一个 subgroup');
    assert.strictEqual(doc.media_name, '斜体文本');
    assert.deepStrictEqual(doc.media_entities, entities, '保留 Telegram 文本格式');
    assert.deepStrictEqual(doc.group, { chat_id: -100, message_id: 5000 });
    assert.strictEqual((store.get('group_list') || []).find(g => g.group_id === GROUP_ID).is_delete, 0);
});

test('sendMediaGroupAsReply：描述不在第一条时先内联带上，发完还原并清掉第一条（转发副本不丢描述）', async () => {
    const { sendMediaGroupAsReply, albumCaptionCarry } = require('../media');
    // 纯函数：注释本来就在第一条 → 不需要清；不在第一条 → 内联带上并在发送后清掉
    assert.deepStrictEqual(albumCaptionCarry([{ caption: 'A' }]), { carrierCaption: 'A', clearFirst: false });
    assert.deepStrictEqual(albumCaptionCarry([{}, { caption: 'B' }]), { carrierCaption: 'B', clearFirst: true });
    assert.deepStrictEqual(albumCaptionCarry([{}, {}]), { carrierCaption: '', clearFirst: false });

    const albums = [];
    const edits = [];
    bot.sendMediaGroup = async (chatId, media) => {
        albums.push(media.map(m => m.caption));
        return media.map((m, i) => ({ message_id: 700 + i, chat: { id: chatId } }));
    };
    bot.editMessageCaption = async (text, opts) => { edits.push({ text, ...opts }); return true; };

    await sendMediaGroupAsReply(USER, 11, [
        { type: 'photo', fileId: 'PA' },
        { type: 'photo', fileId: 'PB', caption: '第二条的描述' }
    ]);
    assert.deepStrictEqual(albums[0], ['第二条的描述', undefined], '第一条内联带描述（任何副本都带得上）');
    assert.deepStrictEqual(edits.map(e => e.text), ['第二条的描述', ''], '先还原到第二条，再清掉第一条');
    assert.strictEqual(edits[0].message_id, 701, '还原到第二条的消息');
    assert.strictEqual(edits[1].message_id, 700, '清空第一条的消息');
});

test('查看媒体组时：文本媒体作为普通文本消息发出（不进媒体相册）', async () => {
    resetStore();
    const { sendMediaGroup } = require('../media');
    store.set('media', [
        { _id: 'a', group_id: GROUP_ID, subgroup: 1, file_id: 'P1', file_unique_id: 'P1', media_type: 'photo', group: { chat_id: -100, message_id: 11 } },
        { _id: 'b', group_id: GROUP_ID, subgroup: 1, file_id: null, file_unique_id: 'text:-100:12', media_type: 'text', media_name: '夹在中间的文本', media_entities: [{ type: 'bold', offset: 0, length: 2 }], group: { chat_id: -100, message_id: 12 } }
    ]);
    const albums = [];
    const texts = [];
    bot.sendMediaGroup = async (chatId, media) => { albums.push(media); return media.map((m, i) => ({ message_id: 700 + i, chat: { id: chatId } })); };
    bot.sendMessage = async (chatId, text, opts) => { texts.push({ text, opts }); return { message_id: 800, chat: { id: chatId } }; };

    await sendMediaGroup(USER, GROUP_ID);

    assert.strictEqual(albums.length, 1, '只有真正的媒体进相册');
    assert.deepStrictEqual(albums[0].map(m => m.media), ['P1']);
    assert.strictEqual(texts.length, 1, '文本单独作为文本消息发出');
    assert.strictEqual(texts[0].text, '夹在中间的文本');
    assert.deepStrictEqual(texts[0].opts.entities, [{ type: 'bold', offset: 0, length: 2 }], '带上 entities 保留格式');
});
