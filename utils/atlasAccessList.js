// utils/atlasAccessList.js
/**
 * MongoDB Atlas IP 白名单（Project Network Access）自动维护
 *
 * 场景（用户环境）：数据库在 Atlas，机器走代理网络、**出口 IP 经常变**；
 * IP 一变驱动就只是超时（Atlas 对不在白名单的 IP 是**静默丢包**，报错长得跟普通断网一样），
 * 需要人工去控制台加白名单。这里把它自动化：
 *
 *   1. 判定"像是白名单问题"（`classifyDbError`：主机是 mongodb.net + 超时/拒连/服务选择失败）；
 *   2. 取**当前出口 IP**（问外部回显服务，注意不是本机网卡 IP —— 走代理时两者不同）；
 *   3. 查项目访问列表，若当前 IP 已被某条覆盖（含 `0.0.0.0/0`）就直接等它生效；
 *   4. 否则加一条**临时条目**：`deleteAfterDate = 现在 + ATLAS_WHITELIST_TTL_DAYS 天`
 *      —— Atlas 到期自动删除，不需要我们写清理逻辑（用户要求：限期 1 周）；
 *   5. 轮询到该条目 `ACTIVE`（Atlas 应用需要 30~120 秒）后返回，让调用方重连；
 *   6. 全过程记本地日志 + 给管理员发 Telegram 通知（此时**不能**写操作日志：
 *      库本身连不上，写库只会再失败一次）。
 *
 * 前置配置（`.env`，见 .env.example）：
 *   ATLAS_AUTO_WHITELIST=1
 *   ATLAS_PROJECT_ID     项目 ID（Project Settings 里的 24 位十六进制）
 *   ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY   Atlas API Key（走 HTTP Digest 认证）
 *   ⚠️ 这个 API Key 自己的 **API Access List** 要设成 `0.0.0.0/0`（或留空），
 *      否则 IP 一变连"加白名单"这个接口都调不动（鸡生蛋）。
 *
 * 认证：Atlas Admin API v2，API Key 走 HTTP Digest（RFC 2617/7616，MD5 / MD5-sess）。
 * Service Account（OAuth2）暂未实现 —— 需要时在 `atlasRequest` 里加 Bearer 分支即可。
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const config = require('../config');
const logger = require('../logger');

// ---------------- 可注入的 HTTP 实现（测试用） ----------------

/**
 * 默认 HTTP 请求实现：node 内置 http/https，无第三方依赖。
 * 注：本项目机器上 Node 直连外网即走代理（系统级），因此这里不额外处理代理隧道；
 * 若将来自检发现"回显到的 IP ≠ Atlas 看到的 IP"，把 ATLAS_IP_LOOKUP_URLS 换成
 * 能回显代理出口 IP 的服务即可。
 */
function defaultHttpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (err) {
            return reject(new Error(`无效 URL: ${url}`));
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return reject(new Error(`不支持的协议: ${parsed.protocol}`));
        }
        const mod = parsed.protocol === 'http:' ? http : https;
        const timeout = timeoutMs || config.ATLAS_API_TIMEOUT_MS || 15000;
        const req = mod.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
            path: `${parsed.pathname}${parsed.search}`,
            method,
            headers
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });
        req.setTimeout(timeout, () => req.destroy(new Error(`请求超时(${timeout}ms): ${url}`)));
        req.on('error', (err) => reject(err));
        if (body !== null && body !== undefined) req.write(body);
        req.end();
    });
}

let httpRequest = defaultHttpRequest;

/** 仅供测试注入 HTTP 请求实现（传 null 恢复默认） */
function __setHttpRequestForTests(fn) {
    httpRequest = fn || defaultHttpRequest;
}

// ---------------- 错误判定：这次连不上是不是"该加白名单" ----------------

/** 把驱动错误里所有有用的文本拼成一个串（MongoServerSelectionError 的细节藏在 reason / errors 里） */
function errorText(err) {
    const parts = [];
    if (err) {
        if (err.name) parts.push(err.name);
        if (err.code) parts.push(String(err.code));
        if (err.message) parts.push(String(err.message));
        if (Array.isArray(err.errors)) for (const e of err.errors) parts.push(String((e && e.message) || e));
        if (err.reason && typeof err.reason.toString === 'function') parts.push(err.reason.toString());
    }
    return parts.join(' | ');
}

