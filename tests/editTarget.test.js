// tests/editTarget.test.js
/**
 * 编辑目标位置解析回归测试
 *
 * 规则（Telegram 机制）：
 *   - 频道发布媒体会自动转发一份到绑定的讨论群组 → 库里同时有 channel / group 两个位置；
 *     频道源消息才是机器人能改的那条（/send 到频道），改它会自动同步到群里的转发副本；
 *   - 只有群组位置的媒体（群里直接收录/发送）直接改群组消息；
 *   - 位置类错误（不可编辑 / 消息不存在）才降级换下一个位置，其他错误（如 HTML 解析失败）直接抛出。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const root = path.join(__dirname, '..');
const { installLoggerStub } = require('./helpers/memoryDb');
installLoggerStub(root);

const {
    isEditTargetError,
    resolveEditTargets,
    editCaptionWithFallback
} = require('../utils/editTarget');

test('resolveEditTargets：双位置（频道 → 讨论群转发）优先频道源位置，其次群组', () => {
    const targets = resolveEditTargets({
        group_id: '-100_1',
        message_id: 11,
        group: { chat_id: -100, message_id: 11 },
        channel: { chat_id: -200, message_id: 9 }
    });
    assert.deepStrictEqual(targets, [
        { chatId: -200, messageId: 9, via: 'channel' },
        { chatId: -100, messageId: 11, via: 'group' }
    ]);
});

test('resolveEditTargets：群组来源的媒体直接改群组位置', () => {
    const targets = resolveEditTargets({
        group_id: '-100_1',
        message_id: 11,
        group: { chat_id: -100, message_id: 11 },
        channel: null
    });
    assert.deepStrictEqual(targets, [{ chatId: -100, messageId: 11, via: 'group' }]);
});

test('resolveEditTargets：仅频道位置 → 频道；旧数据仅有 message_id → 用 group_id 前缀兜底', () => {
    assert.deepStrictEqual(
        resolveEditTargets({ group_id: '-200_1', message_id: 9, channel: { chat_id: '-200', message_id: '9' } }),
        [{ chatId: -200, messageId: 9, via: 'channel' }]
    );
    assert.deepStrictEqual(
        resolveEditTargets({ group_id: '-1005_777', message_id: 42 }, -1005),
        [{ chatId: -1005, messageId: 42, via: 'top' }]
    );
});

test('isEditTargetError：区分「位置不可用」与其他错误', () => {
    assert.strictEqual(isEditTargetError(new Error("ETELEGRAM: 400 Bad Request: message can't be edited")), true);
    assert.strictEqual(isEditTargetError(new Error('ETELEGRAM: 400 Bad Request: message to edit not found')), true);
    assert.strictEqual(isEditTargetError(new Error('ETELEGRAM: 400 Bad Request: can\'t parse entities')), false);
});

test('editCaptionWithFallback：频道失败时降级群组，成功位置被返回', async () => {
    const targets = resolveEditTargets({
        group_id: '-100_1',
        group: { chat_id: -100, message_id: 11 },
        channel: { chat_id: -200, message_id: 9 }
    });
    const tried = [];
    const edited = await editCaptionWithFallback(targets, async (t) => {
        tried.push(`${t.chatId}/${t.messageId}`);
        if (t.via === 'channel') throw new Error("ETELEGRAM: 400 Bad Request: message can't be edited");
    });
    assert.deepStrictEqual(tried, ['-200/9', '-100/11']);
    assert.strictEqual(edited.via, 'group');
});

test('editCaptionWithFallback：全部位置都不可编辑时抛出最后一次错误；非位置错误立即抛出', async () => {
    const targets = resolveEditTargets({
        group_id: '-100_1',
        group: { chat_id: -100, message_id: 11 },
        channel: { chat_id: -200, message_id: 9 }
    });

    let tried = [];
    await assert.rejects(
        () => editCaptionWithFallback(targets, async (t) => {
            tried.push(t.via);
            throw new Error("ETELEGRAM: 400 Bad Request: message can't be edited");
        }),
        /can't be edited/
    );
    assert.deepStrictEqual(tried, ['channel', 'group']);

    tried = [];
    await assert.rejects(
        () => editCaptionWithFallback(targets, async (t) => {
            tried.push(t.via);
            throw new Error('ETELEGRAM: 400 Bad Request: can\'t parse entities');
        }),
        /parse entities/
    );
    assert.deepStrictEqual(tried, ['channel'], '解析错误不应触发位置降级');
});
