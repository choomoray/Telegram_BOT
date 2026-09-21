// tests/atlasWhitelist.test.js
/**
 * Atlas 白名单自动维护（utils/atlasAccessList.js）
 *
 * 覆盖：
 *   - 错误分类：白名单/超时类 → 候选；DNS 失败与非网络错误 → 不候选；
 *   - Digest 认证头（用 RFC 2617 的样例值校验 response）；
 *   - 401 → 带 Digest 重发；
 *   - 主流程：取出口 IP → 加**临时**条目（deleteAfterDate = 现在 + 7 天）→ 等到 ACTIVE → 通知管理员；
 *   - 已被现有条目（含 0.0.0.0/0）覆盖时不重复添加；
 *   - 冷却：短时间内重复调用不再打 Atlas API；
 *   - CIDR 覆盖判定（IPv4/IPv6）。
 *
 * 全部用注入的假 HTTP 层，不真连网、不真调 Atlas。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const root = path.join(__dirname, '..');
const { installBotStub, installLoggerStub, relaxTimers } = require('./helpers/memoryDb');

relaxTimers();
const { bot } = installBotStub(root);
installLoggerStub(root);

const config = require('../config');
const atlas = require('../utils/atlasAccessList');

const PROJECT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PUBLIC_KEY = 'PUBKEY';
const PRIVATE_KEY = 'PRIVKEY';
// 运行状态通知的收件会话（用户指定的话题群；与 .env 默认值一致）
const NOTIFY_CHAT = -1002223278475;
const NOTIFY_THREAD = 85;

/** 配好 Atlas 凭据（每个用例开始时调用） */
function configureAtlas(extra = {}) {
    Object.assign(config, {
        ATLAS_PROJECT_ID: PROJECT_ID,
        ATLAS_PUBLIC_KEY: PUBLIC_KEY,
        ATLAS_PRIVATE_KEY: PRIVATE_KEY,
        ATLAS_API_BASE: 'https://cloud.mongodb.com',
        ATLAS_WHITELIST_TTL_DAYS: 7,
        ATLAS_WHITELIST_COOLDOWN_MS: 600000,
        ATLAS_IP_LOOKUP_URLS: ['https://ip.test'],
        ATLAS_API_TIMEOUT_MS: 5000,
        ADMIN_CHAT_IDS: [12345],
        STARTUP_NOTIFY_CHAT_ID: NOTIFY_CHAT,
        STARTUP_NOTIFY_THREAD_ID: NOTIFY_THREAD,
        ...extra
    });
    atlas.resetStateForTests();
}

/** 记录收到的状态通知（含发往的会话与话题）；返回数组 */
function trackAdminMessages() {
    const sent = [];
    bot.sendMessage = async (chatId, text, opts) => {
        sent.push({ chatId, text, opts: opts || {} });
        return { message_id: sent.length, chat: { id: chatId } };
    };
    return sent;
}

/**
 * 假 Atlas/回显服务：按 URL 与 method 返回预设响应
 * @param {Object} opts
 *   - ip: 回显服务返回的 IP
 *   - accessList: 依次返回的列表（数组的数组）
 *   - onCreate: 断言/记录 POST 的 body
 */
function fakeHttp({ ip = '203.0.113.7', lists = [[]], onCreate, onRequest } = {}) {
    let listIdx = 0;
    const requests = [];
    atlas.__setHttpRequestForTests(async (url, { method = 'GET', headers = {}, body = null } = {}) => {
        requests.push({ url, method, headers, body });
        if (onRequest) onRequest({ url, method, headers, body });

        if (url.includes('ip.test')) {
            return { statusCode: 200, headers: {}, body: JSON.stringify({ ip }) };
        }
        if (!url.includes('/accessList')) {
            throw new Error(`未预期的请求: ${method} ${url}`);
        }
        if (method === 'GET') {
            const list = lists[Math.min(listIdx, lists.length - 1)];
            listIdx++;
            return { statusCode: 200, headers: {}, body: JSON.stringify({ results: list, totalCount: list.length }) };
        }
        if (method === 'POST') {
            if (onCreate) onCreate(JSON.parse(body));
            return { statusCode: 201, headers: {}, body: JSON.stringify({ results: JSON.parse(body) }) };
        }
        throw new Error(`未预期的方法: ${method}`);
    });
    return requests;
}

