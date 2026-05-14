// handlers/commands/chat.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getUserState,
    setUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { loadSystemPrompt } = require('../../utils/loadSystemPrompt');

async function handleChatCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'chat') {
        logger.info(`用户 ${userId} 重复发送 /chat，仅重置活动时间`);
        await bot.sendMessage(userId, '您已经在聊天模式中，继续对话吧～').catch(() => { });
        updateUserActivity(userId);
        return;
    }

    await cleanPreviousMode(userId);

    const systemPrompt = await loadSystemPrompt();

    setUserState(userId, {
        mode: 'chat',
        lastActivity: Date.now(),
        systemPrompt: systemPrompt,
        history: [],
        isWarmedUp: false,
        model: 'deepseek',
        fallbackModel: null,
        thinking: false,
        hasSystemPromptSent: false,
        _onExit: async (uid) => {
            // 聊天模式退出时无需额外清理
            logger.info(`用户 ${uid} 退出聊天模式`);
        }
    });

    await bot.sendMessage(userId, '✅ 已进入聊天模式，现在你可以和我说话了。')
        .catch(err => logger.error('发送欢迎消息失败:', err.message));
}

module.exports = handleChatCommand;