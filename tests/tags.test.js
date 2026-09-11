// tests/tags.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { sortTags } = require('../db/tags');
const { splitTagInput, parseTagInput, matchTagsInText, buildTagRegionKeyboard } = require('../utils/tagUi');

// ---------------- sortTags（标签展示排序） ----------------

test('置顶标签（pin>0）按位置升序排最前，其余按使用次数降序', () => {
    const tags = [
        { name: '普通A', count: 10 },
        { name: '置顶B', pin: 2, count: 1 },
        { name: '普通B', count: 5 },
        { name: '置顶A', pin: 1, count: 3 }
    ];
    const sorted = sortTags(tags);
    assert.deepStrictEqual(sorted.map(t => t.name), ['置顶A', '置顶B', '普通A', '普通B']);
});

test('置顶标签按 pin 位置排序（1=左上第一个按钮），pin 为 0 视为不置顶', () => {
    const tags = [
        { name: '置顶2', pin: 2, count: 0 },
        { name: '普通', count: 50 },
        { name: '置顶1', pin: 1, count: 99 },
        { name: '未置顶', pin: 0, count: 30 }
    ];
    const sorted = sortTags(tags);
    assert.deepStrictEqual(sorted.map(t => t.name), ['置顶1', '置顶2', '普通', '未置顶']);
});

test('次数相同按名称排序', () => {
    const tags = [
        { name: 'b', count: 1 },
        { name: 'a', count: 1 },
        { name: 'c', count: 2 }
    ];
    const sorted = sortTags(tags);
    assert.deepStrictEqual(sorted.map(t => t.name), ['c', 'a', 'b']);
});

test('sortTags 不修改原数组', () => {
    const tags = [{ name: 'a', count: 1 }, { name: 'b', count: 2 }];
    const copy = JSON.parse(JSON.stringify(tags));
    sortTags(tags);
    assert.deepStrictEqual(tags, copy);
});

// ---------------- splitTagInput（手动输入解析） ----------------

test('按空格/、/逗号分隔并去重', () => {
    assert.deepStrictEqual(splitTagInput('图片 教程、高清，风景'), ['图片', '教程', '高清', '风景']);
});

test('大小写去重（保留首现）', () => {
    assert.deepStrictEqual(splitTagInput('HD hd 图片'), ['HD', '图片']);
});

test('空输入返回空数组', () => {
    assert.deepStrictEqual(splitTagInput(''), []);
    assert.deepStrictEqual(splitTagInput(null), []);
    assert.deepStrictEqual(splitTagInput('   '), []);
});

test('splitTagInput 只返回要添加的：-标签 前缀会被忽略', () => {
    assert.deepStrictEqual(splitTagInput('xx -yy'), ['xx']);
    assert.deepStrictEqual(splitTagInput('-yy -zz'), []);
});

// ---------------- parseTagInput（空格分隔多个 + - 前缀移除） ----------------

test('parseTagInput：空格分隔一次添加多个标签', () => {
    assert.deepStrictEqual(parseTagInput('xx yy zz'), { add: ['xx', 'yy', 'zz'], remove: [] });
    assert.deepStrictEqual(parseTagInput('图片 教程、高清，风景'), { add: ['图片', '教程', '高清', '风景'], remove: [] });
    // 换行/多个空格也算分隔
    assert.deepStrictEqual(parseTagInput('  a   b \n c '), { add: ['a', 'b', 'c'], remove: [] });
});

test('parseTagInput：-前缀表示移除', () => {
    assert.deepStrictEqual(parseTagInput('-xx -yy'), { add: [], remove: ['xx', 'yy'] });
    assert.deepStrictEqual(parseTagInput('xx -yy'), { add: ['xx'], remove: ['yy'] });
    assert.deepStrictEqual(parseTagInput('xx yy -zz'), { add: ['xx', 'yy'], remove: ['zz'] });
});

test('parseTagInput：中文输入法全角减号同样识别为移除', () => {
    assert.deepStrictEqual(parseTagInput('xx －yy'), { add: ['xx'], remove: ['yy'] });
    assert.deepStrictEqual(parseTagInput('xx −yy'), { add: ['xx'], remove: ['yy'] });
});

test('parseTagInput：各自去重（大小写不敏感、保留首现）', () => {
    assert.deepStrictEqual(parseTagInput('HD hd -JK -jk'), { add: ['HD'], remove: ['JK'] });
});

test('parseTagInput：同名既写添加又写移除时以移除为准', () => {
    assert.deepStrictEqual(parseTagInput('xx -xx'), { add: [], remove: ['xx'] });
    assert.deepStrictEqual(parseTagInput('-xx xx yy'), { add: ['yy'], remove: ['xx'] });
});

test('parseTagInput：空输入与孤立减号', () => {
    assert.deepStrictEqual(parseTagInput(''), { add: [], remove: [] });
    assert.deepStrictEqual(parseTagInput(null), { add: [], remove: [] });
    assert.deepStrictEqual(parseTagInput('   '), { add: [], remove: [] });
    assert.deepStrictEqual(parseTagInput('- - '), { add: [], remove: [] }, '只有减号没有名字 → 忽略');
});

