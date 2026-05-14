// utils/queryFormatter.js
const { generateMessageLink } = require('./chatIdConverter');
const { removeLevelSuffix } = require('./levelExtractor');
const { escapeHTML } = require('./sanitize');

const MEDIA_ICON = {
    video: '🎬',
    photo: '🏞',
    audio: '🎵',
    document: '📄'
};

function formatResultLine(item, index, total) {
    const icon = MEDIA_ICON[item.media_type] || '📎';
    const number = total >= 10 ? String(index).padStart(2, '0') : index;

    let text = item.text || '';
    text = removeLevelSuffix(text);

    const link = generateMessageLink(item.chat_id, item.message_id);

    if (item.level && ['S', 'A'].includes(item.level)) {
        text = `<b>${escapeHTML(text)}</b>`;
    } else {
        text = escapeHTML(text);
    }

    return `${icon} ${number} <a href="${link}">${text}</a>`;
}

function formatQueryResults(results, total, keyword, currentPage, totalPages) {
    const lines = [];
    lines.push(`🔍 找到 ${total} 条数据：`);
    lines.push('');

    results.forEach((item, idx) => {
        const globalIndex = (currentPage - 1) * 15 + idx + 1;
        lines.push(formatResultLine(item, globalIndex, total));
    });

    return lines.join('\n');
}

function buildFoldKeyboard(totalPages, currentPage, sessionId) {
    const keyboard = [];

    if (totalPages > 1) {
        const navRow = [];
        if (currentPage > 1) {
            navRow.push({
                text: '上一页',
                callback_data: `qpage:${sessionId}:${currentPage - 1}`
            });
        }
        navRow.push({
            text: `${currentPage} / ${totalPages}`,
            callback_data: `qtoggle:${sessionId}:${currentPage}`
        });
        if (currentPage < totalPages) {
            navRow.push({
                text: '下一页',
                callback_data: `qpage:${sessionId}:${currentPage + 1}`
            });
        }
        keyboard.push(navRow);
    }

    return { inline_keyboard: keyboard };
}

function buildNumberKeyboard(sessionId, currentPage, totalPages, pageResults, total) {
    const keyboard = [];

    const itemCount = pageResults.length;
    if (itemCount > 0) {
        const buttonsPerRow = 5;
        for (let i = 0; i < itemCount; i += buttonsPerRow) {
            const row = [];
            for (let j = i; j < i + buttonsPerRow && j < itemCount; j++) {
                const globalIndex = (currentPage - 1) * 15 + j + 1;
                row.push({
                    text: total >= 10 ? String(globalIndex).padStart(2, '0') : String(globalIndex),
                    callback_data: `qmedia:${sessionId}:${currentPage}:${j + 1}`
                });
            }
            keyboard.push(row);
        }
    }

    if (totalPages > 1) {
        const navRow = [];
        if (currentPage > 1) {
            navRow.push({
                text: '上一页',
                callback_data: `qpage:${sessionId}:${currentPage - 1}`
            });
        }
        navRow.push({
            text: `${currentPage} / ${totalPages}`,
            callback_data: `qtoggle:${sessionId}:${currentPage}`
        });
        if (currentPage < totalPages) {
            navRow.push({
                text: '下一页',
                callback_data: `qpage:${sessionId}:${currentPage + 1}`
            });
        }
        keyboard.push(navRow);
    }

    return { inline_keyboard: keyboard };
}

module.exports = {
    formatQueryResults,
    buildFoldKeyboard,
    buildNumberKeyboard,
    formatResultLine   // <-- 新增导出
};