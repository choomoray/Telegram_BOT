// handlers/modes/manage/users.js
const bot = require('../../../bot');
const logger = require('../../../logger');
const { setUserState } = require('../../../states');
const {
    getAllUsers,
    banUserFully,
    unbanUserFully,
    userOperationLocks
} = require('../../../db/users');
const { escapeHTML } = require('../../../utils/sanitize');
const { paginationRow } = require('../../../utils/reply');

async function showUserManagementMenu(userId, messageId) {
    const keyboard = {
        inline_keyboard: [
            [{ text: '🚫 封禁', callback_data: 'manage:ban_user' }],
            [{ text: '✅ 解封', callback_data: 'manage:unban_user' }],
            [{ text: '⭐ 白名单管理', callback_data: 'manage:white_menu' }],
            [{ text: '👤 用户列表', callback_data: 'manage:user_list' }],
            [{ text: '🔙 返回', callback_data: 'manage:back' }]
        ]
    };
    await bot.editMessageText('👤 请选择管理内容：', {
        chat_id: userId,
        message_id: messageId,
        reply_markup: keyboard
    });
    setUserState(userId, {
        mode: 'manage',
        step: 'user_menu',
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function promptUserIdForAction(userId, messageId, action) {
    const actionText = action === 'ban' ? '封禁' : '解封';
    await bot.editMessageText(`♻️ 请输入要${actionText}的用户ID（纯数字）`, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 返回', callback_data: 'manage:users' }]] }
    });
    setUserState(userId, {
        mode: 'manage',
        step: 'waiting_user_id',
        userAction: action,
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function processUserIdForAction(userId, input, state, msg) {
    const targetUserId = parseInt(input);
    if (isNaN(targetUserId) || input.trim() !== targetUserId.toString()) {
        await bot.sendMessage(userId, '❌ 请输入有效的数字ID', { reply_to_message_id: msg.message_id });
        return;
    }

    const users = await getAllUsers();
    const user = users.find(u => u.id === targetUserId);
    if (!user) {
        await bot.sendMessage(userId, '❌ 该用户不在数据库中，无法操作', { reply_to_message_id: msg.message_id });
        await showUserManagementMenu(userId, state.mainMsgId);
        return;
    }

    const actionText = state.userAction === 'ban' ? '封禁' : '解封';
    userOperationLocks.add(targetUserId);

    try {
        if (state.userAction === 'ban') {
            const result = await banUserFully(targetUserId, 'manual');
            let msgText = `✅ 该用户已${actionText}`;
            if (result.banned > 0) msgText += `，成功封禁 ${result.banned} 个频道`;
            if (result.failed > 0) msgText += `，${result.failed} 个频道失败`;
            await bot.sendMessage(userId, msgText, { reply_to_message_id: msg.message_id });
        } else {
            const result = await unbanUserFully(targetUserId);
            let msgText = `✅ 该用户已${actionText}`;
            if (result.unbanned > 0) msgText += `，成功解封 ${result.unbanned} 个频道`;
            if (result.failed > 0) msgText += `，${result.failed} 个频道失败`;
            await bot.sendMessage(userId, msgText, { reply_to_message_id: msg.message_id });
        }
        logger.info(`管理员 ${userId} ${actionText}了用户 ${targetUserId}`);
    } finally {
        userOperationLocks.delete(targetUserId);
    }

    await showUserManagementMenu(userId, state.mainMsgId);
}

async function showBannedUsersList(userId, messageId, page = 1) {
    const users = await getAllUsers();
    const bannedUsers = users.filter(u => u.state === 0);
    const pageSize = 30;
    const totalPages = Math.ceil(bannedUsers.length / pageSize) || 1;
    const start = (page - 1) * pageSize;
    const pageUsers = bannedUsers.slice(start, start + pageSize);

    let text = '🚫 封禁用户列表：\n';
    if (pageUsers.length === 0) {
        text += '暂无封禁用户';
    } else {
        for (let i = 0; i < pageUsers.length; i++) {
            const u = pageUsers[i];
            const number = (start + i + 1).toString();
            text += `${number} - ${escapeHTML(u.name || `User${u.id}`)} (${u.id})\n`;
        }
    }

    const keyboard = [];
    const rowSize = 2;
    for (let i = 0; i < pageUsers.length; i += rowSize) {
        const row = [];
        for (let j = i; j < i + rowSize && j < pageUsers.length; j++) {
            const u = pageUsers[j];
            row.push({
                text: `${start + j + 1}. ${u.name || u.id}`,
                callback_data: `manage:unban_confirm:${u.id}`
            });
        }
        keyboard.push(row);
    }

    if (totalPages > 1) {
        keyboard.push(paginationRow(page, totalPages, (p) => `manage:unban_page:${p}`));
    }
    keyboard.push([{ text: '🔙 返回用户菜单', callback_data: 'manage:users' }]);

    await bot.editMessageText(text, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'HTML'
    });

    setUserState(userId, {
        mode: 'manage',
        step: 'unban_select',
        page: page,
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function showUserList(userId, messageId) {
    const users = await getAllUsers();
    let text = '👤 用户列表：\n';
    if (users.length === 0) {
        text += '暂无用户';
    } else {
        for (let i = 0; i < users.length; i++) {
            const u = users[i];
            const number = (i + 1).toString().padStart(2, '0');
            const status = u.state === 0 ? '🚫封禁' : '✅正常';
            const white = u.white === 1 ? '⭐白名单' : '';
            text += `${number} ${escapeHTML(u.name || `User${u.id}`)} (${u.id}) ${status}${white}\n`;
        }
    }
    const keyboard = {
        inline_keyboard: [
            [{ text: '🔙 返回', callback_data: 'manage:users' }]
        ]
    };
    await bot.editMessageText(text, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: keyboard,
        parse_mode: 'HTML'
    });
    setUserState(userId, {
        mode: 'manage',
        step: 'user_list_view',
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

module.exports = {
    showUserManagementMenu, promptUserIdForAction, processUserIdForAction,
    showBannedUsersList, showUserList
};
