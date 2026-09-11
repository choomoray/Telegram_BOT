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
 */
const logger = require('../logger');

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
 * 编辑 caption：优先按 HTML 解析，文本里含 & < > 等字符导致解析失败时降级为纯文本
 * （群组/频道回复编辑与私聊编辑共用，避免因解析错误被误判为"位置不可用"）
 */
async function editCaptionHtml(bot, chatId, messageId, text) {
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

module.exports = {
    isEditTargetError,
    resolveEditTargets,
    editCaptionWithFallback,
    editCaptionHtml
};
