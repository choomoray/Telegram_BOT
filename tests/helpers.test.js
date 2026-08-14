// tests/helpers.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { getUserDisplayName } = require('../utils/helpers');

test('优先使用 username', () => {
    assert.strictEqual(getUserDisplayName({ username: 'abc', first_name: 'A', last_name: 'B' }), 'abc');
});

test('无 username 时拼接姓名', () => {
    assert.strictEqual(getUserDisplayName({ first_name: 'A', last_name: 'B' }), 'A B');
    assert.strictEqual(getUserDisplayName({ first_name: 'A' }), 'A');
});

test('空对象回退为未知用户', () => {
    assert.strictEqual(getUserDisplayName({}), '未知用户');
    assert.strictEqual(getUserDisplayName(null), '未知用户');
});
