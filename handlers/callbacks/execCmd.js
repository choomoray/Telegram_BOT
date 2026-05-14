// handlers/callbacks/execCmd.js
const bot = require('../../bot');
const logger = require('../../logger');
const { executeCommand } = require('../commands');

async function handleExecCmdCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 2 || parts[0] !== 'exec_cmd') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const command = decodeURIComponent(parts[1]);
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    await bot.answerCallbackQuery(query.id, { text: `执行: ${command}` });

    const fakeMsg = {
        from: { id: userId },
        chat: { id: chatId },
        message_id: messageId,
        text: command
    };

    try {
        await executeCommand(command, userId, fakeMsg);
        logger.info(`用户 ${userId} 通过按钮执行命令: ${command}`);
    } catch (err) {
        logger.error(`按钮执行命令失败: ${err.message}`);
        await bot.sendMessage(chatId, `❌ 执行命令 ${command} 失败，请稍后重试。`);
    }
}

module.exports = handleExecCmdCallback;