const ACTIVE_ENTRY = (ip, extra = {}) => ({ ipAddress: `${ip}/32`, status: 'ACTIVE', ...extra });
const PENDING_ENTRY = (ip, extra = {}) => ({ ipAddress: `${ip}/32`, status: 'PENDING', ...extra });

// ---------------- 错误分类 ----------------

test('classifyDbError：Atlas 丢包/白名单类错误判为候选，DNS 与非网络错误不候选', () => {
    const whitelist = atlas.classifyDbError(new Error('MongoServerSelectionError: connect ETIMEDOUT 3.4.5.6:27017'));
    assert.strictEqual(whitelist.candidate, true);
    assert.match(whitelist.reason, /网络|白名单/);

    const explicit = atlas.classifyDbError(new Error('not allowed to access this cluster (IP address is not in the access list)'));
    assert.strictEqual(explicit.candidate, true);

    // 实测形态：白名单没放行时 Atlas 在 TLS 层打回（不是 ETIMEDOUT），也必须能识别
    const tlsAlert = atlas.classifyDbError(new Error(
        '28520000:error:0A000438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error:openssl\\ssl\\record\\rec_layer_s3.c:918:SSL alert number 80'
    ));
    assert.strictEqual(tlsAlert.candidate, true, 'SSL alert 形态同样要触发白名单自救');

    const dns = atlas.classifyDbError(new Error('querySrv ENOTFOUND _mongodb._tcp.cluster.mongodb.net'));
    assert.strictEqual(dns.candidate, false, 'DNS 失败加白名单没用');

    const other = atlas.classifyDbError(new Error('E11000 duplicate key error collection: media'));
    assert.strictEqual(other.candidate, false);

    assert.strictEqual(atlas.classifyDbError(null).candidate, false);
});

// ---------------- Digest 认证（RFC 2617 样例） ----------------

