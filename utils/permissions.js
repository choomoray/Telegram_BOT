// utils/permissions.js
/**
 * 权限工具：管理员判断 + 「完全不处理」会话判断
 * 集中管理权限判定，避免各模块各自实现导致口径不一致。
 *
 * 注意：这里**惰性读取** config 的字段（而不是在模块加载时解构），
 * 这样测试里对 config 打桩（只提供部分字段）也不会让别的判断崩掉。
 */
const config = require('../config');

/**
 * 判断用户是否为管理员（`.env` 的 `ADMIN_CHAT_ID`，逗号分隔可多个）
 * @param {number} userId - Telegram 用户 ID
 * @returns {boolean}
 */
function isAdmin(userId) {
    const list = config.ADMIN_CHAT_IDS;
    return Array.isArray(list) && list.includes(userId);
}

/**
 * 该会话是否「完全不处理」：bot 只往里发通知（启动 / 崩溃 / 重启），
 * 不做任何收录、不响应消息、不记录成员、不写 channel_group。
 *
 * 默认就是启动通知群（`STARTUP_NOTIFY_CHAT_ID`，话题群），
 * 也可用 `IGNORED_CHAT_IDS` 追加别的会话。
 *
 * @param {number|string} chatId
 * @returns {boolean}
 */
function isIgnoredChat(chatId) {
    const list = config.IGNORED_CHAT_IDS;
    if (!Array.isArray(list) || list.length === 0) return false;
    const id = Number(chatId);
    return Number.isFinite(id) && list.includes(id);
}

module.exports = { isAdmin, isIgnoredChat };
