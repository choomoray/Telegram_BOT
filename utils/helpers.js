// utils/helpers.js
/**
 * 获取用户显示名称（优先 username，否则拼接 first_name + last_name）
 */
function getUserDisplayName(from) {
    return from.username || `${from.first_name || ''} ${from.last_name || ''}`.trim() || '未知用户';
}

module.exports = {
    getUserDisplayName
};