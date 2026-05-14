// ai/deepseek.js
const axios = require('axios');
const http = require('http');
const https = require('https');
const config = require('../config');
const logger = require('../logger');

// 构建基础 URL
const apiUrl = config.DEEPSEEK_API_URL;
const baseURL = apiUrl.replace(/\/v1\/chat\/completions$/, '');

const httpClient = axios.create({
    baseURL: baseURL,
    timeout: config.DEEPSEEK_API_TIMEOUT,
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.DEEPSEEK_API_KEY}`
    }
});

// 启用 keep-alive 连接池
const agentOptions = {
    keepAlive: true,
    maxSockets: config.CONNECTION_POOL?.maxSockets || 10
};
httpClient.defaults.httpAgent = new http.Agent(agentOptions);
httpClient.defaults.httpsAgent = new https.Agent(agentOptions);

/**
 * 非流式调用（用于预热或一次性请求）
 * @param {Array} messages - 消息数组
 * @param {Object} options - 额外选项 { temperature, max_tokens }
 * @returns {Promise<string>}
 */
async function callDeepSeek(messages, thinking = false, options = {}) {
    const url = '/v1/chat/completions';
    const model = config.DEEPSEEK_MODEL;

    const requestBody = {
        model: model,
        messages: messages,
        stream: false,
        temperature: options.temperature || (thinking ? 0.2 : 0.7),
        max_tokens: options.max_tokens || -1,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.DEEPSEEK_API_TIMEOUT);

    try {
        const response = await httpClient.post(url, requestBody, { signal: controller.signal });
        clearTimeout(timeoutId);
        return response.data.choices[0].message.content;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.code === 'ECONNREFUSED') {
            logger.error(`DeepSeek 连接被拒绝，请确认服务是否在 ${config.DEEPSEEK_API_URL} 运行`);
        } else if (err.code === 'ECONNABORTED') {
            logger.error(`DeepSeek 请求超时`);
        } else if (err.response) {
            logger.error(`DeepSeek 返回错误: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
        } else {
            logger.error(`DeepSeek API 调用失败: ${err.message}`);
        }
        throw err;
    }
}

/**
 * 流式调用
 * @param {Array} messages - 消息数组
 * @param {boolean} thinking - 是否思考模式（影响温度）
 * @param {function} onChunk - 文本块回调
 * @param {Object} options - 额外选项
 * @returns {Promise<string>}
 */
async function callDeepSeekStream(messages, thinking = false, onChunk, options = {}) {
    const url = '/v1/chat/completions';
    const model = config.DEEPSEEK_MODEL;

    const requestBody = {
        model: model,
        messages: messages,
        stream: true,
        temperature: options.temperature || (thinking ? 0.2 : 0.7),
        max_tokens: options.max_tokens || -1,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.DEEPSEEK_API_TIMEOUT);

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
                buffer = lines.pop();

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
            logger.error(`DeepSeek 连接被拒绝，请确认服务是否在 ${config.DEEPSEEK_API_URL} 运行`);
        } else if (err.code === 'ECONNABORTED') {
            logger.error(`DeepSeek 请求超时`);
        } else if (err.response) {
            logger.error(`DeepSeek 返回错误: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
        } else {
            logger.error(`DeepSeek API 调用失败: ${err.message}`);
        }
        throw err;
    }
}

module.exports = { callDeepSeek, callDeepSeekStream };