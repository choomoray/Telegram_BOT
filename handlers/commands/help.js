// handlers/commands/help.js
const bot = require('../../bot');
const logger = require('../../logger');

async function handleHelpCommand(userId, msg) {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    const keyboard = {
        inline_keyboard: [
            [
                { text: '🔍 查找', callback_data: 'exec_cmd:/search' },
                { text: '🧹 清理', callback_data: 'exec_cmd:/clean' }
            ],
            [
                { text: '🗑️ 删除', callback_data: 'exec_cmd:/delete' },
                { text: '📦 删除组', callback_data: 'exec_cmd:/delete_group' }
            ],
            [
                { text: '🏷️ 标记', callback_data: 'exec_cmd:/mark' },
                { text: '🚚 搬运', callback_data: 'exec_cmd:/transport' }
            ],
            [
                { text: '📊 日志', callback_data: 'exec_cmd:/log' },
                { text: '💬 聊天', callback_data: 'exec_cmd:/chat' }
            ],
            [
                { text: '🔒 遮罩', callback_data: 'exec_cmd:/media_hide' },
                { text: '🔓 去遮罩', callback_data: 'exec_cmd:/media_unhide' }
            ],
            [
                { text: '🔐 密码', callback_data: 'exec_cmd:/password' }
            ]
        ]
    };

    await bot.sendMessage(chatId, '📋 可用命令列表：', {
        reply_to_message_id: messageId,
        reply_markup: keyboard
    }).catch(err => logger.error('发送帮助消息失败:', err.message));
}

module.exports = handleHelpCommand;