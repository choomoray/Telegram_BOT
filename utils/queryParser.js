// utils/queryParser.js
/**
 * 消息查询标记解析器
 *
 * 查询结构（三段，**必须按这个顺序**出现，否则视为格式错误、不予查询）：
 *
 *   关键字 +类型标记 -标签
 *   └─ 0 ─┘ └─ 1 ─┘ └─ 2 ┘
 *
 * 三段都可以省略（省略即"不限制"），但只要有 ≥2 段同时出现，就必须按上面的顺序写：
 *   `关键字 +d -标签`   ✅
 *   `+d 关键字`         ❌ 类型标记跑到了关键字前面
 *   `-标签 +d`          ❌ 类型标记跑到了标签后面
 *   `-标签 关键字`      ❌ 关键字跑到了标签后面
 *
 * 1) 关键字段：文本模糊搜索（匹配 message 的描述 + media 的文件/音乐名称）
 * 2) 类型标记段：`+d` 文件 / `+a` 音频 / `+p` 仅图片 / `+v` 视频 / `+t` 文本（可写多个）
 * 3) 标签段：`-标签1 标签2` 宽松（命中任一即可）、`--标签1 标签2` 严格（必须全部命中）；
 *    段内只要出现 `--` 就整段按严格模式理解。标签不区分大小写。
 *    标签名可用空格 / 、 / , 分隔（`-图片 高清` 与 `-图片、高清` 等价）。
 *
 * 返回：
 *   {
 *     tags: [],     // 宽松标签数组（小写去重，任一命中）
 *     tagsAll: [],  // 严格标签数组（小写去重，必须全部命中）
 *     types: [],    // media_type 数组（如 ['document','audio']）
 *     keyword: '',  // 关键字段纯文本
 *     valid: true   // 段落顺序是否合法（false → 调用方不予查询）
 *   }
 */

/** 类型标记 → media_type（大小写不敏感） */
const TYPE_MARKERS = {
    d: 'document',  // 文件
    a: 'audio',     // 音频
    p: 'photo',     // 仅图片
    v: 'video',     // 视频
    t: 'text'       // 文本（/send、/reply 发出的纯文本）
};

const SECTION = { KEYWORD: 0, TYPE: 1, TAG: 2 };

/** token 属于哪一段；未知的 `+xxx`（如搜索词 `+1`）按普通关键字处理 */
function sectionOf(token) {
    if (typeof token !== 'string' || !token) return SECTION.KEYWORD;
    if (token.length >= 2 && token[0] === '+') {
        if (TYPE_MARKERS[token.slice(1).toLowerCase()]) return SECTION.TYPE;
        return SECTION.KEYWORD;
    }
    if (token.startsWith('-')) return SECTION.TAG;
    return SECTION.KEYWORD;
}

/** token 是不是类型标记；是则返回对应的 media_type，否则 null */
function typeMarkerOf(token) {
    if (typeof token !== 'string' || token.length < 2 || token[0] !== '+') return null;
    return TYPE_MARKERS[token.slice(1).toLowerCase()] || null;
}

/** 展示用的查询语法提示（格式错误时回给用户） */
const QUERY_SYNTAX_HINT =
    '⚠️ 查询格式不对，没有执行查询。\n' +
    '正确顺序是：`关键字 +类型 -标签`（三段都可省略，但同时出现时必须按这个顺序）\n' +
    '· 关键字：匹配描述与文件/音乐名称\n' +
    '· +d 文件 / +a 音频 / +p 图片 / +v 视频 / +t 文本（可多个）\n' +
    '· -标签1 标签2 宽松匹配；--标签1 标签2 必须全部命中\n' +
    '例：`教程 +v -高清`';

/**
 * 解析消息文本中的查询标记
 * @param {string} text - 原始用户消息
 * @returns {Object} 解析结果（见文件头）
 */
function parseQuery(text) {
    const empty = { tags: [], tagsAll: [], types: [], keyword: '', valid: true };
    if (!text || typeof text !== 'string') return empty;

    const tokens = text.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return empty;

    const keywordParts = [];
    const types = [];
    const tagNames = [];
    let strictTag = false;
    let maxSection = SECTION.KEYWORD;
    let inTagSection = false;

    for (const tk of tokens) {
        let section = sectionOf(tk);
        // 标签段是"黏"的：`-图片 高清` 里 `高清` 也是标签（文档里多标签就是这么写的）
        if (section === SECTION.KEYWORD && inTagSection) section = SECTION.TAG;
        if (section === SECTION.TAG) inTagSection = true;

        // 段落只能"往前走"：回头（例如关键字出现在 +d 之后、+d 出现在 -标签 之后）就是格式错误
        if (section < maxSection) return { ...empty, valid: false };
        maxSection = section;

        if (section === SECTION.TYPE) {
            const t = typeMarkerOf(tk);
            if (t && !types.includes(t)) types.push(t);
            continue;
        }
        if (section === SECTION.TAG) {
            if (tk.startsWith('--')) strictTag = true;
            const body = tk.startsWith('--') ? tk.slice(2) : tk.replace(/^-/, '');
            for (const part of body.split(/[、,，\s]+/).filter(Boolean)) {
                const name = part.toLowerCase();
                if (name && !tagNames.includes(name)) tagNames.push(name);
            }
            continue;
        }
        keywordParts.push(tk);
    }

    return {
        tags: strictTag ? [] : tagNames,
        tagsAll: strictTag ? tagNames : [],
        types,
        keyword: keywordParts.join(' '),
        valid: true
    };
}

module.exports = { parseQuery, typeMarkerOf, TYPE_MARKERS, QUERY_SYNTAX_HINT };
