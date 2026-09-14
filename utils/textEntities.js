// utils/textEntities.js
/**
 * Telegram 富文本 entities 工具（纯函数，不联网）
 *
 * Telegram 的富文本是「纯文本 + entities」（加粗 / 斜体 / 下划线 / 删除线 / 剧透 / 代码 / 链接 /
 * 自定义 emoji …），entities 的 offset/length 单位是 UTF-16 code unit，与 JS 字符串下标一致。
 *
 * **严格保留用户发送的文本格式**的唯一正确做法就是把用户消息里的 entities 原样带上 ——
 * 不要用 parse_mode 把原文当 HTML/Markdown 解析（用户写的 `<3`、`*星号*` 会被吃掉甚至直接报错，
 * 与 `/send`、`/reply` 的文本转发同一套思路，见 utils/forwardText.js）。
 *
 * 这里额外解决两件事：
 *   1. 新正文是从用户消息里**截取**出来的（去掉 `/edit@Bot ` 前缀 / 去掉首尾空白 / 去掉 #X 后缀），
 *      entities 的偏移量必须跟着平移、越界的裁掉（宁可丢格式，也不能错位）；
 *   2. caption 只接受一部分 entities 类型，编辑 caption 前要过滤（其余是自动识别类型，
 *      客户端自己会把 URL / @用户名 渲染成链接，丢掉不影响观感）。
 */

/**
 * caption（媒体描述）允许的 entities 类型。
 * 其余（mention / hashtag / cashtag / bot_command / url / email / phone_number 这些自动识别类型）
 * 在 caption_entities 里会被 Telegram 拒绝，编辑前必须过滤。
 */
const CAPTION_ENTITY_TYPES = new Set([
    'bold', 'italic', 'underline', 'strikethrough', 'spoiler',
    'code', 'pre', 'text_link', 'text_mention', 'custom_emoji',
    'blockquote', 'expandable_blockquote'
]);

/**
 * 校验 / 规范化 entities：只保留 offset/length 合法且长度大于 0 的项，按位置排序
 * @param {Array} entities
 * @returns {Array} 新数组（不改动入参）
 */
function normalizeEntities(entities) {
    if (!Array.isArray(entities) || !entities.length) return [];
    const out = [];
    for (const e of entities) {
        if (!e || typeof e !== 'object' || typeof e.type !== 'string') continue;
        const offset = Number(e.offset);
        const length = Number(e.length);
        if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length <= 0) continue;
        out.push({ ...e, offset, length });
    }
    return out.sort((a, b) => a.offset - b.offset || a.length - b.length);
}

/**
 * 把 entities 平移到「从 start 处截取、长度为 length 的新文本」上
 * （已知截取位置时用这个，比按内容 indexOf 猜更准 —— 正文可能和命令前缀里的字符重合）
 * @param {Array} entities
 * @param {number} start - 新文本在原始文本里的起始下标
 * @param {number} length - 新文本长度
 * @returns {Array} 平移 / 裁剪后的 entities
 */
function shiftEntities(entities, start, length) {
    const list = normalizeEntities(entities);
    if (!list.length) return [];
    const from = Math.max(0, Number(start) || 0);
    const len = Math.max(0, Number(length) || 0);
    if (!len) return [];
    const end = from + len;
    const out = [];
    for (const e of list) {
        const s = Math.max(e.offset, from);
        const t = Math.min(e.offset + e.length, end);
        if (t <= s) continue;
        out.push({ ...e, offset: s - from, length: t - s });
    }
    return out;
}

/**
 * 把 entities 从「原始文本」平移到「截取后的新正文」上
 * （例如 `/edit@Bot ` 之后的部分、去首尾空白后的部分、去掉 `#X` 后缀后的部分）
 * @param {Array} entities - 原始文本对应的 entities
 * @param {string} rawText - entities 所对应的原始文本（用户消息的 text/caption）
 * @param {string} newText - 截取后的新正文，必须是 rawText 的子串
 * @returns {Array} 平移 / 裁剪后的 entities；对不上时返回空数组（宁可丢格式，也不能错位）
 */
function projectEntities(entities, rawText, newText) {
    const list = normalizeEntities(entities);
    if (!list.length) return [];
    const raw = String(rawText === undefined || rawText === null ? '' : rawText);
    const next = String(newText === undefined || newText === null ? '' : newText);
    if (!next) return [];
    if (raw === next) return list;
    const start = raw.indexOf(next);
    if (start < 0) return [];
    return shiftEntities(list, start, next.length);
}

/**
 * 过滤出 caption 允许的 entities 类型（见 CAPTION_ENTITY_TYPES）
 * @param {Array} entities
 * @returns {Array}
 */
function captionEntities(entities) {
    return normalizeEntities(entities).filter(e => CAPTION_ENTITY_TYPES.has(e.type));
}

module.exports = {
    CAPTION_ENTITY_TYPES,
    normalizeEntities,
    shiftEntities,
    projectEntities,
    captionEntities
};
