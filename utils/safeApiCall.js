// utils/safeApiCall.js
const logger = require('../logger');

/**
 * 安全调用异步函数，自动重试特定错误
 * @param {Function} fn - 返回 Promise 的异步函数
 * @param {number} retries - 最大重试次数（默认3）
 * @param {number} delay - 重试间隔 ms（默认1000）
 * @returns {Promise<any>}
 */
async function safeApiCall(fn, retries = 3, delay = 1000) {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            const isRetryable = err.code === 429 || (err.response && err.response.status >= 500);
            if (i < retries && isRetryable) {
                logger.warn(`API 调用失败 (${err.message})，${delay}ms 后重试 (${i + 1}/${retries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw err;
        }
    }
}

module.exports = { safeApiCall };