test('buildDigestAuthHeader：与 RFC 2617 样例的 response 一致（MD5 + qop=auth）', () => {
    const challenge = atlas.parseDigestChallenge(
        'Digest realm="testrealm@host.com", qop="auth", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"'
    );
    const header = atlas.buildDigestAuthHeader({
        username: 'Mufasa',
        password: 'Circle Of Life',
        method: 'GET',
        uri: '/dir/index.html',
        challenge,
        cnonce: '0a4f113b',
        nc: '00000001'
    });
    assert.match(header, /^Digest /);
    assert.match(header, /username="Mufasa"/);
    assert.match(header, /response="6629fae49393a05397450978507c4ef1"/, 'RFC 2617 §3.5 的预期 response');
    assert.match(header, /qop=auth/);
    assert.match(header, /nc=00000001/);
    assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test('atlasRequest：先发无认证请求，401 后带 Digest 重发（Atlas API Key 流程）', async () => {
    configureAtlas();
    const calls = [];
    atlas.__setHttpRequestForTests(async (url, { method, headers }) => {
        calls.push({ url, method, auth: headers.Authorization || null });
        if (calls.length === 1) {
            return {
                statusCode: 401,
                headers: { 'www-authenticate': 'Digest realm="cloud.mongodb.com", nonce="abc123", qop="auth"' },
                body: 'Unauthorized'
            };
        }
        return { statusCode: 200, headers: {}, body: '{"results":[]}' };
    });

    const entries = await atlas.listAccessList();
    assert.deepStrictEqual(entries, []);
    assert.strictEqual(calls.length, 2, '应重发一次');
    assert.strictEqual(calls[0].auth, null);
    assert.match(calls[1].auth, /^Digest username="PUBKEY"/);
    assert.match(calls[1].url, new RegExp(`/groups/${PROJECT_ID}/accessList`));
});

test('addTemporaryEntry：被 Atlas 的 7 天上限拒绝（本机时钟偏快）时自动退让到 6.5 天重试', async () => {
    configureAtlas();
    const posted = [];
    let calls = 0;
    atlas.__setHttpRequestForTests(async (url, { method, body }) => {
        if (method !== 'POST') throw new Error('只应发生 POST');
        calls++;
        posted.push(JSON.parse(body)[0]);
        if (calls === 1) {
            // 真实踩到过的报错
            return {
                statusCode: 400,
                headers: {},
                body: JSON.stringify({
                    detail: 'The specified expiration date can be at most 7 days in the future.',
                    error: 400, errorCode: 'EXPIRATION_DATE_EXCEEDS_MAX', parameters: [7], reason: 'Bad Request'
                })
            };
        }
        return { statusCode: 201, headers: {}, body: body };
    });

    const res = await atlas.addTemporaryEntry('203.0.113.7');
    assert.strictEqual(res.created, true);
    assert.strictEqual(calls, 2, '应退让重试一次');
    const firstDays = (Date.parse(posted[0].deleteAfterDate) - Date.now()) / 86400000;
    const secondDays = (Date.parse(posted[1].deleteAfterDate) - Date.now()) / 86400000;
    assert.ok(firstDays <= 7 && firstDays > 6.9);
    assert.ok(secondDays < 6.6 && secondDays > 6.4, `退让后应约 6.5 天，实际 ${secondDays.toFixed(3)}`);
});

test('describeAtlasError：401/403 提示指向 API Key 的 API Access List（且说明不能填 0.0.0.0/0）', async () => {
    const hint = atlas.describeAtlasError(403, '{"detail":"IP_ADDRESS_NOT_ON_ACCESS_LIST"}');
    assert.match(hint, /API Access List/);
    assert.match(hint, /0\.0\.0\.0\/0/);

    // listAccessList 里 403 要把提示带出来（管理员通知/日志里能直接看懂）
    configureAtlas();
    atlas.__setHttpRequestForTests(async () => ({ statusCode: 403, headers: {}, body: 'IP_ADDRESS_NOT_ON_ACCESS_LIST' }));
    await assert.rejects(() => atlas.listAccessList(), /API Access List/);

    assert.match(atlas.describeAtlasError(500, 'boom'), /HTTP 500: boom/);
});

// ---------------- 主流程 ----------------
test('ensureIpWhitelisted：加临时条目（7 天后到期）→ 等到 ACTIVE → 通知管理员', async () => {
    configureAtlas();
    const admin = trackAdminMessages();
    const created = [];
    // 第一次查列表：空；加完后查：PENDING → ACTIVE
    fakeHttp({
        ip: '203.0.113.7',
        lists: [[], [PENDING_ENTRY('203.0.113.7')], [ACTIVE_ENTRY('203.0.113.7', { deleteAfterDate: '2026-09-23T00:00:00.000Z' })]],
        onCreate: (body) => created.push(...body)
    });

    const before = Date.now();
    const result = await atlas.ensureIpWhitelisted({ trigger: 'unit-test', waitMs: 3000, pollMs: 1 });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.ip, '203.0.113.7');
    assert.strictEqual(result.added, true);
    assert.strictEqual(result.active, true);

    // 临时条目：ipAddress 带 /32、comment、deleteAfterDate = 现在 + 7 天（留了几分钟余量）
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].ipAddress, '203.0.113.7/32');
    assert.match(created[0].comment, /temporary 7d/);
    const expireAt = Date.parse(created[0].deleteAfterDate);
    assert.ok(Number.isFinite(expireAt), 'deleteAfterDate 必须是合法时间');
    const days = (expireAt - before) / (24 * 60 * 60 * 1000);
    assert.ok(days > 6.9, `约 7 天，实际 ${days.toFixed(3)} 天`);
    assert.ok(days <= 7, `不能超过 Atlas 的 7 天上限（实测正好 7 天会被拒），实际 ${days.toFixed(3)} 天`);

    assert.strictEqual(admin.length, 1);
    assert.match(admin[0].text, /203\.0\.113\.7/);
    assert.match(admin[0].text, /临时条目|白名单/);
    // 用户要求：数据库连不上这类**运行状态**消息发到通知群话题，不再私聊管理员
    assert.strictEqual(admin[0].chatId, NOTIFY_CHAT, '应发到通知群，而不是 ADMIN_CHAT_IDS 私聊');
    assert.strictEqual(admin[0].opts.message_thread_id, NOTIFY_THREAD, '发到指定话题');
    assert.ok(!admin.some(m => m.chatId === 12345), '不得再私聊管理员');
});

