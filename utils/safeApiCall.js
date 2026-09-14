// utils/safeApiCall.js
const logger = require('../logger');

/**
 * 网络类临时错误码（node-telegram-bot-api / Node 底层抛出）
 * 这些错误**没有** err.response，旧实现只看 `code === 429 || status >= 500`，
 * 于是网络抖动一律不重试 —— 这正是"随机图片 / /log 时好时坏"的主因之一。
 */
const RETRYABLE_CODES = new Set([
    'EFATAL',            // node-telegram-bot-api 的网络层致命错误
    'ETIMEDOUT',         // 连接/响应超时
    'ESOCKETTIMEDOUT',   // socket 超时
    'ECONNRESET',        // 连接被重置
    'ECONNREFUSED',      // 连接被拒绝（服务端瞬时不可用）
    'EPIPE',             // 写入已关闭的连接
    'EAI_AGAIN',         // DNS 临时失败
    'ENOTFOUND',         // DNS 解析失败（瞬时抖动）
    'ETELEGRAM_429',     // 少数封装会把限流折成这个码
    'ERR_STREAM_PREMATURE_CLOSE'
]);

/**
 * 判断错误是否值得重试
 *
 * 覆盖：
 *   - HTTP 429（限流）/ 5xx（服务端瞬时故障）
 *   - 网络类错误码（超时 / 重置 / DNS 抖动）
 *   - Telegram 的 `retry after N` 描述
 * 明确**不重试**的：400 参数错误、403 无权限、"message is not modified" 这类业务错误
 * （重试也不会有不同结果，只会拖慢响应）。
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isRetryableError(err) {
    if (!err) return false;

    // Telegram 官方建议的重试秒数（限流）——最明确的信号
    const desc = String(err.description || err.message || '');
    if (/retry after \d+/i.test(desc)) return true;

    // 业务性 400：明确不可重试
    if (/message is not modified|message can't be edited|message to edit not found|chat not found|not enough rights|can't parse entities/i.test(desc)) {
        return false;
    }

    if (err.code && RETRYABLE_CODES.has(err.code)) return true;

    const status = err.response && err.response.status;
    if (status === 429) return true;
    if (typeof status === 'number' && status >= 500 && status < 600) return true;

    // 少数情况：status 挂在 err.code 上（字符串数字）
    const numericCode = Number(err.code);
    if (Number.isFinite(numericCode) && (numericCode === 429 || (numericCode >= 500 && numericCode < 600))) {
        return true;
    }

    return false;
}

/**
 * 安全调用异步函数，自动重试临时性错误
 * @param {Function} fn - 返回 Promise 的异步函数
 * @param {number} retries - 最大重试次数（默认3）
 * @param {number} delay - 重试间隔 ms（默认1000，指数退避：delay * 2^n）
 * @returns {Promise<any>}
 */
async function safeApiCall(fn, retries = 3, delay = 1000) {
    let lastError;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (i < retries && isRetryableError(err)) {
                const wait = delay * Math.pow(2, i); // 1s → 2s → 4s
                logger.warn(`API 调用失败 (${err.message})，${wait}ms 后重试 (${i + 1}/${retries})`);
                await new Promise(resolve => setTimeout(resolve, wait));
                continue;
            }
            throw err;
        }
    }
    throw lastError;
}

module.exports = { safeApiCall, isRetryableError, RETRYABLE_CODES };
