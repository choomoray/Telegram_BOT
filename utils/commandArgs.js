// utils/commandArgs.js
/**
 * 指令数字参数解析工具，如 /random_videos 8、/message_reply 6
 */

/**
 * 解析指令后的数字参数（第二个空格分隔的字段）
 * @param {Object} msg - Telegram 消息
 * @returns {number|null} 参数数字；无参数或非数字返回 null（不做截断）
 */
function getNumberArg(msg) {
    const text = (msg && msg.text) || '';
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const num = parseInt(parts[1], 10);
    return isNaN(num) ? null : num;
}

/**
 * 解析数字参数并按 [min, max] 截断
 * @param {Object} msg - Telegram 消息
 * @param {number} min - 最小值
 * @param {number} max - 最大值
 * @returns {number|null} 截断后的数字；无参数或非数字返回 null
 */
function getClampedNumberArg(msg, min, max) {
    const num = getNumberArg(msg);
    if (num === null) return null;
    return Math.min(max, Math.max(min, num));
}

module.exports = { getNumberArg, getClampedNumberArg };
