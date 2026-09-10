// utils/tagUi.js
/**
 * 标签按钮键盘构建（/send 与 /tag 共用）
 * 每行 4 个，每页 10 行（40 个标签），翻页样式参考群组列表（◀ 上一页 x/y 下一页 ▶）
 *
 * 两种版面：
 *  1. buildTagKeyboard：单区列表（标签库/已有标签整体展示）
 *  2. buildTagRegionKeyboard：两区列表——上方=已有标签（点击移除），下方=标签库正常显示（点击添加）
 */

const TAG_COLUMNS = 4;        // 每行标签数
const TAG_ROWS_PER_PAGE = 10; // 每页行数
const TAG_PAGE_SIZE = TAG_COLUMNS * TAG_ROWS_PER_PAGE;

const APPLIED_MARKER = '✅';  // 已打上的标签
const ADD_MARKER = '+';       // 未打上的标签
const REGION_SEPARATOR_TEXT = '── 已有标签（点击移除） ──';
const REGION_SEPARATOR_DATA = 'tag_noop';

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

/**
 * 两区标签键盘（/send 打标签面板、/tag 添加标签共用）
 *
 * 版面：
 *   上区 = 已有标签（作用目标上已打上的标签）置顶显示，按钮 ✅名称，点击 = 移除
 *   分隔行 = '── 已有标签（点击移除） ──'（两区都有内容时插入，点击只提示）
 *   下区 = 标签库正常显示（置顶标签 pin>0 按 pin 排在最前，其余按使用次数），按钮 +名称，点击 = 添加
 *
 * 下区过滤规则（用户要求）：
 *   已打上的**置顶标签**（pin>0）仍然在下区显示（"下面的置顶标签已有，同样显示出来"）；
 *   已打上的**非置顶标签**不再在下区重复显示（"非置顶标签就无需显示了"，它们已在上区）。
 *
 * 点击语义由回调 handler 按当前是否已打上决定（已打上=移除，未打上=添加），
 * 因此两区可用同一个 prefix。
 *
 * @param {string[]} applied - 已有标签名数组（去重、按传入顺序展示）
 * @param {Array} library - 标签库（sortTags 排序后的 [{name, pin, count}]）
 * @param {Object} opts
 *   - prefix: 标签点击回调前缀（默认 'sendtag'）
 *   - pagePrefix: 翻页回调前缀
 *   - page: 当前页（只作用于下区标签库）
 *   - extraRows: 额外按钮行（追加在翻页后）
 *   - rowSize: 每行按钮数（默认 4）
 *   - separator: 分隔行文案；传 null 关闭分隔行
 *   - separatorData: 分隔行回调数据（默认 'tag_noop'）
 * @returns {{inline_keyboard, page, totalPages, applied, library}}
 *   applied=上区标签名数组；library=下区过滤后的标签数组
 */
function buildTagRegionKeyboard(applied, library, opts = {}) {
    const rowSize = opts.rowSize || TAG_COLUMNS;

    const appliedList = [];
    for (const raw of (applied || [])) {
        const name = String(raw || '').trim();
        if (name && !appliedList.includes(name)) appliedList.push(name);
    }
    const appliedSet = new Set(appliedList);

    // 下区：标签库去掉"已打上的非置顶标签"；已打上的置顶标签保留（置顶标签属于下区置顶）
    const lower = (library || []).filter(t => t && t.name && !(appliedSet.has(t.name) && !(t.pin > 0)));
    const { page, totalPages, slice } = paginate(lower, opts.page || 1);

    const keyboard = [];

    // ---- 上区：已有标签（置顶显示，点击移除） ----
    for (let i = 0; i < appliedList.length; i += rowSize) {
        keyboard.push(appliedList.slice(i, i + rowSize).map(name => ({
            text: `${APPLIED_MARKER}${name}`,
            callback_data: `${opts.prefix}:${encodeURIComponent(name)}`
        })));
    }

    // ---- 分隔行：仅在两区都有内容时插入，明确上下区域 ----
    if (appliedList.length && slice.length && opts.separator !== null) {
        keyboard.push([{
            text: opts.separator || REGION_SEPARATOR_TEXT,
            callback_data: opts.separatorData || REGION_SEPARATOR_DATA
        }]);
    }

    // ---- 下区：标签库正常显示（置顶在前，点击添加） ----
    for (let i = 0; i < slice.length; i += rowSize) {
        keyboard.push(slice.slice(i, i + rowSize).map(t => ({
            text: `${appliedSet.has(t.name) ? APPLIED_MARKER : ADD_MARKER}${t.name}`,
            callback_data: `${opts.prefix}:${encodeURIComponent(t.name)}`
        })));
    }

    // 翻页按钮（只翻下区标签库）
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

    return { inline_keyboard: keyboard, page, totalPages, applied: appliedList, library: lower };
}

module.exports = {
    buildTagKeyboard,
    buildTagRegionKeyboard,
    paginate,
    splitTagInput,
    matchTagsInText,
    TAG_COLUMNS,
    TAG_ROWS_PER_PAGE,
    TAG_PAGE_SIZE
};
