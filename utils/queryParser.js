// utils/queryParser.js
/**
 * 消息查询标记解析器
 *
 * 标签筛选语法（句尾最后出现的 `-` 或 `--` 即为标签标记）：
 *   -标签1 标签2        宽松查询：命中任一标签即可（多个标签用空格或 、, ，分隔）
 *   --标签1 标签2       严格查询：必须同时包含 -- 后面所有标签
 *   标签不区分大小写
 *   示例：
 *     "教程 -图片 高清"     → 关键字: 教程，宽松标签: [图片, 高清]
 *     "教程 --图片 高清"    → 关键字: 教程，严格标签: [图片, 高清]
 *     "-图片、教程"         → 关键字: (空)，宽松标签: [图片, 教程]
 *
 * 返回：
 *   {
 *     tags: [],    // 宽松标签数组（小写去重，任一命中）
 *     tagsAll: [], // 严格标签数组（小写去重，必须全部命中）
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
        return { tags: [], tagsAll: [], keyword: '' };
    }

    const tokens = text.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) {
        return { tags: [], tagsAll: [], keyword: '' };
    }

    // 找到句尾最后出现的以 '-' 或 '--' 开头的 token（标签标记）
    let tagStart = -1;
    let strict = false;
    for (let i = tokens.length - 1; i >= 0; i--) {
        const tk = tokens[i];
        if (tk.startsWith('--')) {
            tagStart = i;
            strict = true;
            break;
        }
        if (tk.startsWith('-')) {
            tagStart = i;
            strict = false;
            break;
        }
    }

    const tags = [];
    const tagsAll = [];
    let keywordParts;

    if (tagStart !== -1) {
        const target = strict ? tagsAll : tags;
        const prefix = strict ? '--' : '-';
        // 标签部分：tagStart 及其之后的所有 token
        for (let i = tagStart; i < tokens.length; i++) {
            const tk = tokens[i];
            const parts = tk.replace(new RegExp(`^${prefix}`), '').split(/[、,，\s]+/).filter(Boolean);
            for (const part of parts) {
                const t = part.toLowerCase();
                if (t && !target.includes(t)) target.push(t);
            }
        }
        keywordParts = tokens.slice(0, tagStart);
    } else {
        keywordParts = tokens;
    }

    return {
        tags,
        tagsAll,
        keyword: keywordParts.join(' ')
    };
}

module.exports = { parseQuery };
