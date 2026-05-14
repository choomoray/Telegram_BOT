// handlers/modes/chatMode/modelCall.js
const logger = require('../../../logger');
const { callDeepSeek, callDeepSeekStream } = require('../../../ai/deepseek');
const { callLMStudio, callLMStudioStream } = require('../../../ai/lmstudio');

/**
 * 调用模型（流式或非流式）
 * @param {string} model - 'lmstudio' 或 'deepseek'
 * @param {Array} messages - 消息列表
 * @param {boolean} streamOutput - 是否流式输出
 * @param {boolean} thinking - 思考模式
 * @param {function} onChunk - 流式回调
 * @returns {Promise<string>} 完整内容
 */
async function callModel(model, messages, streamOutput, thinking, onChunk) {
    if (model === 'lmstudio') {
        if (streamOutput) {
            let content = '';
            await callLMStudioStream(messages, (chunk) => {
                content += chunk;
                if (onChunk) onChunk(chunk);
            }, { temperature: thinking ? 0.2 : 0.7 });
            return content;
        } else {
            return await callLMStudio(messages, { temperature: thinking ? 0.2 : 0.7 });
        }
    } else if (model === 'deepseek') {
        if (streamOutput) {
            let content = '';
            await callDeepSeekStream(messages, thinking, (chunk) => {
                content += chunk;
                if (onChunk) onChunk(chunk);
            });
            return content;
        } else {
            return await callDeepSeek(messages, thinking, { temperature: thinking ? 0.2 : 0.7 });
        }
    } else {
        throw new Error(`不支持的模型: ${model}`);
    }
}

module.exports = { callModel };