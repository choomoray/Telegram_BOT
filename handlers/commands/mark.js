// handlers/commands/mark.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    setUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');

/**
 * 标记模式键盘：单选题 —— 要么发媒体（正常标记），要么点「仅记录」，两者做完都退出
 */
const MARK_MENU_KEYBOARD = {
    inline_keyboard: [
        [{ text: '📝 仅记录', callback_data: 'mark_menu:record' }],
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

    await bot.sendMessage(userId,
        '📌 标记模式\n请发送要标记的媒体（支持媒体组，仅处理第一条媒体）\n或点「📝 仅记录」：只记录一次，不标记任何媒体/媒体组\n（二者任选其一，完成后自动退出）', {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true,
        reply_markup: MARK_MENU_KEYBOARD
    }).catch(err => logger.error('发送标记模式菜单失败:', err.message));
}

module.exports = handleMarkCommand;
module.exports.MARK_MENU_KEYBOARD = MARK_MENU_KEYBOARD;
