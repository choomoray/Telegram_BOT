// utils/linkHealth.js
/**
 * 收录链接（transport）活性检查
 *
 * 用法：
 *   - 定时任务（index.js）周期性调用 checkAllTransports() → 失效链接提醒管理员
 *   - 机器人指令（/transport）里调用 checkTransportLink() / checkAllTransports()
 *   - WebUI（/api/transport/check）里按需调用
 *
 * 活性判定（**先按公开链接探测，再看会话可访问性**）：
 *   ok      链接可用：公开链接 t.me/<username> 解析成功，或机器人可直接访问该 chat_id
 *   dead    链接确实失效：公开用户名解析返回「chat not found」（频道已删除/改名/被封），
 *           或机器人能访问该会话但已被踢出/退出
 *   unknown 无法判定，不算失效：
 *           - 私有/消息链接（t.me/c/... 或纯数字 ID）且机器人不在该会话 —— 机器人无权验证，链接本身可能仍有效
 *           - 限流 429、网络抖动、5xx
 *
 * 说明：早期版本直接对 chat_id 调 getChat，而机器人通常并不在搬运来源频道里，
 * 于是全部被判成「chat not found = 失效」。现在改为优先用链接里的公开用户名验证。
 */
const bot = require('../bot');
const logger = require('../logger');
const { transportLinkUrl } = require('./tgLink');

const DEAD_MEMBER_STATUS = new Set(['left', 'kicked']);
/** 批量检查时的默认节流（毫秒/次），避免触发 Telegram 429 */
const DEFAULT_THROTTLE_MS = 300;

let cachedBotId = null;

/** 机器人自身 ID（用于 getChatMember 判断是否还在群内），失败返回 null */
async function getBotId(api) {
    if (!api && cachedBotId) return cachedBotId;
    try {
        const me = await (api || bot).getMe();
        const id = me && me.id ? me.id : null;
        if (!api) cachedBotId = id;
        return id;
    } catch (err) {
        logger.warn(`获取机器人 ID 失败: ${err.message}`);
        return null;
    }
}

/**
 * 从收录链接里取出公开用户名（t.me/<username>[/...]）
 * @param {string} url
 * @returns {string|null}
 */