test('数据库连不上：没配通知群时退回私聊管理员（老部署行为不变）', async () => {
    configureAtlas({ STARTUP_NOTIFY_CHAT_ID: 0, STARTUP_NOTIFY_THREAD_ID: 0 });
    const admin = trackAdminMessages();
    fakeHttp({
        ip: '203.0.113.9',
        lists: [[], [ACTIVE_ENTRY('203.0.113.9', { deleteAfterDate: '2026-09-23T00:00:00.000Z' })]]
    });

    const result = await atlas.ensureIpWhitelisted({ trigger: 'fallback-test', waitMs: 2000, pollMs: 1 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(admin.length, 1);
    assert.strictEqual(admin[0].chatId, 12345, '未配置通知群 → 私聊管理员');
    assert.strictEqual(admin[0].opts.message_thread_id, undefined, '私聊不带话题 ID');
});

test('ensureIpWhitelisted：已被现有条目覆盖（含 0.0.0.0/0）时不重复添加', async () => {
    configureAtlas();
    const admin = trackAdminMessages();
    let posted = 0;
    fakeHttp({
        ip: '203.0.113.7',
        lists: [[{ cidrBlock: '0.0.0.0/0', status: 'ACTIVE', comment: 'allow all' }]],
        onCreate: () => { posted++; }
    });

    const result = await atlas.ensureIpWhitelisted({ trigger: 'unit-test', waitMs: 500, pollMs: 1 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.added, false);
    assert.strictEqual(result.alreadyAllowed, true);
    assert.strictEqual(posted, 0, '已覆盖就不该再 POST');
    assert.strictEqual(admin.length, 1);
    assert.match(admin[0].text, /已覆盖|现有条目/);
});

test('ensureIpWhitelisted：冷却期内重复调用直接跳过，不打 Atlas API', async () => {
    configureAtlas();
    trackAdminMessages();
    let requests = 0;
    atlas.__setHttpRequestForTests(async (url) => {
        requests++;
        if (url.includes('ip.test')) return { statusCode: 200, headers: {}, body: '203.0.113.7' };
        return { statusCode: 200, headers: {}, body: JSON.stringify({ results: [{ ipAddress: '203.0.113.7/32', status: 'ACTIVE' }] }) };
    });

    const first = await atlas.ensureIpWhitelisted({ trigger: 't1', waitMs: 200, pollMs: 1 });
    assert.strictEqual(first.ok, true);
    const afterFirst = requests;

    const second = await atlas.ensureIpWhitelisted({ trigger: 't2' });
    assert.strictEqual(second.skipped, true);
    assert.match(second.reason, /冷却/);
    assert.strictEqual(requests, afterFirst, '冷却期内不应再发请求');

    // force 可绕过冷却
    const third = await atlas.ensureIpWhitelisted({ trigger: 't3', force: true, waitMs: 200, pollMs: 1 });
    assert.strictEqual(third.ok, true);
    assert.ok(requests > afterFirst);
});

test('ensureIpWhitelisted：未配置凭据时明确跳过（不报错）', async () => {
    configureAtlas({ ATLAS_PROJECT_ID: '', ATLAS_PUBLIC_KEY: '', ATLAS_PRIVATE_KEY: '' });
    const result = await atlas.ensureIpWhitelisted({ trigger: 'unit-test' });
    assert.strictEqual(result.skipped, true);
    assert.match(result.reason, /未配置/);
});

test('getPublicIp：回显服务依次降级（纯文本与 JSON 都能解析）', async () => {
    configureAtlas({ ATLAS_IP_LOOKUP_URLS: ['https://bad.test', 'https://text.test', 'https://json.test'] });
    atlas.__setHttpRequestForTests(async (url) => {
        if (url.includes('bad.test')) return { statusCode: 500, headers: {}, body: 'oops' };
        if (url.includes('text.test')) return { statusCode: 200, headers: {}, body: '198.51.100.9\n' };
        return { statusCode: 200, headers: {}, body: '{"ip":"203.0.113.1"}' };
    });
    assert.strictEqual(await atlas.getPublicIp(), '198.51.100.9', '文本回显要能解析');

    atlas.__setHttpRequestForTests(async () => ({ statusCode: 200, headers: {}, body: '{"ip":"203.0.113.1"}' }));
    assert.strictEqual(await atlas.getPublicIp(), '203.0.113.1', 'JSON 回显要能解析');

    assert.strictEqual(atlas.extractIp('not-an-ip'), null);
});

test('getPublicIp：全部失败时报错并带上每个服务的原因', async () => {
    configureAtlas({ ATLAS_IP_LOOKUP_URLS: ['https://a.test', 'https://b.test'] });
    atlas.__setHttpRequestForTests(async () => ({ statusCode: 503, headers: {}, body: '' }));
    await assert.rejects(() => atlas.getPublicIp(), /获取出口 IP 失败.*a\.test.*b\.test/s);
});

// ---------------- CIDR 覆盖判定 ----------------

test('cidrContains：IPv4 / IPv6 网段覆盖判定', () => {
    assert.strictEqual(atlas.cidrContains('0.0.0.0/0', '203.0.113.7'), true, '0.0.0.0/0 覆盖任意 IPv4');
    assert.strictEqual(atlas.cidrContains('203.0.113.0/24', '203.0.113.7'), true);
    assert.strictEqual(atlas.cidrContains('203.0.113.8/32', '203.0.113.7'), false);
    assert.strictEqual(atlas.cidrContains('203.0.113.7', '203.0.113.7'), true, '不带掩码按单 IP 处理');
    assert.strictEqual(atlas.cidrContains('::/0', '2001:db8::1'), true, '::/0 覆盖任意 IPv6');
    assert.strictEqual(atlas.cidrContains('2001:db8::/32', '2001:db8:1::5'), true);
    assert.strictEqual(atlas.cidrContains('0.0.0.0/0', '2001:db8::1'), false, 'IPv4 段不覆盖 IPv6');
    assert.strictEqual(atlas.cidrContains('::/0', '203.0.113.7'), false);
    assert.strictEqual(atlas.cidrContains('garbage', '203.0.113.7'), false);
});

test('findCoveringEntry / entryValue：cidrBlock 与 ipAddress 都认', () => {
    const entries = [
        { cidrBlock: '10.0.0.0/8', status: 'ACTIVE' },
        { ipAddress: '203.0.113.7/32', status: 'PENDING' }
    ];
    assert.strictEqual(atlas.entryValue(atlas.findCoveringEntry(entries, '203.0.113.7')), '203.0.113.7/32');
    assert.strictEqual(atlas.findCoveringEntry(entries, '198.51.100.1'), null);
    assert.strictEqual(atlas.isEntryActive({ status: 'ACTIVE' }), true);
    assert.strictEqual(atlas.isEntryActive({ status: 'PENDING' }), false);
    assert.strictEqual(atlas.isEntryActive({}), true, 'v1 无 status 视为已生效');
});
