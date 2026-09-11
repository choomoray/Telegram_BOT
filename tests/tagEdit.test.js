// tests/tagEdit.test.js
/**
 * 编辑描述与标签的关系（新规则）：
 *   - 编辑描述：**保留已有标签**，只把新文本里匹配到的标签补上（不再"清空重打"）
 *   - 清空描述：标签整体清空（并递减标签使用次数），message 记录删除
 *   - 私聊 /edit「找到了」消息下的快捷按钮：edit_clear（清空描述）/ edit_exit（退出）
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

const { reMatchMessageTags, clearMessageTags } = require('../utils/tagSync');
const { handleEditClear, handleEditExit } = require('../handlers/callbacks/editQuickCallback');
const handleEditMode = require('../handlers/modes/editMode');
const { setUserState, getRawUserState } = require('../states');

const USER = 5566;
const GROUP_ID = '-100_1';

const findTag = (name) => (store.get('tags') || []).find(t => t.name === name);
const findMsg = (fileUniqueId) => (store.get('message') || []).find(m => m.file_unique_id === fileUniqueId);

function seedTags() {
    store.set('tags', [
        { _id: 't1', name: 'JK', pin: 0, count: 5 },
        { _id: 't2', name: 'JP', pin: 0, count: 2 },
        { _id: 't3', name: 'AV', pin: 0, count: 8 }
    ]);
}

function seedMediaWithText({ text = '旧描述', tags = ['JK'] } = {}) {
    store.set('group_list', [{ _id: 'g1', group_id: GROUP_ID, is_group: 1, is_delete: 0, mark: 0 }]);
    store.set('media', [{
        _id: 'm1', group_id: GROUP_ID, subgroup: 1, file_unique_id: 'F1', media_type: 'photo',
        message_id: 11, group: { chat_id: -100, message_id: 11 }
    }]);
    store.set('message', [{
        _id: 's1', group_id: GROUP_ID, file_unique_id: 'F1', text, tags,
        chat_id: -100, message_id: 11, updated_at: Date.now()
    }]);
}

// ---------------- 编辑描述：标签合并（不移除） ----------------

test('编辑描述：保留已有标签，只补充新文本匹配到的标签', async () => {
    resetStore();
    seedTags();
    seedMediaWithText();

    await reMatchMessageTags('F1', '新描述 JP 内容');

    assert.deepStrictEqual([...findMsg('F1').tags].sort(), ['JK', 'JP'], '旧标签 JK 保留，新匹配的 JP 补上');
    assert.strictEqual(findTag('JK').count, 5, '已有标签的使用次数不变');
    assert.strictEqual(findTag('JP').count, 3, '新补标签使用次数 +1');
});

test('编辑描述：新文本不含任何标签时，已有标签也不被移除', async () => {
    resetStore();
    seedTags();
    seedMediaWithText({ text: '旧描述', tags: ['JK', 'AV'] });

    await reMatchMessageTags('F1', '完全不含标签的新描述');

    assert.deepStrictEqual([...findMsg('F1').tags].sort(), ['AV', 'JK'], '标签原样保留');
    assert.strictEqual(findTag('JK').count, 5);
    assert.strictEqual(findTag('AV').count, 8);
});

test('编辑描述：重复补充已存在的标签不会重复计数', async () => {
    resetStore();
    seedTags();
    seedMediaWithText({ text: 'JK 描述', tags: ['JK'] });

    await reMatchMessageTags('F1', 'JK 描述（再编辑一次）');

    assert.deepStrictEqual(findMsg('F1').tags, ['JK']);
    assert.strictEqual(findTag('JK').count, 5, '同一标签不重复 +1');
});

// ---------------- 清空描述：标签整体清空 ----------------

test('清空描述：标签整体清空并递减使用次数', async () => {
    resetStore();
    seedTags();
    seedMediaWithText({ text: '旧描述', tags: ['JK', 'AV'] });

    await clearMessageTags('F1');

    assert.deepStrictEqual(findMsg('F1').tags, []);
    assert.strictEqual(findTag('JK').count, 4);
    assert.strictEqual(findTag('AV').count, 7);
});

// ---------------- 快捷按钮：清空描述 / 退出 ----------------

function setEditState() {
    setUserState(USER, {
        mode: 'edit',
        step: 'waiting_for_text',
        targetChatId: -100,
        targetMessageId: 11,
        editTargets: [{ chatId: -100, messageId: 11, via: 'group' }],
        targetGroupId: GROUP_ID,
        targetFileUniqueId: 'F1',
        targetMediaType: 'photo',
        processingMsgId: 900,
        lastActivity: Date.now()
    });
}

const callbackQuery = () => ({ id: 'q1', from: { id: USER }, message: { chat: { id: USER }, message_id: 900 } });

test('快捷按钮 edit_clear：清 Telegram caption + 删 message 记录 + 清空标签 + 退出编辑状态', async () => {
    resetStore();
    seedTags();
    seedMediaWithText();

    const captions = [];
    bot.editMessageCaption = async (text, opts) => { captions.push({ text, chat: opts.chat_id, msg: opts.message_id }); return true; };
    const texts = [];
    bot.editMessageText = async (text) => { texts.push(text); return true; };
    const answers = [];
    bot.answerCallbackQuery = async (id, extra) => { answers.push(extra && extra.text); };

    setEditState();
    await handleEditClear(callbackQuery());

    assert.deepStrictEqual(captions, [{ text: '', chat: -100, msg: 11 }], '清空 Telegram caption');
    assert.strictEqual(findMsg('F1'), undefined, 'message 记录被删除');
    assert.strictEqual(findTag('JK').count, 4, '标签使用次数递减');
    assert.ok(store.get('group_list')[0].is_delete > 0, '组内已无文本 → 标记可清理');
    assert.strictEqual(getRawUserState(USER), undefined, '退出编辑状态');
    assert.ok(texts.includes('✅ 已清空描述'));
});

test('快捷按钮 edit_clear：位置不可编辑时转入「仅更新数据库」确认流程', async () => {
    resetStore();
    seedTags();
    seedMediaWithText();

    bot.editMessageCaption = async () => { throw new Error("ETELEGRAM: 400 Bad Request: message can't be edited"); };
    const texts = [];
    bot.editMessageText = async (text) => { texts.push(text); return true; };
    bot.answerCallbackQuery = async () => true;

    setEditState();
    await handleEditClear(callbackQuery());

    const st = getRawUserState(USER);
    assert.strictEqual(st.step, 'confirm_db_only', '转入确认流程');
    assert.deepStrictEqual(st.pendingEdit, { isClearing: true, cleanText: '' });
    assert.deepStrictEqual(findMsg('F1').tags, ['JK'], '等用户确认前不动数据库');
    assert.ok(texts.some(t => t.includes('只更改数据库')));
});

test('快捷按钮 edit_exit：退出编辑模式并提示', async () => {
    resetStore();
    const texts = [];
    bot.editMessageText = async (text) => { texts.push(text); return true; };
    bot.answerCallbackQuery = async () => true;

    setEditState();
    await handleEditExit(callbackQuery());

    assert.strictEqual(getRawUserState(USER), undefined, '状态已清理');
    assert.ok(texts.some(t => t.includes('已退出')), '提示已退出编辑模式');
});

test('快捷按钮 edit_exit：状态已过期时不报错', async () => {
    resetStore();
    bot.editMessageText = async () => true;
    bot.answerCallbackQuery = async () => true;

    await handleEditExit(callbackQuery());
    assert.strictEqual(getRawUserState(USER), undefined);
});

// ---------------- 私聊 /edit 完整流程 ----------------

test('私聊 /edit：找到媒体后的提示消息带「清空描述 / 退出」按钮', async () => {
    resetStore();
    seedTags();
    seedMediaWithText();

    setUserState(USER, { mode: 'edit', step: 'waiting_for_media', lastActivity: Date.now() });
    bot.sendMessage = async (chatId) => ({ message_id: 900, chat: { id: chatId } });
    const edits = [];
    bot.editMessageText = async (text, opts) => { edits.push({ text, opts }); return true; };

    await handleEditMode({
        from: { id: USER },
        chat: { id: USER, type: 'private' },
        message_id: 555,
        photo: [{ file_id: 'AgAC1', file_unique_id: 'F1' }]
    }, getRawUserState(USER));

    const found = edits.find(e => e.text.includes('找到了'));
    assert.ok(found, '应提示已找到媒体');
    const buttons = found.opts.reply_markup.inline_keyboard.flat();
    assert.deepStrictEqual(buttons.map(b => b.callback_data), ['edit_clear', 'edit_exit']);
    assert.deepStrictEqual(buttons.map(b => b.text), ['🗑 清空描述', '🚪 退出']);

    const st = getRawUserState(USER);
    assert.strictEqual(st.step, 'waiting_for_text');
    assert.deepStrictEqual(st.editTargets, [{ chatId: -100, messageId: 11, via: 'group' }]);
});

test('私聊 /edit：编辑成功后自动弹出打标签界面，且保留已有标签', async () => {
    resetStore();
    seedTags();
    seedMediaWithText({ text: '旧 JK 描述', tags: ['JK'] });

    setEditState();
    bot.editMessageCaption = async () => true;
    const sent = [];
    bot.sendMessage = async (chatId, text, opts) => {
        sent.push({ chatId, text, opts });
        return { message_id: 1234, chat: { id: chatId } };
    };

    await handleEditMode({
        from: { id: USER },
        chat: { id: USER, type: 'private' },
        message_id: 555,
        text: '新的描述（不含任何标签）'
    }, getRawUserState(USER));

    assert.strictEqual(findMsg('F1').text, '新的描述（不含任何标签）');
    assert.deepStrictEqual(findMsg('F1').tags, ['JK'], '编辑后旧标签保留');

    const panel = sent.find(s => s.opts && s.opts.reply_markup &&
        JSON.stringify(s.opts.reply_markup).includes('sendtag'));
    assert.ok(panel, '编辑成功后应自动弹出打标签界面');
    assert.ok(panel.text.includes('已选标签') && panel.text.includes('JK'), '界面里展示保留的标签');
});
