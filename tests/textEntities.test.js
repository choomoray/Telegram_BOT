// tests/textEntities.test.js
/**
 * utils/textEntities.js —— 编辑正文时「严格保留用户发送的文本格式」的纯函数工具
 *   - projectEntities：正文被截取（去 `/edit@Bot ` 前缀 / 去首尾空白 / 去 #X 后缀）后
 *     entities 的偏移量必须跟着平移、越界的裁掉
 *   - captionEntities：caption 只接受一部分实体类型，其余要在编辑 caption 前过滤
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
    normalizeEntities,
    shiftEntities,
    projectEntities,
    captionEntities,
    CAPTION_ENTITY_TYPES
} = require('../utils/textEntities');

// ---------------- normalizeEntities ----------------

test('normalizeEntities：丢弃非法项、按位置排序、不改动入参', () => {
    const input = [
        { type: 'italic', offset: 5, length: 2 },
        { type: 'bold', offset: 0, length: 3 },
        { type: 'x', offset: -1, length: 2 },      // 负偏移
        { type: 'x', offset: 0, length: 0 },       // 零长度
        { type: 'x', offset: 'a', length: 2 },     // 非数字
        { offset: 1, length: 1 },                  // 没有 type
        null
    ];
    const out = normalizeEntities(input);
    assert.deepStrictEqual(out, [
        { type: 'bold', offset: 0, length: 3 },
        { type: 'italic', offset: 5, length: 2 }
    ]);
    assert.strictEqual(input.length, 7, '入参不被改动');
    assert.deepStrictEqual(normalizeEntities(null), []);
    assert.deepStrictEqual(normalizeEntities([]), []);
});

// ---------------- shiftEntities ----------------

test('shiftEntities：按已知起始下标平移（正文与命令前缀字符重合也不会错位）', () => {
    // '/edit@SexFavoritesBOT BOT' —— 正文 'BOT' 出现在下标 22，而不是 indexOf 找到的 18
    const entities = [{ type: 'bold', offset: 22, length: 3 }];
    assert.deepStrictEqual(shiftEntities(entities, 22, 3), [{ type: 'bold', offset: 0, length: 3 }]);
});

test('shiftEntities：越界裁剪、全越界丢弃、空长度返回空数组', () => {
    const entities = [{ type: 'bold', offset: 10, length: 5 }];
    assert.deepStrictEqual(shiftEntities(entities, 12, 10), [{ type: 'bold', offset: 0, length: 3 }], '左侧裁掉');
    assert.deepStrictEqual(shiftEntities(entities, 20, 5), [], '完全在新文本之前 → 丢弃');
    assert.deepStrictEqual(shiftEntities(entities, 0, 0), []);
    assert.deepStrictEqual(shiftEntities(null, 0, 5), []);
});

// ---------------- projectEntities ----------------

test('projectEntities：原文与截取文本相同时原样返回', () => {
    const entities = [{ type: 'bold', offset: 0, length: 3 }];
    assert.deepStrictEqual(projectEntities(entities, '新正文', '新正文'), entities);
});

test('projectEntities：去掉命令前缀后偏移量前移，命令自身的 bot_command 被丢掉', () => {
    const raw = '/edit@MyBot 加粗正文';
    const entities = [
        { type: 'bot_command', offset: 0, length: 11 },
        { type: 'bold', offset: 12, length: 4 }
    ];
    assert.deepStrictEqual(projectEntities(entities, raw, '加粗正文'), [
        { type: 'bold', offset: 0, length: 4 }
    ]);
});

test('projectEntities：去首尾空白 / 去 #X 后缀后偏移量随之平移', () => {
    const raw = '  斜体文本 #A';
    // 斜体覆盖「斜体文本」四个字（前面有 2 个空格）
    const entities = [{ type: 'italic', offset: 2, length: 4 }];
    assert.deepStrictEqual(projectEntities(entities, raw, '斜体文本'), [
        { type: 'italic', offset: 0, length: 4 }
    ]);
});

test('projectEntities：部分越界的实体被裁剪，完全越界的丢弃', () => {
    const raw = '/edit 正文结尾';
    const entities = [
        { type: 'bold', offset: 0, length: 8 },     // 跨过前缀 → 裁成 0..2
        { type: 'italic', offset: 20, length: 3 }   // 完全越界 → 丢弃
    ];
    assert.deepStrictEqual(projectEntities(entities, raw, '正文结尾'), [
        { type: 'bold', offset: 0, length: 2 }
    ]);
});

test('projectEntities：截取文本对不上（不是子串）或为空时返回空数组，绝不给出错位的实体', () => {
    const entities = [{ type: 'bold', offset: 0, length: 2 }];
    assert.deepStrictEqual(projectEntities(entities, '原文', '完全不同的文本'), []);
    assert.deepStrictEqual(projectEntities(entities, '原文', ''), []);
    assert.deepStrictEqual(projectEntities(entities, '', '原文'), []);
    assert.deepStrictEqual(projectEntities(null, '原文', '原文'), []);
});

test('projectEntities：保留实体的附加字段（text_link 的 url、pre 的 language）', () => {
    const raw = '看这个链接';
    const entities = [{ type: 'text_link', offset: 0, length: 5, url: 'https://example.com' }];
    assert.deepStrictEqual(projectEntities(entities, raw, '链接'), [
        { type: 'text_link', offset: 0, length: 2, url: 'https://example.com' }
    ]);
});

// ---------------- captionEntities ----------------

test('captionEntities：只保留 caption 支持的实体类型，其余（自动识别类型）过滤掉', () => {
    const entities = [
        { type: 'bold', offset: 0, length: 2 },
        { type: 'text_link', offset: 2, length: 2, url: 'https://x' },
        { type: 'custom_emoji', offset: 4, length: 2, custom_emoji_id: '1' },
        { type: 'mention', offset: 6, length: 4 },
        { type: 'url', offset: 10, length: 5 },
        { type: 'hashtag', offset: 15, length: 3 },
        { type: 'bot_command', offset: 18, length: 4 }
    ];
    const out = captionEntities(entities);
    assert.deepStrictEqual(out.map(e => e.type), ['bold', 'text_link', 'custom_emoji']);
    assert.ok(CAPTION_ENTITY_TYPES.has('blockquote') && !CAPTION_ENTITY_TYPES.has('url'));
    assert.deepStrictEqual(captionEntities(null), []);
});
