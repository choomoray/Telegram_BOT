// handlers/modes/manage/mainMenu.js
const bot = require('../../../bot');
const logger = require('../../../logger');

async function showMainMenu(userId, editMessageId = null) {
    const keyboard = {
        inline_keyboard: [
            [{ text: '👥 群组管理', callback_data: 'manage:groups' }],
            [{ text: '👤 用户管理', callback_data: 'manage:users' }],
            [{ text: '📊 系统概览', callback_data: 'manage:dashboard' }]
        ]
    };
    if (editMessageId) {
        await bot.editMessageText('✅ 已进入管理模式', {
            chat_id: userId,
            message_id: editMessageId,
            reply_markup: keyboard
        }).catch(err => logger.error(`编辑主菜单失败: ${err.message}`));
    }
}

module.exports = { showMainMenu };
