// utils/chatKind.js
/**
 * 会话类型（频道 / 群组）的**权威解析**与列表排序
 *
 * 背景（用户反馈的真实故障）：
 *   `channel_group.type` 这个字段可能是错的（历史数据里讨论群被登记成了频道 —— 例如按
 *   `-100` 前缀猜类型时，超级群组和频道前缀完全一样）。而下面这些地方都照着它算：
 *     - `buildMediaLocation()`：回复模式往群里发 .zip / 文本时传 null，查库拿到 'channel'
 *       → 这条"只发在群组里"的媒体被记成**频道位置**；
 *     - 回复模式的就绪文案「✅ 已选择回复在📢 频道」按位置名取，于是消息明明发在群里，
 *       文案却写"回复在频道"；
 *     - `/send` 的目标列表里频道与群组都显示 📢（两条记录的 type 都是 channel）。
 *
 *   这里统一以 Telegram 为准（`bot.getChat()` 的会话类型），并顺手把库里的 type 改正
 *   （自愈，见 healStoredKind）：只要有一次调用发现不一致，channel_group 就被修好，
 *   后续 WebUI / 列表 / 位置写入自然全对。
 *
 * 说明：
 *   - `channel`        → 广播频道（bot.getChat().type === 'channel'）
 *   - `group`          → 群 / 超级群（'group' | 'supergroup' 都算群组）
 *   - 取不到真实类型时退回库里的 type（再退回 null，由调用方决定默认值）。
 */

const bot = require('../bot');
const logger = require('../logger');

const CHANNEL = 'channel';
const GROUP = 'group';

const TELEGRAM_TTL = 10 * 60 * 1000;   // 真实类型缓存时长
const TELEGRAM_FAIL_TTL = 60 * 1000;   // 取不到时短暂记住失败，避免刷屏重试

const kindCache = new Map();    // chatId -> { kind, at, ttl }
const inflight = new Map();     // chatId -> Promise（同 id 并发只发一次请求）

/** chat_id 归一化：数字能转就转成数字，方便当 Map 键与调 API */
function normalizeChatId(chatId) {
    if (chatId === null || chatId === undefined || chatId === '') return null;
    const n = Number(chatId);
    return Number.isFinite(n) ? n : chatId;
}

/**
 * 把各种来源的类型值归一成 'channel' | 'group' | null
 * （Telegram 的 chat.type 有 'group' / 'supergroup' / 'channel' / 'private'）
 */
function normalizeKind(type) {
    if (type === CHANNEL) return CHANNEL;
    if (type === GROUP || type === 'supergroup') return GROUP;
    return null;
}

/** 清空真实类型缓存（测试用；进程内长期运行无需调用） */
function clearChatKindCache() {
    kindCache.clear();
}

/**
 * 只问 Telegram：`bot.getChat()` 的真实会话类型（带缓存 + 并发去重）。
 * 拿不到时返回 null（失败也会短暂缓存，避免每次列表渲染都打一串失败日志）。
 * @param {number|string} chatId
 * @returns {Promise<'channel'|'group'|null>}
 */
async function telegramChatKind(chatId) {
    const key = normalizeChatId(chatId);
    if (key === null) return null;

    const hit = kindCache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.kind;
    if (inflight.has(key)) return await inflight.get(key);

    const task = (async () => {
        try {
            if (typeof bot.getChat !== 'function') return null;
            const chat = await bot.getChat(key);
            const kind = normalizeKind(chat && chat.type);
            kindCache.set(key, kind
                ? { kind, at: Date.now(), ttl: TELEGRAM_TTL }
                : { kind: null, at: Date.now(), ttl: TELEGRAM_FAIL_TTL });
            return kind;
        } catch (err) {
            kindCache.set(key, { kind: null, at: Date.now(), ttl: TELEGRAM_FAIL_TTL });
            logger.warn(`获取会话类型失败(chat_id=${key}): ${err.message}`);
            return null;
        }
    })();

    // 先登记再等待：任务体可能"一个 await 都不经过"就返回（例如 bot 桩没有 getChat），
    // 那时若把 delete 写在任务自己的 finally 里，会早于这里的 set 执行 → 留下永不删除的
    // 陈旧 inflight 条目，之后所有调用都拿到那个旧结果。故删除放在调用侧，并做身份校验。
    inflight.set(key, task);
    try {
        return await task;
    } finally {
        if (inflight.get(key) === task) inflight.delete(key);
    }
}

