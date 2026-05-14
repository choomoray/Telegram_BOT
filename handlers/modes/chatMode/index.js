// handlers/modes/chatMode/index.js
const logger = require('../../../logger');
const { getSettings } = require('../../../db/settings');
const { setUserState, updateUserActivity, deleteUserState } = require('../../../states');
const { callModel } = require('./modelCall');
const { safeEditMessage, cleanReply, parseAIReply } = require('./utils');
const { processAIReply } = require('./processAIReply');
const bot = require('../../../bot');
const aiQueue = require('./aiQueue');  // 新增

async function handleChatMode(msg, state) {
    const userId = msg.from.id;
    const messageText = msg.text;

    if (!messageText) {
        await bot.sendMessage(userId, '❌ 聊天模式只支持文本消息');
        return true;
    }

    logger.info(`[聊天模式] 用户 ${userId} 发送: ${messageText}`);
    updateUserActivity(userId);

    const settings = await getSettings();
    const streamOutput = settings.STREAM_OUTPUT;
    const updateInterval = settings.STREAM_UPDATE_INTERVAL;

    let thinkingMsg;
    try {
        thinkingMsg = await bot.sendMessage(userId, '♻️ 思考中...', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送思考中消息失败: ${err.message}`);
        return true;
    }

    // 将整个 AI 处理流程放入队列，防止同一用户并发请求
    aiQueue.enqueue(userId, async () => {
        const systemPrompt = state.systemPrompt || '你是一个智能聊天助手。';
        const history = state.history || [];
        const hasSystemPromptSent = state.hasSystemPromptSent || false;

        let baseMessages;
        if (!hasSystemPromptSent) {
            baseMessages = [
                { role: 'system', content: systemPrompt },
                ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
                { role: 'user', content: messageText }
            ];
        } else {
            baseMessages = [
                ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
                { role: 'user', content: messageText }
            ];
        }

        let currentMessages = [...baseMessages];
        let currentModel = state.model || 'deepseek';
        const thinking = state.thinking || false;

        let accumulatedContent = '';
        let lastUpdateContent = '';
        let updateTimer = null;

        if (streamOutput) {
            updateTimer = setInterval(() => {
                if (accumulatedContent !== lastUpdateContent) {
                    safeEditMessage(thinkingMsg, userId, accumulatedContent || '...');
                    lastUpdateContent = accumulatedContent;
                }
            }, updateInterval);
        }

        let usedModel = currentModel;
        let streamFinished = false;
        try {
            const onChunk = (chunk) => { accumulatedContent += chunk; };
            await callModel(currentModel, currentMessages, streamOutput, thinking, onChunk);
            streamFinished = true;
        } catch (err) {
            logger.warn(`用户 ${userId} 使用模型 ${currentModel} 失败: ${err.message}`);
            const alternative = currentModel === 'lmstudio' ? 'deepseek' : 'lmstudio';
            logger.info(`正在切换到备用模型 ${alternative}...`);
            try {
                const onChunk = (chunk) => { accumulatedContent += chunk; };
                await callModel(alternative, currentMessages, streamOutput, thinking, onChunk);
                usedModel = alternative;
                streamFinished = true;
                logger.info(`用户 ${userId} 成功切换到模型 ${alternative}`);
            } catch (fallbackErr) {
                logger.error(`备用模型也失败: ${fallbackErr.message}`);
                if (updateTimer) clearInterval(updateTimer);
                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: '本地 LM Studio', callback_data: 'retry_model:lmstudio' },
                            { text: 'DeepSeek', callback_data: 'retry_model:deepseek' }
                        ]
                    ]
                };
                await safeEditMessage(thinkingMsg, userId, '⚠️ 连接所有模型失败，请选择要重试的模型：', keyboard);
                deleteUserState(userId);
                return;
            }
        }

        if (updateTimer) clearInterval(updateTimer);
        if (streamFinished) {
            const cleanedRaw = cleanReply(accumulatedContent);
            const blocks = parseAIReply(cleanedRaw);
            const context = {
                userId,
                currentModel: usedModel,
                streamOutput,
                thinking,
                thinkingMsg,
                history,
                messageText,
                state,
                setState: (newState) => setUserState(userId, newState),
                deleteState: () => deleteUserState(userId)
            };
            const finalUserMessage = await processAIReply(blocks, currentMessages, context);
            const finalText = finalUserMessage || cleanedRaw;

            logger.info(`[聊天模式] 智能体回复用户 ${userId} (模型: ${usedModel}): ${finalText}`);

            if (finalUserMessage) {
                await safeEditMessage(thinkingMsg, userId, finalUserMessage);
            } else if (cleanedRaw && cleanedRaw.trim()) {
                await safeEditMessage(thinkingMsg, userId, cleanedRaw);
            } else {
                await safeEditMessage(thinkingMsg, userId, '❌ 无法处理您的请求，请稍后重试。');
            }

            const newState = {
                ...state,
                lastActivity: Date.now(),
                model: usedModel,
                hasSystemPromptSent: true,
                history: [
                    ...history,
                    { role: 'user', content: messageText },
                    { role: 'assistant', content: finalText }
                ].slice(-20)
            };
            setUserState(userId, newState);
        } else {
            await safeEditMessage(thinkingMsg, userId, '❌ 请求失败，请稍后重试');
            deleteUserState(userId);
        }
    });

    return true;
}

module.exports = handleChatMode;