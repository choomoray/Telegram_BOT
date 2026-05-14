// utils/levelExtractor.js
/**
 * 从消息文本中提取等级标记
 * 
 * 规则：
 * - 文本末尾的 # 后跟单个字母（不区分大小写）
 * - 等级顺序：S > A > B > C > D（默认）
 * - 示例："这是一条消息 #S" → level = "S"
 * - 示例："图片说明 #a" → level = "A"
 * - 无标记时返回 "D"
 */

/**
 * 从文本中提取等级
 * @param {string} text - 消息文本
 * @returns {string} - 大写字母 S/A/B/C/D，默认 "D"
 */
function extractLevel(text) {
    if (!text || typeof text !== 'string') {
        return 'D';
    }

    // 匹配末尾的 # 后跟单个字母（忽略前后空白）
    const match = text.match(/#([A-Za-z])\s*$/);
    if (match) {
        const level = match[1].toUpperCase();
        // 仅允许 S/A/B/C/D，其他字母视为无效，返回默认 D
        if (['S', 'A', 'B', 'C', 'D'].includes(level)) {
            return level;
        }
    }
    return 'D';
}

/**
 * 移除文本末尾的等级标记（用于存储纯文本）
 * @param {string} text - 原始文本
 * @returns {string} - 移除等级标记后的文本
 */
function removeLevelSuffix(text) {
    if (!text) return '';
    return text.replace(/\s*#[A-Za-z]\s*$/, '').trim();
}

module.exports = {
    extractLevel,
    removeLevelSuffix
};