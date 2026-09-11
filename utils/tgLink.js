// utils/tgLink.js
/**
 * Telegram 链接工具（纯函数，无依赖：WebUI / 机器人 / 活性检查共用）
 */

/**
 * 由 transport 记录推导可点击的 Telegram 跳转链接
 * 优先使用记录里的原始 http(s) 链接；否则用 chat_id 推导
 * （-100 开头的频道/超级群可转 t.me/c/<内部ID>）
 * @param {Object} record - { chat_id, url }
 * @returns {string} 链接；无法推导时返回空串
 */
function transportLinkUrl(record) {
    const url = record && record.url ? String(record.url).trim() : '';
    if (/^https?:\/\//i.test(url)) return url;
    const id = record ? record.chat_id : null;
    // 超级群/频道 ID：-100 + 至少 9 位内部号（-1002 这类普通群/误填值不当作频道链接）
    if (typeof id === 'number' && /^-100\d{9,}$/.test(String(id))) {
        return `https://t.me/c/${String(id).slice(4)}`;
    }
    // 兼容字符串形式的 chat_id
    if (typeof id === 'string' && /^-100\d{9,}$/.test(id)) {
        return `https://t.me/c/${id.slice(4)}`;
    }
    return '';
}

module.exports = { transportLinkUrl };