/** 明确的白名单/未授权提示（有这些字样基本可以断定） */
const WHITELIST_HINTS = [
    /not\s+whitelisted/i, /whitelist/i, /access\s*list/i,
    /not\s+allowed\s+to\s+access/i, /ip\s+address[^|]*is\s+not/i,
    /could\s+not\s+connect\s+to\s+any\s+servers/i, /connection\s+refused\s+by\s+peer/i
];

/** 网络层/服务选择失败（Atlas 丢包就是这个形态） */
const NETWORK_HINTS = [
    /server\s*selection/i, /MongoServerSelectionError/i, /MongoNetworkError/i, /MongoTimeoutError/i,
    /ETIMEDOUT/i, /ECONNREFUSED/i, /ECONNRESET/i, /EHOSTUNREACH/i, /ENETUNREACH/i, /EPIPE/i,
    /topology\s+was\s+destroyed/i, /socket\s+closed/i,
    // 实测：出口 IP 不在白名单时，Atlas 会在 TLS 层直接打回，
    // 驱动原样抛出 `...SSL routines:ssl3_read_bytes:tlsv1 alert internal error:SSL alert number 80`
    // （不一定是 ETIMEDOUT）—— 这种形态也必须当作候选，否则本模块在最需要它的场景下不会触发。
    /SSL alert/i, /SSL routines/i, /tlsv1 alert/i, /ssl3_read_bytes/i
];

/** DNS / 域名解析类失败：加白名单没用（Atlas 的 SRV 是公网 DNS，不受白名单影响） */
const DNS_HINTS = [/ENOTFOUND/i, /EAI_AGAIN/i, /querySrv/i, /getaddrinfo/i, /ENODATA/i];

/**
 * 判断驱动错误是否"可能因为出口 IP 不在白名单"。
 * @param {Error|*} err
 * @returns {{candidate:boolean, reason:string, text:string}}
 */
function classifyDbError(err) {
    const text = errorText(err);
    if (!text) return { candidate: false, reason: '空错误信息', text };
    if (DNS_HINTS.some(re => re.test(text))) {
        return { candidate: false, reason: '域名解析/DNS 失败（与白名单无关）', text };
    }
    if (WHITELIST_HINTS.some(re => re.test(text))) {
        return { candidate: true, reason: '白名单/未授权提示', text };
    }
    if (NETWORK_HINTS.some(re => re.test(text))) {
        return { candidate: true, reason: '网络超时或服务选择失败（Atlas 丢包的典型形态）', text };
    }
    return { candidate: false, reason: '非网络类错误', text };
}

// ---------------- IP / CIDR 工具 ----------------

function ipv4ToBigInt(ip) {
    const m = String(ip).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    const octets = m.slice(1).map(Number);
    if (octets.some(o => o > 255)) return null;
    return octets.reduce((acc, o) => (acc << 8n) | BigInt(o), 0n);
}

function ipv6ToBigInt(ip) {
    let s = String(ip).trim();
    if (!s.includes(':')) return null;
    // 去掉 zone id（fe80::1%eth0）
    s = s.split('%')[0];
    const dbl = s.split('::');
    if (dbl.length > 2) return null;
    const head = dbl[0] ? dbl[0].split(':') : [];
    const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (dbl.length === 2 && missing < 1) return null;
    if (dbl.length === 1 && head.length !== 8) return null;
    const groups = [...head, ...Array(dbl.length === 2 ? missing : 0).fill('0'), ...tail];
    if (groups.length !== 8) return null;
    let value = 0n;
    for (const g of groups) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        value = (value << 16n) | BigInt(parseInt(g, 16));
    }
    return value;
}

/** IP → { bits, width }；不合法返回 null */
function parseIp(ip) {
    const v4 = ipv4ToBigInt(ip);
    if (v4 !== null) return { bits: v4, width: 32 };
    const v6 = ipv6ToBigInt(ip);
    if (v6 !== null) return { bits: v6, width: 128 };
    return null;
}

/**
 * CIDR（或单个 IP）是否覆盖某个 IP。IPv4 / IPv6 都支持，跨版本一律不覆盖。
 * @param {string} cidr - 例如 "0.0.0.0/0"、"203.0.113.7/32"、"203.0.113.7"
 * @param {string} ip
 */
function cidrContains(cidr, ip) {
    const target = parseIp(ip);
    if (!target) return false;
    const [base, prefixRaw] = String(cidr).split('/');
    const net = parseIp(base);
    if (!net || net.width !== target.width) return false;
    const prefix = prefixRaw === undefined ? net.width : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > net.width) return false;
    const shift = BigInt(net.width - prefix);
    return (net.bits >> shift) === (target.bits >> shift);
}

