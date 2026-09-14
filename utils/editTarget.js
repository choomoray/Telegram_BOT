// utils/editTarget.js
/**
 * 「改描述」时到底该编辑哪一条 Telegram 消息
 *
 * 背景（Telegram 机制）：
 *   - 机器人只能编辑**自己发送**的消息，且只能在 48 小时内；
 *   - 频道发布媒体时，若该频道绑定了讨论群组，Telegram 会自动在群里转发一份；
 *     于是同一条媒体在库里存了两个位置：
 *       channel = 频道源消息（机器人自己 /send 到频道时，这条才是机器人发的 → 可编辑）
 *       group   = 群里那份自动转发副本（发送者是频道，机器人永远改不了 → "message can't be edited"）
 *   - **编辑频道源消息时，Telegram 会自动把改动同步到群里的那份转发副本**，
 *     所以频道 → 讨论群自动转发的媒体应当优先编辑频道位置；
 *     只有群组位置的媒体（群里直接收录/发送的）才编辑群组消息。
 *
 * 因此原来的「一律优先群组位置」会让"刚 /send 到频道的消息"去改群里的转发副本而必然失败。
 *
 * 另外：编辑的**正文**分两种载体 ——
 *   - 媒体消息：正文是 caption（photo/video/audio/document）
 *   - 文本媒体（media_type='text'，/send、/reply 发出的纯文本）：正文是消息 text
 * 两者都用这里的候选位置 + 逐个降级逻辑，只是最后的编辑调用不同
 * （caption → editMessageCaption、text → editMessageText，见 editContentWithFallback）。
 *
 * 编辑时**严格保留用户发送的文本格式**：把用户消息里的 entities 原样带上（caption 用
 * `caption_entities`），只有没有 entities 时才退回 HTML / 纯文本（见 utils/textEntities.js）。
 */
const logger = require('../logger');
const { normalizeEntities, captionEntities } = require('./textEntities');

/** 位置类错误：换一个位置（频道 ↔ 群组）重试才有意义 */
const TARGET_ERROR_PATTERNS = [
    "can't be edited",
    "Can't edit",
    'message to edit not found',
    'MESSAGE_ID_INVALID'
];

/** 是否为「这个位置改不了」类错误（不可编辑 / 消息不存在） */
function isEditTargetError(err) {
    const msg = (err && err.message) || '';
    return TARGET_ERROR_PATTERNS.some(p => msg.includes(p));
}

/**
 * 解析候选编辑位置（按优先级排序，逐个尝试）
 *   1. channel —— 频道 → 讨论群自动转发时，改频道源消息（Telegram 自动同步到群里的副本）
 *   2. group   —— 群里直接收录/发送的媒体（或频道位置已失效时的兜底重试）
 *   3. top     —— 旧数据只有 message_id、chat_id 只能从 group_id 前缀推导时的兜底
 * @param {Object} mediaDoc media 集合文档（含 group / channel / message_id）
 * @param {number|string} [fallbackChatId] 旧数据兜底 chat_id（如从 group_id 前缀提取）
 * @returns {Array<{chatId:number, messageId:number, via:'channel'|'group'|'top'}>}
 */
function resolveEditTargets(mediaDoc, fallbackChatId) {
    if (!mediaDoc) return [];
    const out = [];
    const push = (chatId, messageId, via) => {
        const c = Number(chatId);
        const m = Number(messageId);
        if (!Number.isFinite(c) || !Number.isFinite(m) || m <= 0) return;
        if (out.some(t => t.chatId === c && t.messageId === m)) return;
        out.push({ chatId: c, messageId: m, via });
    };

    if (mediaDoc.channel && mediaDoc.channel.chat_id) {
        push(mediaDoc.channel.chat_id, mediaDoc.channel.message_id, 'channel');
    }
    if (mediaDoc.group && mediaDoc.group.chat_id) {
        push(mediaDoc.group.chat_id, mediaDoc.group.message_id, 'group');
    }
    push(mediaDoc.chat_id, mediaDoc.message_id, 'top');
    if (!out.length) {
        // 旧数据：只有 group_id + 顶层 message_id，chat_id 由调用方从 group_id 前缀推导
        push(fallbackChatId, mediaDoc.message_id, 'top');
    }
    return out;
}

/**
 * 依次尝试候选位置编辑 caption：
 *   - 只有「位置类错误」（不可编辑 / 消息不存在）才继续尝试下一个位置；
 *   - 其他错误（如 caption HTML 解析失败）立即抛出，保持调用方原有语义；
 *   - 全部位置都失败时抛出最后一次的错误（调用方据此走"仅改数据库"降级）。
 * @param {Array<{chatId:number, messageId:number, via:string}>} targets resolveEditTargets 的结果
 * @param {(target:Object) => Promise<any>} doEdit 实际编辑调用（每个位置调用一次）
 * @returns {Promise<{chatId:number, messageId:number, via:string}>} 编辑成功的位置
 */
async function editCaptionWithFallback(targets, doEdit) {
    const list = Array.isArray(targets) ? targets : [];
    if (!list.length) throw new Error('没有可用的编辑位置');

    let lastErr = null;
    for (let i = 0; i < list.length; i++) {
        const target = list[i];
        try {
            await doEdit(target);
            if (i > 0) {
                logger.info(`编辑位置降级成功: via=${target.via}, chat=${target.chatId}/${target.messageId}`);
            }
            return target;
        } catch (err) {
            lastErr = err;
            if (!isEditTargetError(err)) throw err;
            logger.warn(`编辑位置不可用(via=${target.via}, chat=${target.chatId}/${target.messageId}): ${err.message}`);
        }
    }
    throw lastErr;
}

