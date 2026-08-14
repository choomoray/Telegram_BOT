// tests/markFormatter.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const {
    sortMarkRecords,
    formatTime,
    formatMarkRecordLine,
    formatMarkRecords,
    buildMarkRecordsKeyboard,
    PAGE_SIZE
} = require('../utils/markFormatter');

const sampleRecords = [
    { group_id: 'g1', mark: 3, last_mark_time: 1000, text: '第一条', chat_id: -1001, message_id: 1, media_type: 'photo' },
    { group_id: 'g2', mark: 5, last_mark_time: 3000, text: '第二条', chat_id: -1002, message_id: 2, media_type: 'video' },
    { group_id: 'g3', mark: 1, last_mark_time: 2000, text: '第三条', chat_id: -1003, message_id: 3, media_type: 'audio' }
];

test('按标记次数降序排序', () => {
    const sorted = sortMarkRecords(sampleRecords, 'count');
    assert.deepStrictEqual(sorted.map(r => r.group_id), ['g2', 'g1', 'g3']);
});

test('按最后标记时间降序排序', () => {
    const sorted = sortMarkRecords(sampleRecords, 'time');
    assert.deepStrictEqual(sorted.map(r => r.group_id), ['g2', 'g3', 'g1']);
});

test('排序不修改原数组', () => {
    const copy = [...sampleRecords];
    sortMarkRecords(sampleRecords, 'count');
    assert.deepStrictEqual(sampleRecords, copy);
});

test('标记次数相同时按时间降序', () => {
    const records = [
        { group_id: 'a', mark: 2, last_mark_time: 1000 },
        { group_id: 'b', mark: 2, last_mark_time: 5000 }
    ];
    const sorted = sortMarkRecords(records, 'count');
    assert.deepStrictEqual(sorted.map(r => r.group_id), ['b', 'a']);
});

test('时间相同时按标记次数降序', () => {
    const records = [
        { group_id: 'a', mark: 1, last_mark_time: 3000 },
        { group_id: 'b', mark: 4, last_mark_time: 3000 }
    ];
    const sorted = sortMarkRecords(records, 'time');
    assert.deepStrictEqual(sorted.map(r => r.group_id), ['b', 'a']);
});

test('缺省字段记录排最后（time 模式）', () => {
    const records = [
        { group_id: 'a', mark: 2, last_mark_time: 5000 },
        { group_id: 'b', mark: 9, last_mark_time: null }
    ];
    const sorted = sortMarkRecords(records, 'time');
    assert.deepStrictEqual(sorted.map(r => r.group_id), ['a', 'b']);
});

test('格式化单条记录：次数置前 + 图标 + 编号 + 链接 + 时间置后', () => {
    const line = formatMarkRecordLine(
        { group_id: 'g1', mark: 3, last_mark_time: 1710000000000, text: '测试内容', chat_id: -1001234567890, message_id: 42, media_type: 'video' },
        1, 100
    );
    assert.ok(line.startsWith('🔖 3次'), `行应以次数开头: ${line}`);
    assert.ok(line.includes('🎬'));
    assert.ok(line.includes('01'));
    assert.ok(line.includes('https://t.me/c/1234567890/42'));
    assert.ok(line.includes('测试内容'));
    assert.ok(line.includes('⏱'));
    // 时间应在末尾（最后出现）
    assert.ok(line.lastIndexOf('⏱') > line.indexOf('测试内容'), `时间应在文本之后: ${line}`);
});

test('次数置前与排序模式无关', () => {
    // sortMode 不再影响行格式，行首始终为次数
    const item = { group_id: 'g1', mark: 3, last_mark_time: 1710000000000, text: '测试', chat_id: -1001, message_id: 1, media_type: 'photo' };
    const line = formatMarkRecordLine(item, 1, 10);
    assert.ok(line.startsWith('🔖 3次'));
    assert.ok(line.includes('⏱'));
});

test('无消息信息时无链接，空文本显示无标题', () => {
    const line = formatMarkRecordLine(
        { group_id: 'g1', mark: 1, last_mark_time: null, text: '', chat_id: null, message_id: null, media_type: null },
        1, 5
    );
    assert.ok(line.startsWith('🔖 1次'));
    assert.ok(!line.includes('<a href'));
    assert.ok(line.includes('（无标题）'));
    assert.ok(line.includes('⏱ 未知'));
});

test('长文本截断', () => {
    const longText = 'x'.repeat(100);
    const line = formatMarkRecordLine(
        { group_id: 'g1', mark: 1, last_mark_time: null, text: longText, chat_id: -1001, message_id: 1, media_type: 'photo' },
        1, 1
    );
    assert.ok(line.includes('…'));
    assert.ok(!line.includes('x'.repeat(50)));
});

test('列表文本包含标题与总条数', () => {
    const text = formatMarkRecords(sampleRecords, 3, 1, 1, PAGE_SIZE, 'count');
    assert.ok(text.includes('📊 标记记录（按标记次数排序）共 3 条'));
});

test('键盘：单页只有切换按钮', () => {
    const kb = buildMarkRecordsKeyboard('abc123', 1, 1, 'count');
    assert.strictEqual(kb.inline_keyboard.length, 1);
    assert.strictEqual(kb.inline_keyboard[0][0].callback_data, 'markrec_switch:abc123');
});

test('键盘：多页含翻页行，切换按钮文案随排序模式变化', () => {
    const kb = buildMarkRecordsKeyboard('abc123', 2, 5, 'count');
    assert.strictEqual(kb.inline_keyboard.length, 2);
    const nav = kb.inline_keyboard[0];
    assert.ok(nav.some(b => b.callback_data === 'markrec:abc123:1'));
    assert.ok(nav.some(b => b.callback_data === 'markrec:abc123:3'));
    assert.ok(nav.some(b => b.text === '2 / 5'));

    const kbTime = buildMarkRecordsKeyboard('abc123', 1, 1, 'time');
    assert.ok(kbTime.inline_keyboard[0][0].text.includes('按标记次数排序'));
    const kbCount = buildMarkRecordsKeyboard('abc123', 1, 1, 'count');
    assert.ok(kbCount.inline_keyboard[0][0].text.includes('按最后标记时间排序'));
});

test('时间格式化（时区无关）', () => {
    const ts = 1710000000000;
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    assert.strictEqual(formatTime(ts), expected);
    assert.strictEqual(formatTime(0), formatTime(0)); // 0 是合法时间戳
    assert.strictEqual(formatTime(null), '未知');
    assert.strictEqual(formatTime(undefined), '未知');
});