/** 访问列表条目里真正表示网段/地址的字段 */
function entryValue(entry) {
    if (!entry) return null;
    return entry.cidrBlock || entry.ipAddress || null;
}

/** 当前 IP 是否已被访问列表里某条覆盖（含 0.0.0.0/0） */
function findCoveringEntry(entries, ip) {
    for (const entry of entries || []) {
        const value = entryValue(entry);
        if (value && cidrContains(value, ip)) return entry;
    }
    return null;
}

/** 该条目是否已生效（v1 没有 status 字段，视为已生效） */
function isEntryActive(entry) {
    if (!entry) return false;
    const status = String(entry.status || '').toUpperCase();
    if (!status) return true;
    return status === 'ACTIVE';
}

// ---------------- HTTP Digest（Atlas API Key 的认证方式） ----------------

function md5(text) {
    return crypto.createHash('md5').update(text).digest('hex');
}

/** 解析 `WWW-Authenticate: Digest realm="…", nonce="…", qop="auth", …` */
function parseDigestChallenge(header) {
    const out = {};
    if (!header) return out;
    const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,]+))/g;
    let m;
    while ((m = re.exec(String(header))) !== null) {
        out[m[1].toLowerCase()] = (m[2] !== undefined ? m[2] : String(m[3]).trim());
    }
    return out;
}

/**
 * 生成 Digest Authorization 头（RFC 2617 §3.2.2 / RFC 7616）
 * @param {Object} p
 *   - username / password: API Key 的 public / private
 *   - method / uri: 请求方法与请求路径（uri 必须与请求行一致）
 *   - challenge: parseDigestChallenge 的结果
 *   - cnonce / nc: 可选（测试用；默认随机 cnonce、nc=00000001）
 */
