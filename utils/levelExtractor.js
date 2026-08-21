// utils/levelExtractor.js
/**
 * 文本清理工具（等级标记已废弃，仅保留 #X 后缀清理）
 */

/**
 * 移除文本末尾的等级标记（兼容历史数据中的 #S/#A 等后缀）
 * @param {string} text - 原始文本
 * @returns {string} - 移除等级标记后的文本
 */
function removeLevelSuffix(text) {
    if (!text) return '';
    return text.replace(/\s*#[A-Za-z]\s*$/, '').trim();
}

module.exports = {
    removeLevelSuffix
};
