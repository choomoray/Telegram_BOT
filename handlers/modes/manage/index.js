// handlers/modes/manage/index.js
const bot = require('../../../bot');
const logger = require('../../../logger');
const { getRawUserState, setUserState } = require('../../../states');
const { showMainMenu } = require('./mainMenu');
const groups = require('./groups');
const users = require('./users');
const whitelist = require('./whitelist');
const { showDashboard } = require('./dashboard');
const { unbanUserFully } = require('../../../db/users');

// ==================== 回调处理 ====================
async function handleCallback(query) {
    const data = query.data;
    const userId = query.from.id;
    const messageId = query.message.message_id;
    const state = getRawUserState(userId);
    if (!state || state.mode !== 'manage') return false;

    if (data === 'manage:dashboard') {
        await showDashboard(userId, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:groups') {
        await groups.showGroupList(userId, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:users') {
        await users.showUserManagementMenu(userId, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:back') {
        await showMainMenu(userId, messageId);
        setUserState(userId, { mode: 'manage', step: 'main', mainMsgId: messageId, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:add_group') {
        await groups.promptAddGroup(userId, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:manage_view') {
        await groups.showGroupManageView(userId, messageId, 1);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('manage:manage_page:')) {
        const page = parseInt(data.split(':')[2]);
        await groups.showGroupManageView(userId, messageId, page || 1);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('manage:item:')) {
        const index = parseInt(data.split(':')[2]);
        await groups.showGroupDetail(userId, messageId, index);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('manage:edit_name:')) {
        const idx = parseInt(data.split(':')[2]);
        await groups.promptEditName(userId, messageId, idx);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('manage:bind:')) {
        const idx = parseInt(data.split(':')[2]);
        await groups.promptBindGroup(userId, messageId, idx);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('manage:delete_group:')) {
        const idx = parseInt(data.split(':')[2]);
        await groups.confirmDeleteGroup(userId, messageId, idx);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('manage:delete_confirm:')) {
        const idx = parseInt(data.split(':')[2]);
        await groups.executeDelete(userId, messageId, idx);
        await bot.answerCallbackQuery(query.id, { text: '已删除' });
        return true;
    }
    if (data.startsWith('manage:bind_new:')) {
        const newId = parseInt(data.split(':')[2]);
        await groups.promptBindGroup(userId, messageId, null, newId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:ban_user') {
        await users.promptUserIdForAction(userId, messageId, 'ban');
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:unban_user') {
        await users.showBannedUsersList(userId, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:user_list') {
        await users.showUserList(userId, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:white_menu') {
        await whitelist.showWhiteMenu(userId, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:white_view') {
        await whitelist.showWhiteListView(userId, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('manage:white_view_page:')) {
        const page = parseInt(data.split(':')[2]);
        await whitelist.showWhiteListView(userId, messageId, page || 1);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:white_add') {
        await whitelist.promptAddWhite(userId, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:white_remove') {
        await whitelist.showWhiteRemoveView(userId, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('manage:white_remove_page:')) {
        const page = parseInt(data.split(':')[2]);
        await whitelist.showWhiteRemoveView(userId, messageId, page || 1);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('manage:white_remove_confirm:')) {
        const targetUserId = parseInt(data.split(':')[2]);
        await whitelist.promptConfirmRemoveWhite(userId, messageId, targetUserId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'manage:white_remove_select_return') {
        const currentPage = state && state.page ? state.page : 1;
        await whitelist.showWhiteRemoveView(userId, messageId, currentPage);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('manage:white_remove_yes:')) {
        const targetUserId = parseInt(data.split(':')[2]);
        await whitelist.executeRemoveWhite(userId, messageId, targetUserId);
        await bot.answerCallbackQuery(query.id, { text: '已移除' });
        return true;
    }
    if (data.startsWith('manage:unban_page:')) {
        const page = parseInt(data.split(':')[2]);
        await users.showBannedUsersList(userId, messageId, page || 1);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('manage:unban_confirm:')) {
        const targetUserId = parseInt(data.split(':')[2]);
        await bot.answerCallbackQuery(query.id, { text: '解封中...' });
        const result = await unbanUserFully(targetUserId);
        let msgText = '✅ 已解封';
        if (result.unbanned > 0) msgText += `，成功解封 ${result.unbanned} 个频道`;
        if (result.failed > 0) msgText += `，${result.failed} 个频道失败`;
        await bot.sendMessage(userId, msgText, { reply_to_message_id: messageId });
        const currentPage = state && state.page ? state.page : 1;
        await users.showBannedUsersList(userId, messageId, currentPage);
        return true;
    }

    return false;
}

// ==================== 文本消息处理 ====================
async function handleManageMessage(msg, state) {
    const userId = msg.from.id;
    const text = msg.text?.trim();

    if (state.step === 'waiting_group_link') {
        await groups.verifyAndAddGroup(userId, text, state, msg);
        return true;
    }
    if (state.step === 'waiting_bind_input') {
        await groups.verifyAndBind(userId, text, state, msg);
        return true;
    }
    if (state.step === 'waiting_edit_name') {
        await groups.saveEditName(userId, text, state, msg);
        return true;
    }
    if (state.step === 'waiting_user_id') {
        await users.processUserIdForAction(userId, text, state, msg);
        return true;
    }
    if (state.step === 'waiting_white_add_id') {
        await whitelist.processAddWhite(userId, text, state, msg);
        return true;
    }
    return false;
}

module.exports = {
    handleCallback,
    handleManageMessage,
    showMainMenu
};