function buildDigestAuthHeader({ username, password, method, uri, challenge, cnonce, nc }) {
    const c = challenge || {};
    const realm = c.realm || '';
    const nonce = c.nonce || '';
    const qop = String(c.qop || '').split(',')[0].trim();
    const algorithm = String(c.algorithm || 'MD5').toUpperCase();
    const useNc = nc || '00000001';
    const useCnonce = cnonce || crypto.randomBytes(8).toString('hex');

    let ha1 = md5(`${username}:${realm}:${password}`);
    if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${nonce}:${useCnonce}`);
    const ha2 = md5(`${method}:${uri}`);

    const parts = [
        `username="${username}"`,
        `realm="${realm}"`,
        `nonce="${nonce}"`,
        `uri="${uri}"`,
        `algorithm=${algorithm}`
    ];
    if (qop) {
        const response = md5(`${ha1}:${nonce}:${useNc}:${useCnonce}:${qop}:${ha2}`);
        parts.push(`response="${response}"`, `qop=${qop}`, `nc=${useNc}`, `cnonce="${useCnonce}"`);
    } else {
        parts.push(`response="${md5(`${ha1}:${nonce}:${ha2}`)}"`);
    }
    if (c.opaque) parts.push(`opaque="${c.opaque}"`);
    return `Digest ${parts.join(', ')}`;
}

// ---------------- Atlas Admin API ----------------

function isConfigured() {
    return !!(config.ATLAS_PROJECT_ID && config.ATLAS_PUBLIC_KEY && config.ATLAS_PRIVATE_KEY);
}

function apiBase() {
    return String(config.ATLAS_API_BASE || 'https://cloud.mongodb.com').replace(/\/+$/, '');
}

function accessListPath() {
    return `/api/atlas/v2/groups/${encodeURIComponent(config.ATLAS_PROJECT_ID)}/accessList`;
}

/**
 * Atlas Admin API **必须带版本化的 Accept 头**，否则返回
 * `406 INVALID_VERSION_DATE: Invalid accept header or version date.`（实测踩到过）。
 * 版本日期可用 ATLAS_API_VERSION 覆盖（值形如 `2024-08-05`）。
 */
function acceptHeader() {
    const version = String(config.ATLAS_API_VERSION || '2024-08-05').trim();
    return version ? `application/vnd.atlas.${version}+json` : 'application/json';
}

/**
 * 调 Atlas Admin API（自动处理 Digest 401 挑战重发）
 * @returns {Promise<{statusCode:number, headers:Object, body:string}>}
 */
async function atlasRequest(method, path, bodyObj) {
    const url = `${apiBase()}${path}`;
    const headers = { Accept: acceptHeader() };
    const body = bodyObj === undefined || bodyObj === null ? null : JSON.stringify(bodyObj);
    if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
    }

    const first = await httpRequest(url, { method, headers, body });
    if (first.statusCode !== 401) return first;

    const challenge = parseDigestChallenge(first.headers && (first.headers['www-authenticate'] || first.headers['WWW-Authenticate']));
    if (!challenge.nonce) {
        throw new Error(`Atlas API 返回 401 且未提供 Digest 挑战: ${String(first.body || '').slice(0, 200)}`);
    }
    const digest = buildDigestAuthHeader({
        username: config.ATLAS_PUBLIC_KEY,
        password: config.ATLAS_PRIVATE_KEY,
        method,
        uri: path,
        challenge
    });
    return await httpRequest(url, { method, headers: { ...headers, Authorization: digest }, body });
}

/** 读取项目访问列表（v2 返回 { results: [...] }，v1 返回数组） */
async function listAccessList() {
    const res = await atlasRequest('GET', `${accessListPath()}?itemsPerPage=500`);
    if (res.statusCode !== 200) {
        throw new Error(`读取 Atlas 白名单失败: ${describeAtlasError(res.statusCode, res.body)}`);
    }
    let json;
    try {
        json = JSON.parse(res.body || '{}');
    } catch (err) {
        throw new Error(`读取 Atlas 白名单失败: 响应不是 JSON（${String(res.body || '').slice(0, 120)}）`);
    }
    if (Array.isArray(json)) return json;
    return Array.isArray(json.results) ? json.results : [];
}

/**
 * 把 Atlas 的 HTTP 错误翻成可操作的中文提示。
 * 401/403 最常见的原因是 **API Key 自己的 API Access List 没放行当前出口 IP**
 * （注意：该列表 Atlas **不允许**填 0.0.0.0/0；留空 = 不限制，或加入具体 IP）。
 */
function describeAtlasError(statusCode, body) {
    const raw = String(body === undefined || body === null ? '' : body).slice(0, 200);
    if (statusCode === 401 || statusCode === 403) {
        return `HTTP ${statusCode}（Atlas 拒绝了这次调用：多半是 API Key 的 API Access List 没放行当前出口 IP。` +
            `该列表不接受 0.0.0.0/0 —— 把它的条目清空（留空=不限制）或加入当前 IP 即可）：${raw}`;
    }
    if (statusCode === 406) {
        return `HTTP 406（Atlas 要求版本化的 Accept 头。用 ATLAS_API_VERSION 指定一个合法版本日期，如 2024-08-05）：${raw}`;
    }
    return `HTTP ${statusCode}: ${raw}`;
}

/**
 * Atlas 对临时条目的硬限制：到期时间最多"当前时间 + 7 天"
 * （实测：正好 7 天会被拒 —— `400 EXPIRATION_DATE_EXCEEDS_MAX: The specified expiration date
 *   can be at most 7 days in the future.`，因为本机算出的时间在服务端看来已经超了几秒）
 * 所以统一留一点余量。
 */
const MAX_TTL_DAYS = 7;
const TTL_MARGIN_MS = 5 * 60 * 1000;
/** 被上限拒绝时的退让值（本机时钟比 Atlas 快几小时也能加上） */
const FALLBACK_TTL_DAYS = 6.5;

function ttlDays() {
    const days = Number(config.ATLAS_WHITELIST_TTL_DAYS) > 0 ? Number(config.ATLAS_WHITELIST_TTL_DAYS) : MAX_TTL_DAYS;
    return Math.min(days, MAX_TTL_DAYS);
}

/**
 * 加一条**临时**白名单条目（到期 Atlas 自动删除）
 * @param {string} ip - 单个 IP（IPv4 会写成 /32，IPv6 写成 /128）
 * @param {number} [daysOverride] - 覆盖有效期（内部退让重试用）
 * @returns {Promise<{created:boolean, deleteAfterDate:string, statusCode:number}>}
 */
async function addTemporaryEntry(ip, daysOverride) {
    const days = daysOverride || ttlDays();
    const deleteAfterDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000 - TTL_MARGIN_MS).toISOString();
    const parsed = parseIp(ip);
    const entry = parsed && parsed.width === 128
        ? { cidrBlock: `${ip}/128` }
        : { ipAddress: `${ip}/32` };
    entry.comment = `bot auto (temporary ${days}d)`;
    entry.deleteAfterDate = deleteAfterDate;

    const res = await atlasRequest('POST', accessListPath(), [entry]);
    if (res.statusCode === 201 || res.statusCode === 200) {
        return { created: true, deleteAfterDate, statusCode: res.statusCode };
    }
    // 409 = 已存在（并发/别人刚加过）→ 不算失败，交给后面的轮询
    if (res.statusCode === 409) {
        return { created: false, deleteAfterDate, statusCode: res.statusCode, conflict: true };
    }
    // 到期时间超过 Atlas 上限（本机时钟偏快时可能发生）→ 退让到 6.5 天再试一次
    if (!daysOverride && res.statusCode === 400 && /EXPIRATION_DATE_EXCEEDS_MAX/.test(String(res.body || ''))) {
        logger.warn(`[Atlas] 到期时间超出 Atlas 7 天上限，改用 ${FALLBACK_TTL_DAYS} 天重试`);
        return await addTemporaryEntry(ip, FALLBACK_TTL_DAYS);
    }
    throw new Error(`添加 Atlas 白名单失败: ${describeAtlasError(res.statusCode, res.body)}`);
}

/** 轮询直到该 IP 的条目 ACTIVE（Atlas 应用需要 30~120 秒） */
async function waitForActive(ip, { waitMs = 120000, pollMs = 5000 } = {}) {
    const deadline = Date.now() + waitMs;
    let last = null;
    for (;;) {
        const entries = await listAccessList();
        last = findCoveringEntry(entries, ip);
        if (last && isEntryActive(last)) return last;
        if (last && String(last.status || '').toUpperCase() === 'FAILED') {
            throw new Error(`Atlas 白名单条目状态为 FAILED（${entryValue(last)}）`);
        }
        if (Date.now() >= deadline) return null;
        await new Promise(resolve => setTimeout(resolve, pollMs));
    }
}

// ---------------- 运行状态通知 ----------------

/**
 * 数据库连接状态通知（连不上、白名单维护成功/超时/失败）：
 * **统一发到通知群话题**（见 utils/notifyChat.js），不再私聊管理员（用户要求）。
 * @param {string} text
 */
async function notifyAdmins(text) {
    await require('./notifyChat').sendNotify(text, { label: 'Atlas 状态通知' });
}

// ---------------- 主流程 ----------------

/** 进程内冷却 / 并发去重状态（连不上时可能被反复调用） */
const state = {
    lastAttemptAt: 0,
    lastResult: null,
    inflight: null
};

/** 仅供测试重置内部状态 */
function resetStateForTests() {
    state.lastAttemptAt = 0;
    state.lastResult = null;
    state.inflight = null;
}

/**
 * 检查并把当前出口 IP 加入 Atlas 白名单（临时条目，默认 7 天）
 *
 * @param {Object} [opts]
 *   - trigger: 触发来源（写日志/通知用），如 'startup' / 'runtime-heartbeat'
 *   - force:   跳过冷却（手动排障用）
 *   - waitMs / pollMs: 等待条目生效的上限与轮询间隔（测试用）
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, ip?:string, added?:boolean,
 *                    alreadyAllowed?:boolean, active?:boolean, deleteAfterDate?:string}>}
 */
async function ensureIpWhitelisted({ trigger = 'unknown', force = false, waitMs, pollMs } = {}) {
    if (!isConfigured()) {
        return { ok: false, skipped: true, reason: '未配置 Atlas API（需要 ATLAS_PROJECT_ID + ATLAS_PUBLIC_KEY/ATLAS_PRIVATE_KEY）' };
    }
    const cooldown = Number(config.ATLAS_WHITELIST_COOLDOWN_MS) || 10 * 60 * 1000;
    if (!force && Date.now() - state.lastAttemptAt < cooldown) {
        return { ok: true, skipped: true, reason: `冷却中（${Math.round((cooldown - (Date.now() - state.lastAttemptAt)) / 1000)}s 后可再试）`, last: state.lastResult };
    }
    if (state.inflight) return await state.inflight;

    state.inflight = (async () => {
        state.lastAttemptAt = Date.now();
        let ip = null;
        try {
            ip = await getPublicIp();
            logger.warn(`[Atlas] 疑似白名单问题（触发: ${trigger}），当前出口 IP=${ip}，检查项目访问列表...`);

            const entries = await listAccessList();
            const covering = findCoveringEntry(entries, ip);
            let added = false;
            let deleteAfterDate = null;

            if (covering) {
                logger.info(`[Atlas] 当前 IP 已被现有条目覆盖: ${entryValue(covering)}（status=${covering.status || 'n/a'}）`);
            } else {
                const res = await addTemporaryEntry(ip);
                added = res.created;
                deleteAfterDate = res.deleteAfterDate;
                logger.warn(`[Atlas] 已添加临时白名单条目: ${ip}/32，有效期至 ${deleteAfterDate}${res.conflict ? '（已存在，未重复创建）' : ''}`);
            }

            const active = await waitForActive(ip, { waitMs, pollMs });
            const result = {
                ok: !!active,
                ip,
                added,
                alreadyAllowed: !!covering,
                active: !!active,
                deleteAfterDate: (active && (active.deleteAfterDate || active.delete_after_date)) || deleteAfterDate
            };

            if (active) {
                const until = result.deleteAfterDate ? String(result.deleteAfterDate).slice(0, 10) : '（无到期时间）';
                await notifyAdmins(
                    `✅ 数据库连不上，已自动维护 Atlas 白名单\n` +
                    `出口 IP：${ip}\n` +
                    (added ? `已添加临时条目（到期 ${until} 自动失效）` : `现有条目已覆盖该 IP`) +
                    `\n触发：${trigger}`
                );
            } else {
                logger.warn(`[Atlas] 白名单条目等待生效超时（IP=${ip}），稍后重试`);
                await notifyAdmins(`⚠️ 已把出口 IP ${ip} 加入 Atlas 白名单，但等待生效超时（可能仍在应用中，稍后会自动重连）\n触发：${trigger}`);
            }
            state.lastResult = result;
            return result;
        } catch (err) {
            logger.error(`[Atlas] 自动维护白名单失败: ${err.message}`);
            await notifyAdmins(`❌ 自动维护 Atlas 白名单失败：${err.message}\n触发：${trigger}`);
            const result = { ok: false, ip, reason: err.message };
            state.lastResult = result;
            return result;
        }
    })();

    try {
        return await state.inflight;
    } finally {
        state.inflight = null;
    }
}

/**
 * 取当前出口 IP（问外部回显服务，取第一个能解析出 IP 的）
 * @returns {Promise<string>}
 */
async function getPublicIp() {
    const urls = (config.ATLAS_IP_LOOKUP_URLS && config.ATLAS_IP_LOOKUP_URLS.length)
        ? config.ATLAS_IP_LOOKUP_URLS
        : ['https://api.ipify.org', 'https://checkip.amazonaws.com', 'https://ifconfig.me/ip'];
    const errors = [];
    for (const url of urls) {
        try {
            const res = await httpRequest(url, { method: 'GET', headers: { Accept: 'application/json, text/plain, */*' } });
            if (res.statusCode !== 200) {
                errors.push(`${url}: HTTP ${res.statusCode}`);
                continue;
            }
            const ip = extractIp(res.body);
            if (ip) return ip;
            errors.push(`${url}: 响应里没有 IP`);
        } catch (err) {
            errors.push(`${url}: ${err.message}`);
        }
    }
    throw new Error(`获取出口 IP 失败（${errors.join('; ')}）`);
}

/** 从回显服务响应里抠出 IP（支持纯文本与 JSON） */
function extractIp(body) {
    const text = String(body === undefined || body === null ? '' : body).trim();
    if (!text) return null;
    try {
        const json = JSON.parse(text);
        const cand = json.ip || json.query || json.origin || json.address;
        if (cand) {
            const first = String(cand).split(',')[0].trim();
            if (parseIp(first)) return first;
        }
    } catch (err) { /* 不是 JSON，继续按文本找 */ }
    const v4 = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    if (v4 && parseIp(v4[0])) return v4[0];
    const v6 = text.match(/\b[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}\b/);
    if (v6 && parseIp(v6[0])) return v6[0];
    return null;
}

module.exports = {
    classifyDbError,
    ensureIpWhitelisted,
    isConfigured,
    getPublicIp,
    extractIp,
    cidrContains,
    findCoveringEntry,
    entryValue,
    isEntryActive,
    parseDigestChallenge,
    buildDigestAuthHeader,
    describeAtlasError,
    listAccessList,
    addTemporaryEntry,
    waitForActive,
    notifyAdmins,
    resetStateForTests,
    __setHttpRequestForTests
};