/** 库里 channel_group.type 记的类型（可能就是错的） */
async function storedChatKind(chatId) {
    const key = normalizeChatId(chatId);
    if (key === null) return null;
    try {
        const { getChannelGroupById } = require('../db/channelGroup');
        const info = await getChannelGroupById(key);
        return info ? normalizeKind(info.type) : null;
    } catch (err) {
        logger.warn(`读取 channel_group 类型失败(id=${key}): ${err.message}`);
        return null;
    }
}

/** 把库里的 type 改成 Telegram 的真实类型（自愈，失败只记日志，不阻塞调用方） */
function healStoredKind(chatId, before, after) {
    try {
        const { updateChannelGroup } = require('../db/channelGroup');
        Promise.resolve(updateChannelGroup(chatId, { type: after }))
            .then((ok) => {
                if (ok) {
                    logger.warn(`channel_group 类型自愈(以 Telegram 为准): id=${chatId}, ${before} → ${after}`);
                }
            })
            .catch(err => logger.warn(`channel_group 类型自愈失败: id=${chatId}, ${err.message}`));
    } catch (err) {
        logger.warn(`channel_group 类型自愈调用失败: id=${chatId}, ${err.message}`);
    }
}

/**
 * 权威类型解析：Telegram 真实类型优先 → 库里 type 兜底 → null
 *
 * @param {number|string} chatId
 * @param {Object} [opts]
 *   - api:     false 时完全不问 Telegram（只用缓存 / 库里记录）
 *   - persist: 发现库里 type 与真实类型不一致时是否顺手改正（默认 true）
 * @returns {Promise<'channel'|'group'|null>} null = 无法判断（调用方自己定默认值）
 */
async function resolveChatKind(chatId, { api = true, persist = true } = {}) {
    const key = normalizeChatId(chatId);
    if (key === null) return null;

    const real = api ? await telegramChatKind(key) : null;
    const stored = await storedChatKind(key);

    if (real && stored && real !== stored && persist) {
        healStoredKind(key, stored, real);
    }
    return real || stored || null;
}

/**
 * 给一组 channel_group 记录按 Telegram 真实类型补正 `type`（并发受限，走缓存）。
 * 列表/选择器渲染前调一次即可：真实类型与库里不一致时返回修正后的副本，
 * 库里那条记录也已在 resolveChatKind 里被顺手改对。
 * @param {Array} groups
 * @param {Object} [opts] - { concurrency }
 * @returns {Promise<Array>}
 */
