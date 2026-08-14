// utils/permissions.js
/**
 * 权限工具：管理员判断
 * 集中管理权限判定，避免各模块各自实现导致口径不一致。
 */
const { ADMIN_CHAT_IDS } = require('../config');

/**
 * 判断用户是否为管理员
 * @param {number} userId - Telegram 用户 ID
 * @returns {boolean}
 */
function isAdmin(userId) {
    return ADMIN_CHAT_IDS.includes(userId);
}

module.exports = { isAdmin };
