// utils/queryParser.js
/**
 * 消息查询标记解析器
 * 
 * 支持标记组合（不区分大小写，可任意顺序，可混合）：
 *   - 媒体类型：-V (视频), -P (图片), -A (音频), -D (文档)
 *   - 指定等级：+S, +A, +B, +C, +D
 *   - 大于等于等级：S+, A+, B+, C+, D+
 *   - 小于等于等级：S-, A-, B-, C-, D-
 *   - 标签筛选：-tag 标签1 标签2（多个标签用空格或 、, 分隔，与类型/等级标记不冲突）
 * 
 * 返回：
 *   {
 *     types: [],           // 媒体类型数组 ['video','photo','audio','document']
 *     specifiedLevels: [], // 指定等级数组 ['S','A','B','C','D']
 *     levelGTE: [],        // 大于等于等级数组 ['S','A','B','C','D']
 *     levelLTE: [],        // 小于等于等级数组 ['S','A','B','C','D']
 *     tags: [],            // 标签数组（小写去重）
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
            tags: [],
            keyword: ''
        };
    }

    // 统一转大写并分割单词
    const upperText = text.toUpperCase();
    const tokens = upperText.split(/\s+/).filter(t => t.length > 0);
    const rawTokens = text.split(/\s+/).filter(t => t.length > 0);

    const types = [];
    const specifiedLevels = [];
    const levelGTE = [];
    const levelLTE = [];
    const tags = [];

    // 需要从原文本中移除的标记片段（大写形式，用于匹配 rawTokens）
    const tokensToRemove = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        // 标签筛选：-tag 标签1 标签2（空格或 、, 分隔）
        if (token === '-TAG') {
            tokensToRemove.push(token);
            // 收集后续 token 直到遇到下一个标记（以 - 或 + 开头）
            while (i + 1 < tokens.length) {
                const nextUpper = tokens[i + 1];
                if (nextUpper.startsWith('-') || nextUpper.startsWith('+')) break;
                const nextRaw = rawTokens[i + 1];
                // 按 、 , ， 空格拆分标签名
                const parts = nextRaw.split(/[、,，\s]+/).filter(Boolean);
                for (const part of parts) {
                    const t = part.toLowerCase();
                    if (t && !tags.includes(t)) tags.push(t);
                }
                tokensToRemove.push(nextUpper);
                i++;
            }
            continue;
        }

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
        tags,
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