function publicUsernameOf(url) {
    const m = String(url || '').match(/^https?:\/\/t\.me\/([a-zA-Z][a-zA-Z0-9_]{4,31})(?:[/?#].*)?$/i);
    // 排除 t.me/c/... 这类内部链接
    if (!m) return null;
    const name = m[1];
    if (name.toLowerCase() === 'c' || name.toLowerCase() === 'joinchat') return null;
    return name;
}

/** 429 限流时，Telegram 建议的重试秒数（拿不到返回 null） */
function rateLimitRetryAfter(err) {
    const status = err && err.response && err.response.statusCode;
    if (status !== 429) return null;
    const params = err && err.response && err.response.body && err.response.body.parameters;
    if (params && Number.isFinite(Number(params.retry_after))) return Number(params.retry_after);
    const m = String((err && err.message) || '').match(/retry after (\d+)/i);
    return m ? Number(m[1]) : 1;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 判定一个 Telegram API 错误是否属于"链接已失效"（而非临时故障）
 * node-telegram-bot-api: err.code ∈ ETELEGRAM | EFATAL | ETIMEDOUT | ECONNRESET | ESOCKETTIMEDOUT | 429
 */
function isDeadError(err) {
    if (isTransientError(err)) return false;
    const status = err && err.response && err.response.statusCode;
    if (status === 400 || status === 403 || status === 404) return true;
    const msg = String((err && err.message) || '');
    return /chat not found|bot was kicked|bot is not a member|not enough rights|user not participant|chat_id is empty|PEER_ID_INVALID|CHANNEL_INVALID|chat was deleted/i.test(msg);
}

/** 是否是临时性错误（限流 / 网络 / 服务器错误），这类不算失效 */
function isTransientError(err) {
    const status = err && err.response && err.response.statusCode;
    if (status === 429 || (status >= 500 && status < 600)) return true;
    const code = err && err.code;
    return code === 'EFATAL' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ESOCKETTIMEDOUT' || code === 'EAI_AGAIN';
}

/**
 * 实测一个 transport 链接的活性
 * @param {Object} record - transport 记录 { chat_id, chat_name, url }
 * @param {Object} [opts]
 *   - bot: 注入的 Bot API（测试用，默认用全局 bot）
 *   - retryOnRateLimit: 命中 429 时按 Telegram 建议等待后重试一次（单条手动检查用）
 * @returns {Promise<{status:'ok'|'dead'|'unknown', error:string|null, chat_name:string|null, retry_after?:number}>}
 */
async function checkTransportLink(record, opts = {}) {
    const api = opts.bot || bot;
    const chatId = record ? record.chat_id : null;
    const url = record ? record.url : '';
    if ((chatId === null || chatId === undefined || chatId === '') && !url) {
        return { status: 'unknown', error: '缺少 chat_id 与链接，无法检查', chat_name: null };
    }

    // 1) 公开链接（t.me/<username>）：不要求机器人是成员，最能反映"链接本身是否还活着"
    //    注意：这种情形下不再查机器人成员状态——机器人不在该频道是常态（会返回
    //    "member list is inaccessible" 之类的报错），查了只会制造噪音
    const username = publicUsernameOf(url);
    if (username) {
        let attempt = 0;
        while (true) {
            try {
                const chat = await api.getChat(`@${username}`);
                const chatName = (chat && (chat.title || chat.username)) || null;
                return { status: 'ok', error: null, chat_name: chatName };
            } catch (err) {
                const retryAfter = rateLimitRetryAfter(err);
                if (retryAfter !== null) {
                    if (opts.retryOnRateLimit && attempt < 1 && retryAfter <= 10) {
                        attempt++;
                        await sleep(retryAfter * 1000);
                        continue;
                    }
                    return {
                        status: 'unknown',
                        error: `请求过于频繁（429），约 ${retryAfter}s 后可重试`,
                        chat_name: null,
                        retry_after: retryAfter
                    };
                }
                if (isDeadError(err)) {
                    return { status: 'dead', error: `公开链接 @${username} 已失效：${String(err.message || 'chat not found')}`, chat_name: null };
                }
                return { status: 'unknown', error: String(err.message || '检查失败'), chat_name: null };
            }
        }
    }

    // 2) 私有频道 / 消息链接（t.me/c/... 或纯数字 ID）：机器人不在会话里就没法验证，
    //    此时只能说"无法验证"，绝不能当作失效
    if (chatId === null || chatId === undefined || chatId === '') {
        return { status: 'unknown', error: '链接为私有/消息链接且缺少 chat_id，机器人无法验证', chat_name: null };
    }
    let chat = null;
    try {
        chat = await api.getChat(chatId);
    } catch (err) {
        const retryAfter = rateLimitRetryAfter(err);
        if (retryAfter !== null) {
            return { status: 'unknown', error: `请求过于频繁（429），约 ${retryAfter}s 后可重试`, chat_name: null, retry_after: retryAfter };
        }
        if (isDeadError(err)) {
            return {
                status: 'unknown',
                error: '机器人不在该会话，无法验证（链接本身可能仍然有效）',
                chat_name: null
            };
        }
        return { status: 'unknown', error: String(err.message || '检查失败'), chat_name: null };
    }

    const chatName = (chat && (chat.title || chat.username)) || null;
    const memberNote = await memberIssue(api, chatId);
    if (memberNote) return { status: 'dead', error: memberNote, chat_name: chatName };
    return { status: 'ok', error: null, chat_name: chatName };
}

/**
 * 机器人是否还在会话内（仅在能访问该会话时才有意义）
 * @returns {Promise<string|null>} 失效原因；正常返回 null
 */
async function memberIssue(api, chatId) {
    if (chatId === null || chatId === undefined || chatId === '') return null;
    const botId = await getBotId(api);
    if (!botId) return null;
    try {
        const member = await api.getChatMember(chatId, botId);
        const st = member && member.status;
        if (DEAD_MEMBER_STATUS.has(st)) return `机器人已不在该会话（${st}）`;
    } catch (err) {
        // 拿不到成员信息不影响"会话可访问"的结论
        logger.warn(`检查机器人成员状态失败 chat_id=${chatId}: ${err.message}`);
    }
    return null;
}

/**
 * 并发检查全部 transport 链接，并把结果写回数据库
 * @param {Object} opts
 *   - records: 指定要检查的记录（默认取全部）
 *   - concurrency: 并发数（默认 4）
 *   - force: 为 false 时跳过最近已检查过的记录（默认 false，全部检查）
 *   - maxAgeMs: force=false 时，距上次检查小于该时长则跳过
 *   - onResult: (record, result) => void 每条检查完的回调
 * @returns {Promise<{total:number, checked:number, ok:number, dead:Array, unknown:Array, skipped:number}>}
 */
async function checkAllTransports(opts = {}) {
    const { getTransportHealth, updateTransportStatus } = require('../db/transport');
    const concurrency = Math.max(1, opts.concurrency || 4);
    const maxAgeMs = opts.maxAgeMs || 0;

    let records = opts.records;
    if (!records) {
        try {
            records = await getTransportHealth();
        } catch (err) {
            logger.error(`读取 transport 记录失败: ${err.message}`);
            records = [];
        }
    }
    records = Array.isArray(records) ? records : [];

    const summary = { total: records.length, checked: 0, ok: 0, dead: [], newlyDead: [], recovered: [], unknown: [], skipped: 0 };
    const queue = [...records];

    async function worker() {
        while (queue.length) {
            const record = queue.shift();
            if (!record) continue;
            // 跳过近期已检查的（定时任务降频用）
            if (!opts.force && maxAgeMs > 0 && record.last_check_at && Date.now() - record.last_check_at < maxAgeMs) {
                summary.skipped++;
                continue;
            }
            let result;
            try {
                result = await checkTransportLink(record);
            } catch (err) {
                result = { status: 'unknown', error: String(err.message || '检查异常'), chat_name: null };
            }
            summary.checked++;
            const prevStatus = record.last_check_status || (record.alive === true ? 'ok' : (record.alive === false ? 'dead' : null));
            if (result.status === 'ok') {
                summary.ok++;
                if (prevStatus === 'dead') summary.recovered.push({ ...record });
            } else if (result.status === 'dead') {
                summary.dead.push({ ...record, check_error: result.error });
                if (prevStatus !== 'dead') summary.newlyDead.push({ ...record, check_error: result.error });
            } else {
                summary.unknown.push({ ...record, check_error: result.error });
            }

            try {
                await updateTransportStatus(record.chat_id, {
                    status: result.status,
                    error: result.error,
                    chatName: result.chat_name,
                    previousAlive: record.alive
                });
            } catch (err) {
                logger.warn(`写回 transport 活性失败 chat_id=${record.chat_id}: ${err.message}`);
            }
            if (typeof opts.onResult === 'function') {
                try { opts.onResult(record, result); } catch (err) { /* 回调异常不影响检查 */ }
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, records.length)) }, worker));
    logger.info(`transport 活性检查完成: 共 ${summary.total} 条，检查 ${summary.checked} 条，存活 ${summary.ok}，失效 ${summary.dead.length}，未知 ${summary.unknown.length}，跳过 ${summary.skipped}`);
    return summary;
}

/**
 * 把失效记录汇总成提醒文本（管理员通知 / 菜单提示共用）
 * @param {Array} deadList - 失效记录数组（[{chat_id, chat_name, check_error, url}]）
 * @returns {string} 多行文本（无失效时返回空串）
 */
function formatDeadReport(deadList) {
    const dead = Array.isArray(deadList) ? deadList : [];
    if (!dead.length) return '';
    const lines = dead.slice(0, 15).map(d => {
        const name = d.chat_name || `Chat${d.chat_id}`;
        const url = transportLinkUrl(d);
        return `• ${name}（${d.chat_id}）${url ? `\n  ${url}` : ''}\n  原因：${d.check_error || '不可访问'}`;
    });
    const more = dead.length > lines.length ? `\n…另有 ${dead.length - lines.length} 条` : '';
    return `⚠️ 检测到 ${dead.length} 条搬运收录链接已失效：\n\n${lines.join('\n')}${more}\n\n请在 WebUI 控制台「搬运」页编辑或删除失效链接。`;
}

/** 失效提醒发送给管理员（ADMIN_CHAT_ID） */
async function notifyAdmins(text) {
    const { ADMIN_CHAT_IDS } = require('../config');
    if (!text || !Array.isArray(ADMIN_CHAT_IDS) || !ADMIN_CHAT_IDS.length) return 0;
    let sent = 0;
    for (const chatId of ADMIN_CHAT_IDS) {
        try {
            await bot.sendMessage(chatId, text, { disable_web_page_preview: true });
            sent++;
        } catch (err) {
            logger.warn(`失效链接提醒发送失败 chat_id=${chatId}: ${err.message}`);
        }
    }
    return sent;
}

module.exports = {
    checkTransportLink,
    checkAllTransports,
    transportLinkUrl,
    formatDeadReport,
    notifyAdmins,
    publicUsernameOf,
    rateLimitRetryAfter,
    isDeadError,
    isTransientError
};
