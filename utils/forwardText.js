// utils/forwardText.js
/**
 * 文本转发（/send 与消息回复共用）
 *
 * 保留 Telegram 消息格式：加粗 / 斜体 / 下划线 / 删除线 / 链接 / 代码 / 剧透等，
 * 做法是把原消息的 `entities` 原样带上 —— Telegram 的富文本是「纯文本 + entities」，
 * 带上它就等于带上格式。
 *
 * **不要用 `parse_mode`**：那会把用户原文当成 HTML/Markdown 去解析，
 * 用户写的 `<3` 或 `*星号*` 会被吃掉或直接报错，反而破坏原文。
 */

/**
 * 构造转发文本用的发送选项
 * @param {Object} msg - Telegram 消息（取其 entities）
 * @returns {{entities?: Array}} 供 bot.sendMessage 的第三个参数使用
 */
function buildForwardTextOptions(msg) {
    const opts = {};
    const entities = msg && msg.entities;
    if (Array.isArray(entities) && entities.length) {
        opts.entities = entities;
    }
    return opts;
}

/**
 * 原消息里是否带格式（用于日志 / 统计）
 * @param {Object} msg
 * @returns {number} entities 数量
 */
function countEntities(msg) {
    const entities = msg && msg.entities;
    return Array.isArray(entities) ? entities.length : 0;
}

module.exports = { buildForwardTextOptions, countEntities };
