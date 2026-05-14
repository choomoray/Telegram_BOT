// handlers/callbacks/toggleThinking.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getRawUserState, setUserState } = require('../../states');

async function handleToggleThinkingCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 2 || parts[0] !== 'toggle_thinking') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const model = parts[1];
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const message = query.message;

    if (!message.reply_markup || !message.reply_markup.inline_keyboard) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 消息已过期' });
        return;
    }

    const keyboard = message.reply_markup.inline_keyboard;
    let updated = false;

    for (let row of keyboard) {
        if (row.length === 2) {
            const modelButton = row[0];
            const toggleButton = row[1];
            if (modelButton.callback_data && modelButton.callback_data.startsWith(`select_model:${model}`)) {
                const currentThinking = modelButton.callback_data.includes('thinking_on');
                const newThinking = !currentThinking;
                modelButton.callback_data = `select_model:${model}:${newThinking ? 'thinking_on' : 'thinking_off'}`;
                toggleButton.text = newThinking ? '思考:开' : '思考:关';
                updated = true;
                break;
            }
        }
    }

    if (!updated) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 未找到对应模型' });
        return;
    }

    try {
        await bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, {
            chat_id: chatId,
            message_id: messageId
        });
        await bot.answerCallbackQuery(query.id, { text: `思考模式已切换` });
        logger.info(`用户 ${query.from.id} 切换模型 ${model} 思考模式`);

        // 如果当前处于聊天模式，同步更新状态中的 thinking 值
        const currentState = getRawUserState(userId);
        if (currentState && currentState.mode === 'chat' && currentState.model === model) {
            const newThinking = currentState.thinking ? false : true;
            setUserState(userId, {
                ...currentState,
                thinking: newThinking
            });
        }
    } catch (err) {
        logger.error(`切换思考模式失败: ${err.message}`);
        await bot.answerCallbackQuery(query.id, { text: '❌ 切换失败' });
    }
}

module.exports = handleToggleThinkingCallback;