/**
 * 编辑 caption：
 *   1. 用户消息带 entities（加粗/斜体/链接/剧透…）→ **原样带上**（`caption_entities`），
 *      严格保留用户发送的格式，不用 parse_mode 去解析原文；
 *   2. 没有 entities → 优先按 HTML 解析，文本里含 & < > 等字符导致解析失败时降级为纯文本；
 *   3. entities 被 Telegram 拒绝（类型不被 caption 接受等）→ 丢掉 entities 用纯文本重试，正文不能丢。
 * （群组/频道回复编辑与私聊编辑共用，避免因解析错误被误判为"位置不可用"）
 */
async function editCaptionHtml(bot, chatId, messageId, text, entities) {
    const list = captionEntities(entities);
    if (list.length) {
        try {
            await bot.editMessageCaption(text, { chat_id: chatId, message_id: messageId, caption_entities: list });
            return;
        } catch (err) {
            const msg = (err && err.message) || '';
            // 只有"entities 本身不被接受"才降级；"消息改不了/不存在"要留给调用方换位置重试
            if (!/entit/i.test(msg)) throw err;
            logger.warn(`caption entities 被拒绝，降级为纯文本: ${msg}`);
        }
    }
    try {
        await bot.editMessageCaption(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    } catch (err) {
        if ((err.message || '').includes('parse')) {
            await bot.editMessageCaption(text, { chat_id: chatId, message_id: messageId });
        } else {
            throw err;
        }
    }
}

/**
 * 目标正文的载体类型
 *   'text'    —— 文本媒体（media_type='text'）：改的是消息 text
 *   'caption' —— 其余（图片/视频/音频/文档）：改的是 caption
 * @param {Object} mediaDoc media 集合文档（可为空：库外消息按调用方给的 kind）
 * @returns {'text'|'caption'}
 */
function editTargetKind(mediaDoc) {
    return mediaDoc && mediaDoc.media_type === 'text' ? 'text' : 'caption';
}

/**
 * 编辑文本消息正文：
 *   1. 用户消息带 entities → **原样带上**（`entities`），严格保留用户发送的格式（不用 parse_mode）；
 *   2. 没有 entities → 优先按 HTML 解析，含特殊字符解析失败时降级为纯文本；
 *   3. entities 被 Telegram 拒绝 → 丢掉 entities 用纯文本重试，正文不能丢。
 * （注意：Telegram 不允许把文本消息改成空文本，清空只对 caption 有效）
 */
async function editTextHtml(bot, chatId, messageId, text, entities) {
    const list = normalizeEntities(entities);
    if (list.length) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, entities: list });
            return;
        } catch (err) {
            const msg = (err && err.message) || '';
            if (!/entit/i.test(msg)) throw err;
            logger.warn(`文本 entities 被拒绝，降级为纯文本: ${msg}`);
        }
    }
    try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    } catch (err) {
        if ((err.message || '').includes('parse')) {
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
        } else {
            throw err;
        }
    }
}

/**
 * 按载体类型编辑消息正文，候选位置逐个降级（与 editCaptionWithFallback 同一套语义）：
 * 只有「位置类错误」才尝试下一个位置，其它错误立即抛出。
 * @param {Object} bot
 * @param {Array<{chatId:number, messageId:number, via:string}>} targets resolveEditTargets 的结果
 * @param {'text'|'caption'|'auto'} kind - 'auto'：库里没有记录、不知道是媒体还是文本，
 *        先按 caption 试，Telegram 报"没有 caption"再按文本试（消息链接 / 转发来源定位的库外消息）
 * @param {string} text 新正文
 * @param {Array} [entities] 新正文的 Telegram 富文本 entities（严格保留用户发送的格式）
 * @returns {Promise<{chatId:number, messageId:number, via:string}>} 编辑成功的位置
 */
async function editContentWithFallback(bot, targets, kind, text, entities) {
    return await editCaptionWithFallback(targets, async (t) => {
        if (kind === 'text') {
            await editTextHtml(bot, t.chatId, t.messageId, text, entities);
            return;
        }
        // 清空描述：空文本不带 parse_mode / entities（与既有行为一致；Telegram 允许 caption 为空）
        const clearCaption = async () => {
            await bot.editMessageCaption('', { chat_id: t.chatId, message_id: t.messageId });
        };
        if (kind === 'caption') {
            if (text === '') await clearCaption();
            else await editCaptionHtml(bot, t.chatId, t.messageId, text, entities);
            return;
        }
        // auto：先 caption 再 text
        try {
            if (text === '') await clearCaption();
            else await editCaptionHtml(bot, t.chatId, t.messageId, text, entities);
        } catch (err) {
            if (/there is no caption in the message/i.test(err.message || '')) {
                await editTextHtml(bot, t.chatId, t.messageId, text, entities);
                return;
            }
            throw err;
        }
    });
}

module.exports = {
    isEditTargetError,
    resolveEditTargets,
    editCaptionWithFallback,
    editCaptionHtml,
    editTargetKind,
    editTextHtml,
    editContentWithFallback
};
