// tests/markRecord.test.js
/**
 * 标记逻辑回归（新）：单选题 + mark 历史集合
 *   - /mark 菜单只给两个按钮：仅记录 / 退出
 *   - 「仅记录」：不标记任何媒体/媒体组，只在 mark 集合记一条（不带 group_id / 媒体字段），完成即退出
 *   - 发送媒体（正常标记）：group_list.mark +1（语义不变）+ 写 mark 记录（带媒体/媒体组）→ 完成即退出
 *   - 媒体不存在：不写记录、不改 mark，保持标记模式可重试
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

const { insertMarkRecord, findMarkRecords } = require('../db/mark');
const { MARK_MENU_KEYBOARD } = require('../handlers/commands/mark');
const { handleMarkMenuCallback } = require('../handlers/callbacks/markCallback');
const handleMarkMode = require('../handlers/modes/markMode');
const { setUserState, getRawUserState } = require('../states');
const { upsertGroupList, findGroupList } = require('../db/groupList');

const USER = 4242;
const GROUP_ID = '-100_1';

const markDocs = () => store.get('mark') || [];

function seedMedia() {
    store.set('group_list', [{ _id: 'g1', group_id: GROUP_ID, is_group: 1, is_delete: 0, mark: 0 }]);
    store.set('media', [{
        _id: 'm1', group_id: GROUP_ID, subgroup: 1, media_type: 'photo',
        file_id: 'AgAC1', file_unique_id: 'F1',
        group: { chat_id: -100, message_id: 11 }
    }]);
}

const markMsg = (extra = {}) => ({
    from: { id: USER },
    chat: { id: USER, type: 'private' },
    message_id: 500,
    photo: [{ file_id: 'AgAC1', file_unique_id: 'F1' }],
    ...extra
});

// ---------------- mark 集合 ----------------

test('mark 集合：正常标记写全字段，仅记录不写媒体/媒体组字段', async () => {
    resetStore();

    await insertMarkRecord({
        userId: USER, mode: 'mark', groupId: GROUP_ID, fileUniqueId: 'F1', mediaType: 'photo', isGroup: true
    });
    const normal = markDocs()[0];
    assert.strictEqual(normal.mode, 'mark');
    assert.strictEqual(normal.userId, USER);
    assert.strictEqual(normal.group_id, GROUP_ID);
    assert.strictEqual(normal.file_unique_id, 'F1');
    assert.strictEqual(normal.media_type, 'photo');
    assert.strictEqual(normal.isGroup, true);
    assert.strictEqual(typeof normal.time, 'number');
    assert.ok(normal.date instanceof Date, 'date 供统计聚合用');

    await insertMarkRecord({ userId: USER, mode: 'record' });
    const record = markDocs()[1];
    assert.strictEqual(record.mode, 'record');
    assert.strictEqual(record.userId, USER);
    assert.ok(!('group_id' in record), '仅记录没有媒体组，不该写 group_id');
    assert.ok(!('file_unique_id' in record), '仅记录不写媒体字段');
    assert.ok(!('media_type' in record));
    assert.ok(!('isGroup' in record));
    assert.strictEqual(typeof record.time, 'number');
});

test('mark 集合：查询按时间倒序', async () => {
    resetStore();
    store.set('mark', [
        { _id: 'r1', userId: USER, mode: 'record', time: 1000 },
        { _id: 'r2', userId: USER, mode: 'mark', time: 3000, group_id: GROUP_ID },
        { _id: 'r3', userId: USER, mode: 'record', time: 2000 }
    ]);
    const list = await findMarkRecords({ userId: USER });
    assert.deepStrictEqual(list.map(d => d._id), ['r2', 'r3', 'r1']);
});

// ---------------- /mark 菜单：两个按钮 ----------------

test('/mark 菜单只有「仅记录」「退出」两个按钮', () => {
    const buttons = MARK_MENU_KEYBOARD.inline_keyboard.flat();
    assert.deepStrictEqual(buttons.map(b => b.callback_data), ['mark_menu:record', 'mark_menu:exit']);
    assert.deepStrictEqual(buttons.map(b => b.text), ['📝 仅记录', '🚪 退出']);
});

test('仅记录：写一条无媒体/媒体组的记录，回复「记录完成」并退出标记模式', async () => {
    resetStore();
    setUserState(USER, { mode: 'mark', lastActivity: Date.now() });

    const texts = [];
    const answers = [];
    bot.editMessageText = async (text) => { texts.push(text); return true; };
    bot.answerCallbackQuery = async (id, extra) => { answers.push(extra && extra.text); return true; };

    await handleMarkMenuCallback({
        id: 'q1',
        data: 'mark_menu:record',
        from: { id: USER },
        message: { chat: { id: USER }, message_id: 900 }
    });

    assert.strictEqual(markDocs().length, 1, '写了一条标记记录');
    assert.strictEqual(markDocs()[0].mode, 'record');
    assert.ok(!('group_id' in markDocs()[0]), '仅记录不带媒体组');
    assert.ok(texts.some(t => t.includes('记录完成')), '回复记录完成');
    assert.ok(answers.some(t => t && t.includes('记录完成')));
    assert.strictEqual(getRawUserState(USER), undefined, '完成后退出标记模式');
});

test('退出：清掉标记模式状态', async () => {
    resetStore();
    setUserState(USER, { mode: 'mark', lastActivity: Date.now() });

    bot.editMessageText = async () => true;
    bot.answerCallbackQuery = async () => true;

    await handleMarkMenuCallback({
        id: 'q2',
        data: 'mark_menu:exit',
        from: { id: USER },
        message: { chat: { id: USER }, message_id: 901 }
    });

    assert.strictEqual(getRawUserState(USER), undefined);
    assert.strictEqual(markDocs().length, 0, '退出不写记录');
});

test('单选题：另一种方式已结束后，旧按钮不再生效（不会重复记录）', async () => {
    resetStore();
    // 没有标记模式状态（例如已经发过媒体标记完成 / 已超时）
    const answers = [];
    bot.answerCallbackQuery = async (id, extra) => { answers.push(extra && extra.text); return true; };
    bot.editMessageText = async () => true;

    await handleMarkMenuCallback({
        id: 'q3',
        data: 'mark_menu:record',
        from: { id: USER },
        message: { chat: { id: USER }, message_id: 902 }
    });

    assert.strictEqual(markDocs().length, 0, '不写记录');
    assert.ok(answers.some(t => t && t.includes('已结束')), '提示标记模式已结束');
});

// ---------------- 发送媒体（正常标记） ----------------

test('发送媒体：group_list.mark +1、写 mark 记录、完成后退出标记模式', async () => {
    resetStore();
    seedMedia();
    setUserState(USER, { mode: 'mark', lastActivity: Date.now() });

    const texts = [];
    bot.editMessageText = async (text) => { texts.push(text); return true; };

    await handleMarkMode(markMsg(), getRawUserState(USER));

    const gl = await findGroupList(GROUP_ID);
    assert.strictEqual(gl.mark, 1, 'group_list.mark 语义不变（+1）');
    assert.strictEqual(typeof gl.last_mark_time, 'number', '仍记录最后标记时间');

    assert.strictEqual(markDocs().length, 1);
    const rec = markDocs()[0];
    assert.strictEqual(rec.mode, 'mark');
    assert.strictEqual(rec.userId, USER);
    assert.strictEqual(rec.group_id, GROUP_ID);
    assert.strictEqual(rec.file_unique_id, 'F1');
    assert.strictEqual(rec.media_type, 'photo');
    assert.strictEqual(rec.isGroup, false);

    assert.ok(texts.some(t => t.includes('标记成功')), '回复标记成功');
    assert.strictEqual(getRawUserState(USER), undefined, '成功记录后退出标记模式');
});

test('发送未收录的媒体：不写记录、不改 mark，保持标记模式', async () => {
    resetStore();
    seedMedia();
    setUserState(USER, { mode: 'mark', lastActivity: Date.now() });

    const texts = [];
    bot.editMessageText = async (text) => { texts.push(text); return true; };

    await handleMarkMode(markMsg({
        photo: [{ file_id: 'AgACX', file_unique_id: 'NOT_IN_LIB' }]
    }), getRawUserState(USER));

    assert.strictEqual(markDocs().length, 0, '没有记录');
    const gl = await findGroupList(GROUP_ID);
    assert.strictEqual(gl.mark, 0, 'mark 不变');
    assert.ok(texts.some(t => t.includes('数据不存在')));
    const st = getRawUserState(USER);
    assert.ok(st && st.mode === 'mark', '仍留在标记模式，方便重试');
});
