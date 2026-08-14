// utils/helpers.js
/**
 * 获取用户显示名称（优先 username，否则拼接 first_name + last_name）
 * @param {Object|null} from - Telegram 消息来源对象（可能为 null，如频道匿名消息）
 */
function getUserDisplayName(from) {
    if (!from) return '未知用户';
    return from.username || `${from.first_name || ''} ${from.last_name || ''}`.trim() || '未知用户';
}

module.exports = {
    getUserDisplayName
};
