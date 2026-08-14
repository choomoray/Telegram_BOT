// handlers/commands/mark.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    setUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { insertLog } = require('../../db/log');

/**
 * 标记模式菜单键盘
 */
const MARK_MENU_KEYBOARD = {
    inline_keyboard: [
        [{ text: '✅ 开始标记', callback_data: 'mark_menu:start' }],
        [{ text: '📊 标记记录', callback_data: 'mark_menu:records' }],
        [{ text: '🚪 退出', callback_data: 'mark_menu:exit' }]
    ]
};

async function handleMarkCommand(userId, msg) {
    updateUserActivity(userId);

    await cleanPreviousMode(userId);

    setUserState(userId, {
        mode: 'mark',
        lastActivity: Date.now(),
        _onExit: async () => { }
    });

    logger.info(`用户 ${userId} 进入标记模式（菜单）`);

    await bot.sendMessage(userId, '📌 标记模式\n请选择操作：', {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true,
        reply_markup: MARK_MENU_KEYBOARD
    }).catch(err => logger.error('发送标记模式菜单失败:', err.message));

    insertLog(20, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
}

module.exports = handleMarkCommand;
module.exports.MARK_MENU_KEYBOARD = MARK_MENU_KEYBOARD;
