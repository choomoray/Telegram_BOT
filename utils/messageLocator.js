// utils/messageLocator.js
/**
 * 「这条消息在 Telegram 的哪一处」——把一条消息定位成可编辑目标（chat_id + message_id）
 *
 * 用途：私聊 `/edit` 时不必重新发送媒体，直接给出**消息链接**或**含转发源的消息**即可定位；
 * 群组回复 `/edit` 时，若被回复的是「频道帖的自动转发副本」，也靠这里的转发来源定位到频道源消息
 * （Telegram 机制：改频道源消息会自动同步到讨论群里的那份副本）。
 *
 * 支持两种投递方式：
 *   1. 消息链接：`https://t.me/c/<内部ID>/<消息ID>`（私有频道/超级群，内部 ID 前加 -100）
 *                `https://t.me/<公开用户名>/<消息ID>`（公开频道/群，需 getChat 解析出 chat_id）
 *   2. 含转发源的消息：
 *      - `forward_origin`（新版 API）：只有 **频道帖** 带 `message_id`（MessageOriginChannel）
 *      - `forward_from_chat` + `forward_from_message_id`（旧版 API，同样只对频道帖有效）
 *
 * Telegram 限制（无法定位的情况，请改用消息链接）：
 *   - 从**群组**转发的消息：MessageOriginChat 不带原消息 ID，旧字段也没有 forward_from_message_id。
 */
const logger = require('../logger');

/** 公开用户名保留字：这些不是聊天用户名，不能拿去 getChat */
const RESERVED_USERNAMES = new Set([
    'c', 's', 'joinchat', 'addstickers', 'share', 'iv', 'proxy', 'socks',
    'setlanguage', 'login', 'bg', 'addtheme', 'contact', 'invoice', 'giftcode', 'boost',
    'addemoji', 'addlist', 'confirmphone', 'migrate', 'setname'
]);

/**
 * 匹配消息链接（t.me / telegram.me）：
 *   t.me/c/<内部ID>/<消息ID>      → 私有频道/超级群
 *   t.me/<公开用户名>/<消息ID>    → 公开频道/群（也可能带 ?single / ?thread= 参数）
 */
const MESSAGE_LINK_RE = /(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/(?:c\/(\d+)\/(\d+)|([A-Za-z][A-Za-z0-9_]{3,})\/(\d+))/i;

/**
 * 从文本里解析消息链接（纯函数，不联网）
 * @param {string} text - 消息文本（或 caption）
 * @returns {{chatId:number|null, username:string|null, messageId:number, via:string}|null}
 *   私有链接直接给出 chatId；公开链接只给 username，需调用方用 getChat 解析
 */
function parseMessageLink(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const m = raw.match(MESSAGE_LINK_RE);
    if (!m) return null;

    // 私有链接：t.me/c/<内部ID>/<消息ID>
    if (m[1]) {
        const internal = m[1];
        const messageId = Number(m[2]);
        if (!Number.isFinite(messageId) || messageId <= 0) return null;
        return {
            chatId: Number(`-100${internal}`),
            username: null,
            messageId,
            via: 'link'
        };
    }

    // 公开链接：t.me/<用户名>/<消息ID>
    const username = String(m[3] || '');
    const messageId = Number(m[4]);
    if (!username || RESERVED_USERNAMES.has(username.toLowerCase())) return null;
    if (!Number.isFinite(messageId) || messageId <= 0) return null;
    return { chatId: null, username, messageId, via: 'link' };
}

/**
 * 用公开用户名解析 chat_id（机器人需能访问该会话；公开频道/群一般可以直接解析）
 * @param {string} username
 * @param {Object} bot - Telegram bot 实例（测试里可传桩）
 * @returns {Promise<number|null>}
 */
async function resolveUsernameChatId(username, bot) {
    if (!username || !bot || typeof bot.getChat !== 'function') return null;
    try {
        const chat = await bot.getChat(`@${username}`);
        const id = chat && chat.id !== undefined && chat.id !== null ? Number(chat.id) : NaN;
        return Number.isFinite(id) ? id : null;
    } catch (err) {
        logger.warn(`消息链接里的公开用户名解析失败 @${username}: ${err.message}`);
        return null;
    }
}

/**
 * 把一条消息（私聊收到的链接/转发，或群里被回复的转发副本）解析成原始位置
 * @param {Object} msg - Telegram 消息对象
 * @param {Object} bot - Telegram bot 实例（解析公开用户名用）
 * @returns {Promise<{chatId:number, messageId:number, via:string}|null>}
 */
async function resolveMessageOrigin(msg, bot) {
    if (!msg) return null;

    // 1) 新版转发来源（只有频道帖带 message_id）
    const fo = msg.forward_origin;
    if (fo && fo.chat && fo.message_id !== undefined && fo.message_id !== null) {
        const chatId = Number(fo.chat.id);
        const messageId = Number(fo.message_id);
        if (Number.isFinite(chatId) && Number.isFinite(messageId) && messageId > 0) {
            return { chatId, messageId, via: 'forward_origin' };
        }
    }

    // 2) 旧版转发字段（同样只有频道帖带 forward_from_message_id）
    if (msg.forward_from_chat && msg.forward_from_message_id !== undefined && msg.forward_from_message_id !== null) {
        const chatId = Number(msg.forward_from_chat.id);
        const messageId = Number(msg.forward_from_message_id);
        if (Number.isFinite(chatId) && Number.isFinite(messageId) && messageId > 0) {
            return { chatId, messageId, via: 'forward_legacy' };
        }
    }

    // 3) 文本 / 说明里的消息链接
    const link = parseMessageLink(msg.text || msg.caption || '');
    if (link) {
        const chatId = link.chatId || await resolveUsernameChatId(link.username, bot);
        if (Number.isFinite(chatId)) {
            return { chatId, messageId: link.messageId, via: link.via };
        }
    }

    return null;
}

module.exports = {
    parseMessageLink,
    resolveUsernameChatId,
    resolveMessageOrigin,
    RESERVED_USERNAMES
};