test('parseTagInput：标签名里的连字符不算移除前缀', () => {
    assert.deepStrictEqual(parseTagInput('jk-2 a-b'), { add: ['jk-2', 'a-b'], remove: [] });
});

// ---------------- matchTagsInText（文本识别标签） ----------------

test('文本中识别已存在的标签', () => {
    const tags = [{ name: '图片' }, { name: '教程' }, { name: 'HD' }];
    assert.deepStrictEqual(matchTagsInText('这是一个图片教程', tags), ['图片', '教程']);
});

test('大小写不敏感识别', () => {
    const tags = [{ name: 'hd' }];
    assert.deepStrictEqual(matchTagsInText('这是HD画质', tags), ['hd']);
});

test('文本不含标签返回空', () => {
    const tags = [{ name: '图片' }];
    assert.deepStrictEqual(matchTagsInText('普通文本', tags), []);
    assert.deepStrictEqual(matchTagsInText('', tags), []);
    assert.deepStrictEqual(matchTagsInText(null, tags), []);
});

// 用户要求：英文标签必须整词命中，不能把单词拆成 h / e / he / el 这样的片段

test('英文标签整词匹配：hello 不会在单词内部被拆出来', () => {
    const tags = [{ name: 'h' }, { name: 'e' }, { name: 'he' }, { name: 'el' }];
    assert.deepStrictEqual(matchTagsInText('hello', tags), [], '单词内部不应匹配出任何片段');
    assert.deepStrictEqual(matchTagsInText('hello world', tags), [], 'he 不能命中 hello');
});

test('英文标签整词匹配：只有完整单词才命中', () => {
    const tags = [{ name: 'hello' }, { name: 'world' }];
    assert.deepStrictEqual(matchTagsInText('hello', tags), ['hello']);
    assert.deepStrictEqual(matchTagsInText('say hello world!', tags), ['hello', 'world']);
    assert.deepStrictEqual(matchTagsInText('helloworld', tags), [], 'helloworld 里没有独立的 hello/world');
    assert.deepStrictEqual(matchTagsInText('hello_world', tags), [], '下划线属于单词字符，不算整词边界');
});

test('英文标签大小写不敏感且支持数字/下划线标签', () => {
    assert.deepStrictEqual(matchTagsInText('这是HD画质', [{ name: 'hd' }]), ['hd'], '中文旁的英文仍是整词');
    assert.deepStrictEqual(matchTagsInText('JK 写真', [{ name: 'jk' }]), ['jk']);
    assert.deepStrictEqual(matchTagsInText('第 2024 期', [{ name: '2024' }]), ['2024']);
    assert.deepStrictEqual(matchTagsInText('第2024期', [{ name: '2024' }]), ['2024'], '中文算词边界');
    assert.deepStrictEqual(matchTagsInText('a_hd_b', [{ name: 'hd' }]), [], '下划线内不命中');
    assert.deepStrictEqual(matchTagsInText('HD-hd', [{ name: 'HD' }]), ['HD'], '连字符是边界，命中');
});

test('中文标签仍按子串匹配（中文没有词边界）', () => {
    const tags = [{ name: '图片' }, { name: '教程' }];
    assert.deepStrictEqual(matchTagsInText('这是一个图片教程', tags), ['图片', '教程']);
    assert.deepStrictEqual(matchTagsInText('高清图片合集', [{ name: '图片' }]), ['图片']);
});

test('中英混合标签按子串匹配（含非 ASCII 字符时不做整词限制）', () => {
    assert.deepStrictEqual(matchTagsInText('这套 HD 高清 图集', [{ name: 'HD 高清' }]), ['HD 高清']);
});

test('含正则元字符的标签不会让匹配崩掉', () => {
    assert.deepStrictEqual(matchTagsInText('价格 (特价) 出售', [{ name: '(特价)' }]), ['(特价)']);
    assert.deepStrictEqual(matchTagsInText('文件 c.d 已上传', [{ name: 'c.d' }]), ['c.d']);
    assert.deepStrictEqual(matchTagsInText('文件 cxd 已上传', [{ name: 'c.d' }]), [], '点号按字面量匹配');
    assert.deepStrictEqual(matchTagsInText('没有这个标签', [{ name: 'a+b' }]), []);
});


test('matchTagsInText 跳过空标签对象', () => {
    assert.deepStrictEqual(matchTagsInText('hello', [null, {}, { name: '' }, { name: 'hello' }]), ['hello']);
});

// ---------------- buildTagRegionKeyboard（两区键盘：上区已有标签 / 下区标签库） ----------------

const LIB = [
    { name: '置顶A', pin: 1, count: 3 },
    { name: '置顶B', pin: 2, count: 1 },
    { name: '普通A', count: 10 },
    { name: '普通B', count: 5 }
];
const flat = kb => kb.inline_keyboard.map(row => row.map(b => b.text));

