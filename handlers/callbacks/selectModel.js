// handlers/callbacks/selectModel.js
const bot = require('../../bot');
const logger = require('../../logger');
const { setUserState } = require('../../states');
const { loadSystemPrompt } = require('../../utils/loadSystemPrompt');

async function handleSelectModelCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 3 || parts[0] !== 'select_model') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const model = parts[1];
    const thinking = parts[2] === 'thinking_on';

    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    let modelDisplayName = model === 'lmstudio' ? '本地 LM Studio' : 'DeepSeek';

    await bot.answerCallbackQuery(query.id, { text: `已选择 ${modelDisplayName} 模型` });

    try {
        await bot.editMessageText(`✅ 已选择 ${modelDisplayName} 模型，正在进入聊天模式...`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] }
        });
    } catch (err) {
        logger.error(`编辑模型选择消息失败: ${err.message}`);
    }

    const systemPrompt = await loadSystemPrompt();

    setUserState(userId, {
        mode: 'chat',
        lastActivity: Date.now(),
        history: [],
        model: model,
        fallbackModel: null,
        thinking: thinking,
        systemPrompt: systemPrompt,
        isWarmedUp: false,
        hasSystemPromptSent: false   // 关键
    });

    const modeText = thinking ? ' - 思考模式' : '';
    await bot.sendMessage(userId, `✅ 已进入聊天模式 (${modelDisplayName}${modeText})\n你可以直接和我聊天（10分钟无操作自动退出）。`)
        .catch(err => logger.error('发送进入提示失败:', err.message));
}

module.exports = handleSelectModelCallback;