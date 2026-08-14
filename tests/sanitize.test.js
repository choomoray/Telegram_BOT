// tests/sanitize.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { escapeHTML } = require('../utils/sanitize');

test('转义 HTML 特殊字符', () => {
    assert.strictEqual(escapeHTML('<b>a&b</b>'), '&lt;b&gt;a&amp;b&lt;/b&gt;');
    assert.strictEqual(escapeHTML('"quoted"'), '&quot;quoted&quot;');
});

test('空值返回空字符串', () => {
    assert.strictEqual(escapeHTML(''), '');
    assert.strictEqual(escapeHTML(null), '');
    assert.strictEqual(escapeHTML(undefined), '');
});

test('普通文本原样返回', () => {
    assert.strictEqual(escapeHTML('plain text'), 'plain text');
    assert.strictEqual(escapeHTML('中文 content 123'), '中文 content 123');
});
