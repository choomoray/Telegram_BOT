// utils/markFormatter.js
/**
 * 标记记录展示格式化（纯函数，无副作用，便于单元测试）
 */
const { generateMessageLink } = require('./chatIdConverter');
const { removeLevelSuffix } = require('./levelExtractor');
const { escapeHTML } = require('./sanitize');

const MEDIA_ICON = {
    video: '🎬',
    photo: '🏞',
    audio: '🎵',
    document: '📄'
};

const PAGE_SIZE = 30;
const TEXT_MAX_LEN = 40;

/**
 * 标记记录排序
 * @param {Array} records - 记录数组 [{mark, last_mark_time, ...}]
 * @param {string} sortMode - 'count' 按标记次数降序 | 'time' 按最后标记时间降序
 * @returns {Array} 排序后的新数组
 */
function sortMarkRecords(records, sortMode) {
    const arr = [...records];
    if (sortMode === 'time') {
        arr.sort((a, b) =>
            (b.last_mark_time || 0) - (a.last_mark_time || 0) ||
            (b.mark || 0) - (a.mark || 0)
        );
    } else {
        arr.sort((a, b) =>
            (b.mark || 0) - (a.mark || 0) ||
            (b.last_mark_time || 0) - (a.last_mark_time || 0)
        );
    }
    return arr;
}

/**
 * 时间戳格式化为 YYYY-MM-DD HH:mm
 */
function formatTime(ts) {
    if (ts === null || ts === undefined) return '未知';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 格式化单条标记记录（格式与查找结果类似，次数置前，时间置后）
 */
function formatMarkRecordLine(item, index, total) {
    const markCount = `🔖 ${item.mark || 0}次`;
    const icon = MEDIA_ICON[item.media_type] || '📎';
    const number = total >= 10 ? String(index).padStart(2, '0') : index;

    let text = (item.text || '').trim();
    text = removeLevelSuffix(text);
    if (!text) text = '（无标题）';
    if (text.length > TEXT_MAX_LEN) text = `${text.slice(0, TEXT_MAX_LEN)}…`;

    let display;
    if (item.chat_id && item.message_id) {
        const link = generateMessageLink(item.chat_id, item.message_id);
        display = `<a href="${link}">${escapeHTML(text)}</a>`;
    } else {
        display = escapeHTML(text);
    }

    const markTime = `⏱ ${formatTime(item.last_mark_time)}`;
    return `${markCount} ${icon} ${number} ${display} — ${markTime}`;
}

/**
 * 生成标记记录列表文本
 */
function formatMarkRecords(results, total, currentPage, totalPages, pageSize, sortMode) {
    const lines = [];
    const sortLabel = sortMode === 'time' ? '最后标记时间' : '标记次数';
    lines.push(`📊 标记记录（按${sortLabel}排序）共 ${total} 条：`);
    lines.push('');

    results.forEach((item, idx) => {
        const globalIndex = (currentPage - 1) * pageSize + idx + 1;
        lines.push(formatMarkRecordLine(item, globalIndex, total));
    });

    if (totalPages > 1) {
        lines.push('');
        lines.push(`第 ${currentPage} / ${totalPages} 页`);
    }

    return lines.join('\n');
}

/**
 * 构建标记记录键盘（翻页 + 切换排序）
 */
function buildMarkRecordsKeyboard(sessionId, currentPage, totalPages, sortMode) {
    const keyboard = [];

    if (totalPages > 1) {
        const navRow = [];
        if (currentPage > 1) {
            navRow.push({
                text: '⬅️ 上一页',
                callback_data: `markrec:${sessionId}:${currentPage - 1}`
            });
        }
        navRow.push({
            text: `${currentPage} / ${totalPages}`,
            callback_data: `markrec:${sessionId}:${currentPage}`
        });
        if (currentPage < totalPages) {
            navRow.push({
                text: '下一页 ➡️',
                callback_data: `markrec:${sessionId}:${currentPage + 1}`
            });
        }
        keyboard.push(navRow);
    }

    keyboard.push([{
        text: sortMode === 'count' ? '🔄 按最后标记时间排序' : '🔄 按标记次数排序',
        callback_data: `markrec_switch:${sessionId}`
    }]);

    return { inline_keyboard: keyboard };
}

module.exports = {
    sortMarkRecords,
    formatTime,
    formatMarkRecordLine,
    formatMarkRecords,
    buildMarkRecordsKeyboard,
    PAGE_SIZE,
    TEXT_MAX_LEN
};
