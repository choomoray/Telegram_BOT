// utils/queryParser.js
/**
 * 消息查询标记解析器
 * 
 * 支持标记组合（不区分大小写，可任意顺序，可混合）：
 *   - 媒体类型：-V (视频), -P (图片), -A (音频), -D (文档)
 *   - 指定等级：+S, +A, +B, +C, +D
 *   - 大于等于等级：S+, A+, B+, C+, D+
 *   - 小于等于等级：S-, A-, B-, C-, D-
 * 
 * 返回：
 *   {
 *     types: [],           // 媒体类型数组 ['video','photo','audio','document']
 *     specifiedLevels: [], // 指定等级数组 ['S','A','B','C','D']
 *     levelGTE: [],        // 大于等于等级数组 ['S','A','B','C','D']
 *     levelLTE: [],        // 小于等于等级数组 ['S','A','B','C','D']
 *     keyword: ''         // 移除所有标记后的纯文本（首尾空格已去除）
 *   }
 */

const TYPE_MAP = {
    '-V': 'video',
    '-P': 'photo',
    '-A': 'audio',
    '-D': 'document'
};

const LEVELS = ['S', 'A', 'B', 'C', 'D'];

/**
 * 解析消息文本中的查询标记
 * @param {string} text - 原始用户消息
 * @returns {Object} 解析结果
 */
function parseQuery(text) {
    if (!text || typeof text !== 'string') {
        return {
            types: [],
            specifiedLevels: [],
            levelGTE: [],
            levelLTE: [],
            keyword: ''
        };
    }

    // 统一转大写并分割单词
    const upperText = text.toUpperCase();
    const tokens = upperText.split(/\s+/).filter(t => t.length > 0);

    const types = [];
    const specifiedLevels = [];
    const levelGTE = [];
    const levelLTE = [];

    // 需要从原文本中移除的标记片段（保留原始大小写以便准确移除）
    const rawTokens = text.split(/\s+/).filter(t => t.length > 0);
    const tokensToRemove = [];

    for (const token of tokens) {
        // 媒体类型标记 -V, -P, -A, -D
        if (TYPE_MAP[token]) {
            if (!types.includes(TYPE_MAP[token])) {
                types.push(TYPE_MAP[token]);
                tokensToRemove.push(token);
            }
            continue;
        }

        // 指定等级 +S, +A, +B, +C, +D
        if (token.length === 2 && token[0] === '+') {
            const level = token[1];
            if (LEVELS.includes(level) && !specifiedLevels.includes(level)) {
                specifiedLevels.push(level);
                tokensToRemove.push(token);
            }
            continue;
        }

        // 大于等于等级 S+, A+, B+, C+, D+
        if (token.length === 2 && token[1] === '+') {
            const level = token[0];
            if (LEVELS.includes(level) && !levelGTE.includes(level)) {
                levelGTE.push(level);
                tokensToRemove.push(token);
            }
            continue;
        }

        // 小于等于等级 S-, A-, B-, C-, D-
        if (token.length === 2 && token[1] === '-') {
            const level = token[0];
            if (LEVELS.includes(level) && !levelLTE.includes(level)) {
                levelLTE.push(level);
                tokensToRemove.push(token);
            }
            continue;
        }
    }

    // 从原始文本中移除所有标记
    let keyword = text;
    for (const rawToken of rawTokens) {
        const upperRaw = rawToken.toUpperCase();
        if (tokensToRemove.includes(upperRaw)) {
            // 使用正则替换，确保只移除整个单词（保留空格）
            const regex = new RegExp(`(^|\\s)${escapeRegExp(rawToken)}(?=\\s|$)`, 'gi');
            keyword = keyword.replace(regex, '');
        }
    }

    // 清理多余空格并去除首尾空格
    keyword = keyword.replace(/\s+/g, ' ').trim();

    return {
        types,
        specifiedLevels,
        levelGTE,
        levelLTE,
        keyword
    };
}

/**
 * 转义正则特殊字符
 */
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    parseQuery,
    TYPE_MAP,
    LEVELS
};