async function withRealTypes(groups, { concurrency = 4 } = {}) {
    const list = Array.isArray(groups) ? [...groups] : [];
    const out = [...list];
    const queue = list.map((g, idx) => ({ g, idx }));
    const worker = async () => {
        while (queue.length > 0) {
            const { g, idx } = queue.shift();
            const kind = await resolveChatKind(g.id);
            if (kind && kind !== g.type) out[idx] = { ...g, type: kind };
        }
    };
    const workers = Math.min(Math.max(1, concurrency), queue.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return out;
}

/**
 * `/send` 目标列表的排序：
 *   1. **互相绑定**的一对（A.bind_id = B 且 B.bind_id = A，或至少有一端指向存在的对端）排在最前、紧挨在一起；
 *   2. 每对内部**先频道、后群组**（类型相同则 id 小的在前，保证顺序稳定）；
 *   3. 未绑定 / 悬空绑定的记录按 id 升序排在其后。
 * 纯函数，不改入参。
 * @param {Array} groups - channel_group 记录（含 id / type / bind_id）
 * @returns {Array} 排好序的新数组
 */
function sortChatGroups(groups) {
    const list = Array.isArray(groups) ? groups.filter(Boolean) : [];
    const byId = new Map(list.map(g => [g.id, g]));
    const idNum = g => (Number.isFinite(Number(g.id)) ? Number(g.id) : 0);
    const isChannel = g => g.type === CHANNEL;

    const pairs = [];
    const paired = new Set();
    for (const g of list) {
        if (paired.has(g.id)) continue;
        if (g.bind_id === null || g.bind_id === undefined) continue;
        const peer = byId.get(g.bind_id);
        if (!peer || peer === g) continue;
        // 一对里"频道在前、群组在后"；类型相同就看 id，保证结果稳定可预期
        let first = g;
        let second = peer;
        if (!isChannel(g) && isChannel(peer)) [first, second] = [peer, g];
        else if (isChannel(g) === isChannel(peer) && idNum(peer) < idNum(g)) [first, second] = [peer, g];
        pairs.push([first, second]);
        paired.add(g.id);
        paired.add(peer.id);
    }

    // 对与对之间：按每对第一个（频道）的 id 升序
    pairs.sort((a, b) => idNum(a[0]) - idNum(b[0]));
    const rest = list.filter(g => !paired.has(g.id)).sort((a, b) => idNum(a) - idNum(b));

    return [...pairs.flat(), ...rest];
}

/**
 * 全库修正 channel_group.type：逐个问 Telegram，和库里不一致就改对。
 * 启动时跑一次（历史脏数据一次性修好，之后 WebUI / 列表 / 位置写入全对）；
 * 单个会话取不到类型只跳过，不影响其它会话。
 * @param {Object} [opts] - { concurrency }
 * @returns {Promise<{total:number,checked:number,fixed:number,failed:number}>}
 */
async function repairChannelGroupTypes({ concurrency = 3 } = {}) {
    const stats = { total: 0, checked: 0, fixed: 0, failed: 0 };
    try {
        const { getAllChannelGroups, updateChannelGroup } = require('../db/channelGroup');
        const groups = await getAllChannelGroups();
        stats.total = groups.length;
        const queue = [...groups];
        const worker = async () => {
            while (queue.length > 0) {
                const g = queue.shift();
                const real = await telegramChatKind(g.id);
                if (!real) { stats.failed++; continue; }
                stats.checked++;
                const stored = normalizeKind(g.type);
                if (stored === real) continue;
                const ok = await updateChannelGroup(g.id, { type: real });
                if (ok) {
                    stats.fixed++;
                    logger.warn(`channel_group 类型修正: id=${g.id}${g.name ? `(${g.name})` : ''}, ${g.type} → ${real}`);
                }
            }
        };
        const workers = Math.min(Math.max(1, concurrency), queue.length);
        await Promise.all(Array.from({ length: workers }, worker));
        if (stats.fixed > 0) {
            logger.success(`channel_group 类型修正完成: 共 ${stats.total} 条，检查 ${stats.checked} 条，修正 ${stats.fixed} 条${stats.failed ? `，取不到类型 ${stats.failed} 条` : ''}`);
        } else {
            logger.info(`channel_group 类型检查完成: 共 ${stats.total} 条，无需修正${stats.failed ? `（取不到类型 ${stats.failed} 条）` : ''}`);
        }
    } catch (err) {
        logger.warn(`channel_group 类型修正失败: ${err.message}`);
    }
    return stats;
}

module.exports = {
    CHANNEL,
    GROUP,
    normalizeKind,
    normalizeChatId,
    telegramChatKind,
    storedChatKind,
    resolveChatKind,
    withRealTypes,
    sortChatGroups,
    repairChannelGroupTypes,
    clearChatKindCache
};
