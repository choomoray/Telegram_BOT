// tests/linkHealth.test.js
/**
 * 收录链接活性判定（无需网络：注入假 Bot API）
 *
 * 重点回归：
 *   - 机器人通常并不在搬运来源频道里，直接 getChat(chat_id) 会返回 "chat not found"，
 *     旧实现把它当成"链接失效"，导致所有公开频道被误报 ❌；现在应先按链接里的 @username 探测。
 *   - 429 限流不能被当成失效（返回 unknown + retry_after）。
 *   - 私有/消息链接（t.me/c/... ）在机器人无权验证时只能是 unknown，不能判死。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
    checkTransportLink,
    publicUsernameOf,
    rateLimitRetryAfter,
    isDeadError,
    isTransientError,
    transportLinkUrl
} = require('../utils/linkHealth');

/** 构造 node-telegram-bot-api 风格错误 */
function tgError(status, description, retryAfter) {
    const body = { ok: false, error_code: status, description };
    if (retryAfter !== undefined) body.parameters = { retry_after: retryAfter };
    const err = new Error(`ETELEGRAM: ${status} ${description}`);
    err.response = { statusCode: status, body };
    return err;
}

/** 假 Bot API */
function fakeApi({ getChat, getChatMember, meId = 99 } = {}) {
    return {
        getMe: async () => ({ id: meId, username: 'test_bot' }),
        getChat: getChat || (async () => ({ id: -100, type: 'channel', title: '测试频道', username: 'testchan' })),
        getChatMember: getChatMember || (async () => ({ status: 'administrator' }))
    };
}

// ---------------- 纯函数 ----------------

test('publicUsernameOf：只认 t.me/<username>，不认 t.me/c 与邀请链接', () => {
    assert.strictEqual(publicUsernameOf('https://t.me/beauty_feeling/3'), 'beauty_feeling');
    assert.strictEqual(publicUsernameOf('https://t.me/BBC_Asia'), 'BBC_Asia');
    assert.strictEqual(publicUsernameOf('https://t.me/hwhentworld/3?single'), 'hwhentworld');
    assert.strictEqual(publicUsernameOf('https://t.me/c/1980542381/2094'), null);
    assert.strictEqual(publicUsernameOf('https://t.me/joinchat/AAAA'), null);
    assert.strictEqual(publicUsernameOf(''), null);
    assert.strictEqual(publicUsernameOf(null), null);
});

test('rateLimitRetryAfter：从 response.body.parameters 或消息里取重试秒数', () => {
    assert.strictEqual(rateLimitRetryAfter(tgError(429, 'Too Many Requests: retry after 19', 19)), 19);
    assert.strictEqual(rateLimitRetryAfter(tgError(429, 'Too Many Requests: retry after 7')), 7);
    assert.strictEqual(rateLimitRetryAfter(tgError(400, 'chat not found')), null);
});

test('429 属于临时错误、不属于失效', () => {
    const err = tgError(429, 'Too Many Requests: retry after 5', 5);
    assert.strictEqual(isTransientError(err), true);
    assert.strictEqual(isDeadError(err), false, '限流绝不能被判成链接失效');
    assert.strictEqual(isDeadError(tgError(400, 'Bad Request: chat not found')), true);
});

// ---------------- 公开链接：机器人不在频道里也要判活 ----------------

test('公开链接：按 @username 解析成功 → ok（即使机器人不在该频道）', async () => {
    const api = fakeApi({
        getChat: async (target) => {
            if (String(target).startsWith('@')) return { id: -1002025220161, type: 'channel', title: '真实标题' };
            throw tgError(400, 'Bad Request: chat not found'); // 按 chat_id 查必然失败（机器人不在里面）
        }
    });
    const r = await checkTransportLink({ chat_id: -1002025220161, chat_name: '旧名', url: 'https://t.me/beauty_feeling/3' }, { bot: api });
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.chat_name, '真实标题');
});

test('公开链接：@username 解析失败（chat not found）→ dead', async () => {
    const api = fakeApi({
        getChat: async () => { throw tgError(400, 'Bad Request: chat not found'); }
    });
    const r = await checkTransportLink({ chat_id: -1001338579713, url: 'https://t.me/GenshinOfficialNSFW/7' }, { bot: api });
    assert.strictEqual(r.status, 'dead');
    assert.match(r.error, /GenshinOfficialNSFW/);
});

test('公开链接：429 → unknown（不判失效），带 retry_after', async () => {
    const api = fakeApi({
        getChat: async () => { throw tgError(429, 'Too Many Requests: retry after 18', 18); }
    });
    const r = await checkTransportLink({ chat_id: -1003633826853, url: 'https://t.me/SJAV66' }, { bot: api });
    assert.strictEqual(r.status, 'unknown');
    assert.strictEqual(r.retry_after, 18);
});

test('公开链接：429 且允许重试时，等待后重试一次即可判活', async () => {
    let calls = 0;
    const api = fakeApi({
        getChat: async () => {
            calls++;
            if (calls === 1) throw tgError(429, 'Too Many Requests: retry after 0', 0);
            return { id: -100, type: 'channel', title: '恢复可访问' };
        }
    });
    const r = await checkTransportLink({ chat_id: -100, url: 'https://t.me/retrychan' }, { bot: api, retryOnRateLimit: true });
    assert.strictEqual(calls, 2);
    assert.strictEqual(r.status, 'ok');
});

// ---------------- 私有/消息链接：无权验证 → unknown ----------------

test('私有消息链接：机器人不在会话里 → unknown（不再误判为失效）', async () => {
    const api = fakeApi({
        getChat: async () => { throw tgError(400, 'Bad Request: chat not found'); }
    });
    const r = await checkTransportLink({ chat_id: -1001980542381, url: 'https://t.me/c/1980542381/2094' }, { bot: api });
    assert.strictEqual(r.status, 'unknown');
    assert.match(r.error, /无法验证/);
});

test('私有消息链接：机器人能访问 → ok；能访问但已被踢 → dead', async () => {
    const okApi = fakeApi({ getChat: async () => ({ id: -1001, type: 'channel', title: '能访问' }) });
    const ok = await checkTransportLink({ chat_id: -1001, url: 'https://t.me/c/1001/2' }, { bot: okApi });
    assert.strictEqual(ok.status, 'ok');

    const kickedApi = fakeApi({
        getChat: async () => ({ id: -1001, type: 'channel', title: '能访问' }),
        getChatMember: async () => ({ status: 'kicked' })
    });
    const kicked = await checkTransportLink({ chat_id: -1001, url: 'https://t.me/c/1001/2' }, { bot: kickedApi });
    assert.strictEqual(kicked.status, 'dead');
    assert.match(kicked.error, /不在该会话/);
});

test('缺少 chat_id 与链接 → unknown', async () => {
    const r = await checkTransportLink({}, { bot: fakeApi() });
    assert.strictEqual(r.status, 'unknown');
});

test('transportLinkUrl 仍按原规则推导跳转链接（回归）', () => {
    assert.strictEqual(transportLinkUrl({ chat_id: -1, url: 'https://t.me/x/1' }), 'https://t.me/x/1');
    assert.strictEqual(transportLinkUrl({ chat_id: -1001521978999 }), 'https://t.me/c/1521978999');
    assert.strictEqual(transportLinkUrl({ chat_id: -1002 }), '');
});