test('上区为已有标签（✅），下区去掉已打上的非置顶标签、保留已打上的置顶标签', () => {
    const kb = buildTagRegionKeyboard(['普通A', '置顶A'], LIB, {
        prefix: 'sendtag',
        pagePrefix: 'sendtag_page'
    });
    assert.deepStrictEqual(flat(kb), [
        ['✅普通A', '✅置顶A'],
        ['── 已有标签（点击移除） ──'],
        ['✅置顶A', '+置顶B', '+普通B']
    ]);
    // 上区按钮 = 点击移除（与下区共用前缀，由回调按当前状态决定增删）
    assert.strictEqual(kb.inline_keyboard[0][0].callback_data, `sendtag:${encodeURIComponent('普通A')}`);
    assert.strictEqual(kb.inline_keyboard[2][2].callback_data, `sendtag:${encodeURIComponent('普通B')}`);
    // 分隔行只提示，不改变状态
    assert.strictEqual(kb.inline_keyboard[1][0].callback_data, 'tag_noop');
    assert.deepStrictEqual(kb.applied, ['普通A', '置顶A']);
    assert.deepStrictEqual(kb.library.map(t => t.name), ['置顶A', '置顶B', '普通B']);
});

test('没有已有标签时只有下区：全部 + 前缀、不插分隔行', () => {
    const kb = buildTagRegionKeyboard([], LIB, { prefix: 'tagmsg:tag', pagePrefix: 'tagmsg_page' });
    assert.deepStrictEqual(flat(kb), [['+置顶A', '+置顶B', '+普通A', '+普通B']]);
    assert.deepStrictEqual(kb.applied, []);
});

test('已有标签去重，已打上的置顶标签仍留在下区', () => {
    const kb = buildTagRegionKeyboard(['普通A', '普通A', '普通B'], LIB, {
        prefix: 'tagmsg:tag',
        pagePrefix: 'tagmsg_page'
    });
    assert.deepStrictEqual(flat(kb), [
        ['✅普通A', '✅普通B'],
        ['── 已有标签（点击移除） ──'],
        ['+置顶A', '+置顶B']
    ]);
    assert.deepStrictEqual(kb.applied, ['普通A', '普通B']);
    assert.deepStrictEqual(kb.library.map(t => t.name), ['置顶A', '置顶B']);
});

test('下区被过滤空时只剩上区，不插分隔行', () => {
    const kb = buildTagRegionKeyboard(['普通A'], [{ name: '普通A', pin: 0, count: 1 }], {
        prefix: 'tagmsg:tag',
        pagePrefix: 'tagmsg_page'
    });
    assert.deepStrictEqual(flat(kb), [['✅普通A']]);
    assert.deepStrictEqual(kb.library, []);
});

test('上区每行 4 个，超过 4 个换行', () => {
    const applied = ['A', 'B', 'C', 'D', 'E'];
    const kb = buildTagRegionKeyboard(applied, [], { prefix: 'p', pagePrefix: 'pp' });
    assert.deepStrictEqual(flat(kb), [['✅A', '✅B', '✅C', '✅D'], ['✅E']]);
});

test('翻页只作用于下区标签库、上区每页都在', () => {
    const library = Array.from({ length: 45 }, (_, i) => ({
        name: `T${String(i).padStart(2, '0')}`,
        pin: 0,
        count: 45 - i
    }));
    const page1 = buildTagRegionKeyboard(['T00'], library, { prefix: 'p', pagePrefix: 'pp', page: 1 });
    // 上区 1 行 + 分隔行 + 下区 40 个（10 行） + 翻页 1 行
    assert.strictEqual(page1.inline_keyboard.length, 13);
    assert.strictEqual(page1.totalPages, 2);
    assert.strictEqual(page1.inline_keyboard[12][0].text, '1 / 2');
    assert.strictEqual(page1.inline_keyboard[12][1].callback_data, 'pp:2');

    const page2 = buildTagRegionKeyboard(['T00'], library, { prefix: 'p', pagePrefix: 'pp', page: 2 });
    assert.deepStrictEqual(flat(page2)[0], ['✅T00']);
    assert.strictEqual(page2.library.length, 44);
    assert.strictEqual(page2.inline_keyboard[3][0].text, '◀ 上一页');
});

test('extraRows 追加在最后，separator: null 可关闭分隔行', () => {
    const kb = buildTagRegionKeyboard(['普通A'], LIB, {
        prefix: 'p',
        pagePrefix: 'pp',
        separator: null,
        extraRows: [[{ text: '↩️ 返回选择', callback_data: 'back' }]]
    });
    const rows = kb.inline_keyboard;
    assert.strictEqual(rows[rows.length - 1][0].text, '↩️ 返回选择');
    assert.ok(!rows.some(r => r.some(b => b.callback_data === 'tag_noop')));
});
