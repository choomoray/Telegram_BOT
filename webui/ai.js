// webui/ai.js
/**
 * DeepSeek API 客户端（Web UI AI 辅助用，零依赖，使用 Node 内置 fetch）
 */
const config = require('../config');
const logger = require('../logger');

/**
 * 调用 DeepSeek Chat Completions（非流式）
 * @param {Array} messages - [{role, content}, ...]
 * @param {Object} options - { apiKey, apiUrl, model, timeout, temperature, maxTokens }
 * @returns {Promise<string>} 模型回复文本
 */
async function callDeepSeek(messages, options = {}) {
    const apiKey = options.apiKey || config.DEEPSEEK_API_KEY;
    const apiUrl = options.apiUrl || config.DEEPSEEK_API_URL;
    const model = options.model || config.DEEPSEEK_MODEL;
    const timeout = options.timeout || config.DEEPSEEK_API_TIMEOUT;

    if (!apiKey) {
        throw new Error('未配置 DEEPSEEK_API_KEY（请在 .env 中设置）');
    }

    const body = {
        model,
        messages,
        stream: false,
        temperature: options.temperature !== undefined ? options.temperature : 0.1,
        max_tokens: options.maxTokens || 4096
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        logger.info(`[WebUI-AI] 调用 DeepSeek: model=${model}, messages=${messages.length}条`);
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`DeepSeek API 错误 ${res.status}: ${text.slice(0, 200)}`);
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
            throw new Error('DeepSeek 返回内容为空');
        }
        return content;
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`DeepSeek 请求超时（${timeout}ms）`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { callDeepSeek };
