// ai/lmstudio.js
const axios = require('axios');
const http = require('http');
const https = require('https');
const config = require('../config');
const logger = require('../logger');

// 确保 LMSTUDIO_API_URL 存在，并提取基础 URL
const apiUrl = config.LMSTUDIO_API_URL || 'http://localhost:1234/v1/chat/completions';
const baseURL = apiUrl.replace('/v1/chat/completions', '');

// 创建支持连接池的 HTTP 客户端
const httpClient = axios.create({
    baseURL: baseURL,
    timeout: config.LMSTUDIO_API_TIMEOUT || 60000,
    headers: { 'Content-Type': 'application/json' }
});

// 启用 keep-alive 连接池
const agentOptions = {
    keepAlive: true,
    maxSockets: config.CONNECTION_POOL?.maxSockets || 10
};
httpClient.defaults.httpAgent = new http.Agent(agentOptions);
httpClient.defaults.httpsAgent = new https.Agent(agentOptions);

/**
 * 非流式调用 LM Studio API（用于预热或一次性请求）
 * @param {Array} messages - 消息数组，格式同 OpenAI
 * @param {Object} options - 额外选项 { temperature, max_tokens }
 * @returns {Promise<string>} 完整回复内容
 */
async function callLMStudio(messages, options = {}) {
    const url = '/v1/chat/completions';
    const model = config.LMSTUDIO_MODEL;

    const requestBody = {
        model: model,
        messages: messages,
        stream: false,
        temperature: options.temperature || 0.7,
        max_tokens: options.max_tokens || -1,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.LMSTUDIO_API_TIMEOUT || 60000);

    try {
        const response = await httpClient.post(url, requestBody, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response.data.choices[0].message.content;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.code === 'ECONNREFUSED') {
            logger.error(`LM Studio 连接被拒绝，请确认服务是否在 ${config.LMSTUDIO_API_URL} 运行`);
        } else if (err.code === 'ECONNABORTED') {
            logger.error(`LM Studio 请求超时`);
        } else if (err.response) {
            logger.error(`LM Studio 返回错误: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
        } else {
            logger.error(`LM Studio API 调用失败: ${err.message}`);
        }
        throw err;
    }
}

/**
 * 流式调用 LM Studio API
 * @param {Array} messages - 消息数组
 * @param {function} onChunk - 收到每个文本块的回调
 * @param {Object} options - 额外选项 { temperature, max_tokens }
 * @returns {Promise<string>} 最终完整内容
 */
async function callLMStudioStream(messages, onChunk, options = {}) {
    const url = '/v1/chat/completions';
    const model = config.LMSTUDIO_MODEL;

    const requestBody = {
        model: model,
        messages: messages,
        stream: true,
        temperature: options.temperature || 0.7,
        max_tokens: options.max_tokens || -1,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.LMSTUDIO_API_TIMEOUT || 60000);

    try {
        const response = await httpClient.post(url, requestBody, {
            responseType: 'stream',
            signal: controller.signal
        });

        const stream = response.data;
        let fullContent = '';
        let buffer = '';

        return new Promise((resolve, reject) => {
            stream.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop(); // 保留可能不完整的最后一行

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') {
                            resolve(fullContent);
                            return;
                        }
                        try {
                            const parsed = JSON.parse(data);
                            const content = parsed.choices[0]?.delta?.content || '';
                            if (content) {
                                fullContent += content;
                                if (onChunk) onChunk(content);
                            }
                        } catch (e) {
                            // 忽略解析错误
                        }
                    }
                }
            });

            stream.on('end', () => {
                clearTimeout(timeoutId);
                resolve(fullContent);
            });

            stream.on('error', (err) => {
                clearTimeout(timeoutId);
                reject(err);
            });
        });
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.code === 'ECONNREFUSED') {
            logger.error(`LM Studio 连接被拒绝，请确认服务是否在 ${config.LMSTUDIO_API_URL} 运行`);
        } else if (err.code === 'ECONNABORTED') {
            logger.error(`LM Studio 请求超时`);
        } else if (err.response) {
            logger.error(`LM Studio 返回错误: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
        } else {
            logger.error(`LM Studio API 调用失败: ${err.message}`);
        }
        throw err;
    }
}

module.exports = { callLMStudio, callLMStudioStream };