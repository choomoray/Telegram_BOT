// handlers/modes/passwordMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { findMediaByFileUniqueId, updateMediaPassword } = require('../../db/media');
const { extractMediaFromMessage } = require('../../media');
const { getRawUserState, setUserState, deleteUserState, updateUserActivity } = require('../../states');

/**
 * 处理更新密码流程（等待用户发送媒体）
 */
async function handleUpdatePassword(userId, msgId, state) {
    setUserState(userId, {
        ...state,
        step: 'waiting_media_update',
        lastActivity: Date.now()
    });
    await bot.editMessageText('📤 请发送需要设置密码的媒体文件', {
        chat_id: userId,
        message_id: msgId,
        reply_markup: { inline_keyboard: [] }
    });
}

/**
 * 处理查看密码流程（等待用户发送媒体）
 */
async function handleViewPassword(userId, msgId, state) {
    setUserState(userId, {
        ...state,
        step: 'waiting_media_view',
        lastActivity: Date.now()
    });
    await bot.editMessageText('🔍 请发送需要查看密码的媒体文件', {
        chat_id: userId,
        message_id: msgId,
        reply_markup: { inline_keyboard: [] }
    });
}

/**
 * 处理用户发送的媒体（更新密码）
 */
async function processMediaForUpdate(userId, msg, state) {
    const mediaInfo = extractMediaFromMessage(msg);
    if (!mediaInfo) {
        await bot.sendMessage(userId, '❌ 请发送媒体文件', { reply_to_message_id: msg.message_id });
        return;
    }

    const fileUniqueId = mediaInfo.fileUniqueId;
    const mediaDoc = await findMediaByFileUniqueId(fileUniqueId);
    if (!mediaDoc) {
        await bot.sendMessage(userId, '❌ 没有找到该文件', { reply_to_message_id: msg.message_id });
        // 退出模式
        deleteUserState(userId);
        return;
    }

    // 保存临时信息，等待用户输入密码
    setUserState(userId, {
        ...state,
        step: 'waiting_password_input',
        pendingFileUniqueId: fileUniqueId,
        lastActivity: Date.now()
    });
    await bot.sendMessage(userId, '✅ 找到了，请输入新的密码', { reply_to_message_id: msg.message_id });
}

/**
 * 处理用户输入的密码
 */
async function processPasswordInput(userId, password, state, msg) {
    const { pendingFileUniqueId } = state;
    if (!pendingFileUniqueId) {
        deleteUserState(userId);
        return;
    }

    const success = await updateMediaPassword(pendingFileUniqueId, password);
    if (success) {
        await bot.sendMessage(userId, '✅ 新密码已保存', { reply_to_message_id: msg.message_id });
    } else {
        await bot.sendMessage(userId, '❌ 保存失败，请重试', { reply_to_message_id: msg.message_id });
    }
    deleteUserState(userId);
}

/**
 * 处理用户发送的媒体（查看密码）
 */
async function processMediaForView(userId, msg, state) {
    const mediaInfo = extractMediaFromMessage(msg);
    if (!mediaInfo) {
        await bot.sendMessage(userId, '❌ 请发送媒体文件', { reply_to_message_id: msg.message_id });
        deleteUserState(userId);
        return;
    }

    const fileUniqueId = mediaInfo.fileUniqueId;
    const mediaDoc = await findMediaByFileUniqueId(fileUniqueId);
    if (!mediaDoc) {
        await bot.sendMessage(userId, '❌ 没有找到该文件', { reply_to_message_id: msg.message_id });
        deleteUserState(userId);
        return;
    }

    if (!mediaDoc.pwd) {
        await bot.sendMessage(userId, '✅ 该文件没有设置密码', { reply_to_message_id: msg.message_id });
    } else {
        await bot.sendMessage(userId, `🔑 密码：${mediaDoc.pwd}`, { reply_to_message_id: msg.message_id });
    }
    deleteUserState(userId);
}

/**
 * 处理回调查询（更新/查看按钮）
 */
async function handleCallback(query) {
    const data = query.data;
    const userId = query.from.id;
    const messageId = query.message.message_id;
    const state = getRawUserState(userId);
    if (!state || state.mode !== 'password') return false;

    if (data === 'password:update') {
        await handleUpdatePassword(userId, messageId, state);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'password:view') {
        await handleViewPassword(userId, messageId, state);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    return false;
}

/**
 * 处理普通消息（在密码模式下）
 */
async function handlePasswordMessage(msg, state) {
    const userId = msg.from.id;
    const text = msg.text;

    if (state.step === 'waiting_media_update') {
        await processMediaForUpdate(userId, msg, state);
        return true;
    }
    if (state.step === 'waiting_media_view') {
        await processMediaForView(userId, msg, state);
        return true;
    }
    if (state.step === 'waiting_password_input') {
        if (!text) {
            await bot.sendMessage(userId, '❌ 请发送文本密码', { reply_to_message_id: msg.message_id });
            return true;
        }
        await processPasswordInput(userId, text, state, msg);
        return true;
    }
    return false;
}

module.exports = {
    handleCallback,
    handlePasswordMessage
};