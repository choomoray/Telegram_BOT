// handlers/modes/manage/whitelist.js
const bot = require('../../../bot');
const logger = require('../../../logger');
const { setUserState } = require('../../../states');
const { getAllUsers, setUserWhite } = require('../../../db/users');
const { escapeHTML } = require('../../../utils/sanitize');
const { paginationRow } = require('../../../utils/reply');

async function showWhiteMenu(userId, messageId) {
    const keyboard = {
        inline_keyboard: [
            [{ text: '👁️ 查看白名单', callback_data: 'manage:white_view' }],
            [{ text: '➕ 添加白名单', callback_data: 'manage:white_add' }],
            [{ text: '➖ 移除白名单', callback_data: 'manage:white_remove' }],
            [{ text: '🔙 返回用户菜单', callback_data: 'manage:users' }]
        ]
    };
    await bot.editMessageText('⭐ 白名单管理', {
        chat_id: userId,
        message_id: messageId,
        reply_markup: keyboard
    });
    setUserState(userId, {
        mode: 'manage',
        step: 'white_menu',
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function showWhiteListView(userId, messageId, page = 1) {
    const users = await getAllUsers();
    const whiteUsers = users.filter(u => u.white === 1);
    const pageSize = 30;
    const totalPages = Math.ceil(whiteUsers.length / pageSize) || 1;
    const start = (page - 1) * pageSize;
    const pageItems = whiteUsers.slice(start, start + pageSize);

    let text = '⭐ 白名单用户：\n';
    if (pageItems.length === 0) {
        text += '暂无白名单用户';
    } else {
        for (let i = 0; i < pageItems.length; i++) {
            const u = pageItems[i];
            const number = (start + i + 1).toString().padStart(2, '0');
            text += `${number} - ${escapeHTML(u.name || `User${u.id}`)} (${u.id})\n`;
        }
    }

    const keyboard = [];
    if (totalPages > 1) {
        keyboard.push(paginationRow(page, totalPages, (p) => `manage:white_view_page:${p}`));
    }
    keyboard.push([{ text: '🔙 返回白名单菜单', callback_data: 'manage:white_menu' }]);

    await bot.editMessageText(text, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'HTML'
    });

    setUserState(userId, {
        mode: 'manage',
        step: 'white_view',
        page: page,
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function promptAddWhite(userId, messageId) {
    await bot.editMessageText('♻️ 请输入要添加白名单的用户ID（纯数字）', {
        chat_id: userId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 返回', callback_data: 'manage:white_menu' }]] }
    });
    setUserState(userId, {
        mode: 'manage',
        step: 'waiting_white_add_id',
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function processAddWhite(userId, input, state, msg) {
    const targetUserId = parseInt(input);
    if (isNaN(targetUserId) || input.trim() !== targetUserId.toString()) {
        await bot.sendMessage(userId, '❌ 请输入有效的数字ID', { reply_to_message_id: msg.message_id });
        return;
    }
    await setUserWhite(targetUserId, 1);
    await bot.sendMessage(userId, `✅ 用户 ${targetUserId} 已加入白名单`, { reply_to_message_id: msg.message_id });
    await showWhiteMenu(userId, state.mainMsgId);
}

async function showWhiteRemoveView(userId, messageId, page = 1) {
    const users = await getAllUsers();
    const whiteUsers = users.filter(u => u.white === 1);
    const pageSize = 30;
    const totalPages = Math.ceil(whiteUsers.length / pageSize) || 1;
    const start = (page - 1) * pageSize;
    const pageItems = whiteUsers.slice(start, start + pageSize);

    let text = '➖ 移除白名单（点击编号删除）：\n';
    if (pageItems.length === 0) {
        text += '暂无白名单用户';
    } else {
        for (let i = 0; i < pageItems.length; i++) {
            const u = pageItems[i];
            const number = (start + i + 1).toString().padStart(2, '0');
            text += `${number} - ${escapeHTML(u.name || `User${u.id}`)} (${u.id})\n`;
        }
    }

    const keyboard = [];
    const buttonsPerRow = 5;
    for (let i = 0; i < pageItems.length; i += buttonsPerRow) {
        const row = [];
        for (let j = i; j < i + buttonsPerRow && j < pageItems.length; j++) {
            const globalIndex = start + j + 1;
            const u = pageItems[j];
            row.push({
                text: globalIndex.toString(),
                callback_data: `manage:white_remove_confirm:${u.id}`
            });
        }
        keyboard.push(row);
    }

    if (totalPages > 1) {
        keyboard.push(paginationRow(page, totalPages, (p) => `manage:white_remove_page:${p}`));
    }
    keyboard.push([{ text: '🔙 返回白名单菜单', callback_data: 'manage:white_menu' }]);

    await bot.editMessageText(text, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'HTML'
    });

    setUserState(userId, {
        mode: 'manage',
        step: 'white_remove_select',
        page: page,
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function promptConfirmRemoveWhite(userId, messageId, targetUserId) {
    const user = (await getAllUsers()).find(u => u.id === targetUserId);
    const name = user ? user.name || user.id : targetUserId;
    await bot.editMessageText(`⚠️ 确定要将用户 ${name} 移出白名单吗？`, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ 确认', callback_data: `manage:white_remove_yes:${targetUserId}` },
                    { text: '❌ 取消', callback_data: 'manage:white_remove_select_return' }
                ]
            ]
        }
    });
}

async function executeRemoveWhite(userId, messageId, targetUserId) {
    await setUserWhite(targetUserId, 0);
    await bot.editMessageText(`✅ 用户 ${targetUserId} 已移出白名单`, {
        chat_id: userId,
        message_id: messageId
    });
    setTimeout(() => showWhiteMenu(userId, messageId), 1500);
}

module.exports = {
    showWhiteMenu, showWhiteListView, promptAddWhite, processAddWhite,
    showWhiteRemoveView, promptConfirmRemoveWhite, executeRemoveWhite
};
