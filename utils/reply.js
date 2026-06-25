// utils/reply.js
// =============================================================================
// 统一机器人回复格式工具模块
// =============================================================================
// 提供标准化的 emoji、消息格式、键盘构建和安全编辑工具，
// 确保所有用户可见消息的风格一致。

// ==================== Emoji 常量 ====================

const EMOJI = {
    SUCCESS: '✅',
    ERROR: '❌',
    WARNING: '⚠️',
    SEARCH: '🔍',
    LOADING: '♻️',
    DELETE: '🗑️',
    EDIT: '✏️',
    BACK: '🔙',
    EXIT: '🚪',
    SEND: '📤',
    SETTINGS: '⚙️',
    LOCK: '🔐',
    KEY: '🔑',
    ADD: '➕',
    MANAGE: '📋',
    DATA: '📊',
    VIEW: '👁️',
    PREV_PAGE: '◀',
    NEXT_PAGE: '▶',
    USER: '👤',
    GROUP: '👥',
    CHANNEL: '📢',
    MEDIA: '🎬',
    PHOTO: '🏞',
    VIDEO: '🎬',
    AUDIO: '🎵',
    DOCUMENT: '📄',
    CHAT: '💬',
    DICE: '🎲',
    STAR: '⭐',
    BAN: '🚫',
    CLOCK: '⏳',
    STOP: '⏹',
    LINK: '🔗',
    CLEAN: '🧹',
    MARK: '🏷️',
    TRANSPORT: '🚚',
    MASK: '🎭',
    REFRESH: '🔄',
    HINT: '💬'
};

// ==================== 消息生成器 ====================

/** ✅ 已进入XX模式 */
function entryMsg(modeName, extra = '') {
    return `✅ 已进入${modeName}${extra ? `\n${extra}` : ''}`;
}

/** ✅ 已退出XX模式 */
function exitMsg(modeName) {
    return `✅ 已退出${modeName}`;
}

/** ✅ 成功消息 */
function successMsg(text) {
    return `✅ ${text}`;
}

/** ❌ 错误消息 */
function errorMsg(text) {
    return `❌ ${text}`;
}

/** ⚠️ 警告/确认消息 */
function warningMsg(text) {
    return `⚠️ ${text}`;
}

/** 🔍 搜索/查询中 */
function searchMsg(text) {
    return `🔍 ${text}`;
}

/** ♻️ 加载/处理中 */
function loadingMsg(text) {
    return `♻️ ${text}`;
}

/** ♻️ 处理中消息（用于临时进度提示） */
function processingMsg(text = '正在处理中...') {
    return `♻️ ${text}`;
}

/** ✅ 重复进入模式提醒 */
function repeatModeMsg(modeName, actionHint = '继续操作即可') {
    return `✅ 您已经在${modeName}模式中，${actionHint}。`;
}

// ==================== 键盘构建器 ====================

/** 🔙 返回按钮键盘 */
function backKeyboard(callbackData = 'back') {
    return { inline_keyboard: [[{ text: '🔙 返回', callback_data: callbackData }]] };
}

/** ✅/❌ 确认/取消键盘 */
function confirmKeyboard(confirmData, cancelData, confirmText = '✅ 确认', cancelText = '❌ 取消') {
    return {
        inline_keyboard: [[
            { text: confirmText, callback_data: confirmData },
            { text: cancelText, callback_data: cancelData }
        ]]
    };
}

/**
 * 分页导航栏（条件性显示箭头）
 * @param {number} currentPage - 当前页码
 * @param {number} totalPages - 总页数
 * @param {Function} pageCallback - (page) => callback_data
 * @param {string} [toggleData] - 切换模式的回调数据，不提供则使用 noop
 * @returns {Array} 键盘行数组
 */
function paginationRow(currentPage, totalPages, pageCallback, toggleData) {
    const row = [];
    if (currentPage > 1) {
        row.push({ text: '◀ 上一页', callback_data: pageCallback(currentPage - 1) });
    }
    row.push({
        text: `${currentPage} / ${totalPages}`,
        callback_data: toggleData || 'noop'
    });
    if (currentPage < totalPages) {
        row.push({ text: '下一页 ▶', callback_data: pageCallback(currentPage + 1) });
    }
    return row;
}

// ==================== 安全编辑工具 ====================

/**
 * 安全编辑消息文本，静默忽略 "message is not modified" 错误
 */
async function safeEditText(bot, chatId, messageId, text, extra = {}) {
    try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...extra });
    } catch (err) {
        if (err.response?.body?.description === 'Bad Request: message is not modified') return;
        throw err;
    }
}

/**
 * 发送加载消息 → 执行异步工作 → 编辑为结果的标准流程
 * @param {Object} bot - bot 实例
 * @param {number} chatId - 聊天 ID
 * @param {string} loadingText - 加载消息文本
 * @param {Function} work - 返回 { text, keyboard?, parse_mode? } 的异步函数
 * @param {Object} [options]
 * @param {number} [options.replyToMessageId] - 可选回复目标
 * @returns {Promise<{loadingMsg, result}>}
 */
async function withLoadingEdit(bot, chatId, loadingText, work, options = {}) {
    const loadingMsg = await bot.sendMessage(chatId, loadingMsg(loadingText), {
        reply_to_message_id: options.replyToMessageId,
        allow_sending_without_reply: true
    });
    try {
        const result = await work();
        const editOpts = { chat_id: chatId, message_id: loadingMsg.message_id };
        if (result.parse_mode) editOpts.parse_mode = result.parse_mode;
        if (result.keyboard) editOpts.reply_markup = result.keyboard;

        await safeEditText(bot, chatId, loadingMsg.message_id, result.text, {
            ...(result.parse_mode ? { parse_mode: result.parse_mode } : {}),
            ...(result.keyboard ? { reply_markup: result.keyboard } : {})
        });
        return { loadingMsg, result };
    } catch (err) {
        // 工作函数抛出错误 → 显示错误信息
        await safeEditText(bot, chatId, loadingMsg.message_id, `❌ 操作失败：${err.message}`);
        throw err;
    }
}

module.exports = {
    EMOJI,
    entryMsg,
    exitMsg,
    successMsg,
    errorMsg,
    warningMsg,
    searchMsg,
    loadingMsg,
    processingMsg,
    repeatModeMsg,
    backKeyboard,
    confirmKeyboard,
    paginationRow,
    safeEditText,
    withLoadingEdit
};
