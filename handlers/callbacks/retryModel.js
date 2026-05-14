// handlers/callbacks/retryModel.js
const bot = require('../../bot');
const logger = require('../../logger');
const { setUserState, deleteUserState } = require('../../states');
const { loadSystemPrompt } = require('../../utils/loadSystemPrompt');

async function handleRetryModelCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 2 || parts[0] !== 'retry_model') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const model = parts[1];
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    const modelName = model === 'lmstudio' ? '本地 LM Studio' : 'DeepSeek';

    await bot.answerCallbackQuery(query.id, { text: `正在重试使用 ${modelName} 模型...` });

    try {
        await bot.editMessageText(`♻️ 正在使用 ${modelName} 模型重试，请稍等...`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] }
        });
    } catch (err) {
        logger.error(`编辑重试消息失败: ${err.message}`);
    }

    deleteUserState(userId);

    const systemPrompt = await loadSystemPrompt();

    setUserState(userId, {
        mode: 'chat',
        lastActivity: Date.now(),
        history: [],
        model: model,
        fallbackModel: null,
        thinking: false,
        systemPrompt: systemPrompt,
        isWarmedUp: false,
        hasSystemPromptSent: false   // 关键
    });

    await bot.sendMessage(userId, `✅ 已重新进入聊天模式 (${modelName})\n你可以继续对话。`)
        .catch(err => logger.error('发送重试提示失败:', err.message));
}

module.exports = handleRetryModelCallback;