// utils/tagUi.js
/**
 * 标签按钮键盘构建（/send 与 /tag 共用）
 * 每行 4 个，每页 10 行（40 个标签），翻页样式参考群组列表（◀ 上一页 x/y 下一页 ▶）
 */

const TAG_COLUMNS = 4;        // 每行标签数
const TAG_ROWS_PER_PAGE = 10; // 每页行数
const TAG_PAGE_SIZE = TAG_COLUMNS * TAG_ROWS_PER_PAGE;

/**
 * 解析手动输入的标签文本（按空格 / 、 / , / ， 分隔，去重保留首现）
 * @param {string} text - 用户输入文本
 * @returns {string[]} 标签名数组
 */
function splitTagInput(text) {
    if (!text || typeof text !== 'string') return [];
    const names = [];
    const parts = text.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
        if (!names.some(n => n.toLowerCase() === p.toLowerCase())) {
            names.push(p);
        }
    }
    return names;
}

/**
 * 在文本中识别已存在的标签（子串匹配，大小写不敏感）
 * @param {string} text - 媒体文本（caption）
 * @param {Array} tags - 标签对象数组 [{name}]
 * @returns {string[]} 文本中出现的标签名（按标签库顺序）
 */
function matchTagsInText(text, tags) {
    if (!text || typeof text !== 'string') return [];
    const matched = [];
    for (const t of tags) {
        if (!t || !t.name) continue;
        if (text.toLowerCase().includes(t.name.toLowerCase())) {
            matched.push(t.name);
        }
    }
    return matched;
}

/**
 * 分页切片
 * @param {Array} items
 * @param {number} page
 * @returns {{page, totalPages, slice}}
 */
function paginate(items, page) {
    const totalPages = Math.max(1, Math.ceil(items.length / TAG_PAGE_SIZE));
    const current = Math.min(Math.max(1, page || 1), totalPages);
    return {
        page: current,
        totalPages,
        slice: items.slice((current - 1) * TAG_PAGE_SIZE, current * TAG_PAGE_SIZE)
    };
}

/**
 * 构建标签按钮键盘（含翻页）
 * @param {Array} tags - 已排序的标签对象数组 [{name, important, count}]
 * @param {Object} opts
 *   - prefix: 标签点击回调前缀（如 'sendtag' / 'tagmsg:tag' 已含子前缀则传完整前缀）
 *   - pagePrefix: 翻页回调前缀（如 'sendtag_page'）
 *   - page: 当前页
 *   - marker: { names: Set, on: '✅', off: '+' } 有标记时按钮显示 ✅name / +name
 *   - extraRows: 额外按钮行（追加在翻页后）
 * @returns {{inline_keyboard, page, totalPages}}
 */
function buildTagKeyboard(tags, opts = {}) {
    const rowSize = opts.rowSize || TAG_COLUMNS;
    const { page, totalPages, slice } = paginate(tags, opts.page || 1);

    const keyboard = [];
    for (let i = 0; i < slice.length; i += rowSize) {
        const row = slice.slice(i, i + rowSize).map(t => {
            let text = t.name;
            if (opts.marker) {
                const has = opts.marker.names && opts.marker.names.has(t.name);
                text = `${has ? opts.marker.on : opts.marker.off}${t.name}`;
            }
            return { text, callback_data: `${opts.prefix}:${encodeURIComponent(t.name)}` };
        });
        keyboard.push(row);
    }

    // 翻页按钮（参考群组列表样式）
    if (totalPages > 1) {
        const navRow = [];
        if (page > 1) navRow.push({ text: '◀ 上一页', callback_data: `${opts.pagePrefix}:${page - 1}` });
        navRow.push({ text: `${page} / ${totalPages}`, callback_data: `${opts.pagePrefix}:${page}` });
        if (page < totalPages) navRow.push({ text: '下一页 ▶', callback_data: `${opts.pagePrefix}:${page + 1}` });
        keyboard.push(navRow);
    }

    if (opts.extraRows && opts.extraRows.length) {
        keyboard.push(...opts.extraRows);
    }

    return { inline_keyboard: keyboard, page, totalPages };
}

module.exports = { buildTagKeyboard, paginate, splitTagInput, matchTagsInText, TAG_COLUMNS, TAG_ROWS_PER_PAGE, TAG_PAGE_SIZE };
