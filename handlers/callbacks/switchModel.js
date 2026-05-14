// handlers/callbacks/switchModel.js
const bot = require('../../bot');
const logger = require('../../logger');
const { setUserState, deleteUserState } = require('../../states');
const { loadSystemPrompt } = require('../../utils/loadSystemPrompt');

async function handleSwitchModelCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 2 || parts[0] !== 'switch_model') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const action = parts[1]; // 'lmstudio' 或 'exit'
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    await bot.answerCallbackQuery(query.id, { text: action === 'lmstudio' ? '正在切换到本地模型...' : '正在退出...' });

    if (action === 'lmstudio') {
        const systemPrompt = await loadSystemPrompt();

        setUserState(userId, {
            mode: 'chat',
            lastActivity: Date.now(),
            history: [],
            model: 'lmstudio',
            fallbackModel: null,
            thinking: false,
            systemPrompt: systemPrompt,
            isWarmedUp: false,
            hasSystemPromptSent: false   // 关键
        });

        await bot.editMessageText('✅ 已切换到本地 LM Studio 模型，现在你可以和我说话了。', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] }
        });
    } else if (action === 'exit') {
        deleteUserState(userId);
        await bot.editMessageText('✅ 已退出聊天模式', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] }
        });
    }
}

module.exports = handleSwitchModelCallback;