// handlers/callbacks/execCmd.js
const bot = require('../../bot');
const logger = require('../../logger');
const { executeCommand } = require('../commands');
const { isAdmin } = require('../../utils/permissions');

async function handleExecCmdCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 2 || parts[0] !== 'exec_cmd') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    // 权限校验：exec_cmd 按钮可能出现在 /help 或 AI 回复中，
    // 必须再次确认管理员身份，防止按钮泄露被非管理员利用（越权防护）
    if (!isAdmin(userId)) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无权限执行命令' });
        logger.warn(`用户 ${userId} 尝试通过按钮执行命令，已被拒绝: ${parts[1]}`);
        return;
    }

    const command = decodeURIComponent(parts[1]);

    await bot.answerCallbackQuery(query.id, { text: `执行: ${command}` });

    const fakeMsg = {
        from: { id: userId },
        chat: { id: chatId },
        message_id: messageId,
        text: command
    };

    try {
        const result = await executeCommand(command, userId, fakeMsg);
        if (result === 'forbidden') {
            await bot.sendMessage(chatId, '❌ 无权执行该命令');
        } else if (result === 'not_found') {
            await bot.sendMessage(chatId, `❌ 命令 ${command} 不存在`);
        }
        logger.info(`用户 ${userId} 通过按钮执行命令: ${command} -> ${result}`);
    } catch (err) {
        logger.error(`按钮执行命令失败: ${err.message}`);
        await bot.sendMessage(chatId, `❌ 执行命令 ${command} 失败，请稍后重试。`);
    }
}

module.exports = handleExecCmdCallback;
