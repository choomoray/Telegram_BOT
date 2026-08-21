// utils/queryParser.js
/**
 * 消息查询标记解析器
 *
 * 标签筛选语法（句尾最后出现的 `-` 即为标签标记）：
 *   查询内容 -标签1 标签2
 *   多个标签用空格或 、, ，分隔；标签不区分大小写
 *   示例：
 *     "教程 -图片 高清"   → 关键字: 教程，标签: [图片, 高清]
 *     "-图片、教程"       → 关键字: (空)，标签: [图片, 教程]
 *
 * 返回：
 *   {
 *     tags: [],    // 标签数组（小写去重）
 *     keyword: '' // 移除标签部分后的纯文本
 *   }
 */

/**
 * 解析消息文本中的查询标记
 * @param {string} text - 原始用户消息
 * @returns {Object} 解析结果
 */
function parseQuery(text) {
    if (!text || typeof text !== 'string') {
        return { tags: [], keyword: '' };
    }

    const tokens = text.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) {
        return { tags: [], keyword: '' };
    }

    // 找到句尾最后出现的以 '-' 开头的 token（即标签标记）
    let tagStart = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
        if (tokens[i].startsWith('-')) {
            tagStart = i;
            break;
        }
    }

    const tags = [];
    let keywordParts;

    if (tagStart !== -1) {
        // 标签部分：tagStart 及其之后的所有 token（- 开头 token 的前导 - 去掉）
        for (let i = tagStart; i < tokens.length; i++) {
            const tk = tokens[i];
            const parts = tk.replace(/^-/, '').split(/[、,，\s]+/).filter(Boolean);
            for (const part of parts) {
                const t = part.toLowerCase();
                if (t && !tags.includes(t)) tags.push(t);
            }
        }
        keywordParts = tokens.slice(0, tagStart);
    } else {
        keywordParts = tokens;
    }

    return {
        tags,
        keyword: keywordParts.join(' ')
    };
}

module.exports = { parseQuery };
