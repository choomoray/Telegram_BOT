// handlers/modes/chatMode/aiQueue.js
const logger = require('../../../logger');

/**
 * 每用户独立 AI 请求队列
 * 保证同一用户的 AI 请求串行执行，不同用户互不阻塞。
 * 队列空闲超过 TTL 自动清理，避免 Map 无限增长。
 */
class AIQueue {
    constructor(ttlMs = 30 * 60 * 1000, sweepIntervalMs = 5 * 60 * 1000) {
        /** @type {Map<number, {tail: Promise, lastActivity: number}>} */
        this.queues = new Map();
        this.ttl = ttlMs;

        // 定期清理空闲队列（unref 避免影响进程退出）
        this._sweeper = setInterval(() => this.cleanup(), sweepIntervalMs);
        if (typeof this._sweeper.unref === 'function') {
            this._sweeper.unref();
        }
    }

    /**
     * 排队执行一个异步任务，确保同一用户的 AI 请求串行执行
     * @param {number} userId
     * @param {Function} task - 异步函数
     * @returns {Promise<any>} 任务结果（失败时 reject）
     */
    enqueue(userId, task) {
        let entry = this.queues.get(userId);
        if (!entry) {
            entry = { tail: Promise.resolve(), lastActivity: Date.now() };
            this.queues.set(userId, entry);
        }
        entry.lastActivity = Date.now();

        // 串行化：等上一个任务结束（吞掉其错误，避免断链）
        const run = entry.tail.catch(() => {}).then(() => task());

        // 链尾吞错，保证该用户后续任务不受影响
        entry.tail = run.catch((err) => {
            logger.error(`AI 队列任务失败 (user=${userId}): ${err.message}`);
        });

        return run;
    }

    /**
     * 清理空闲超过 TTL 的用户队列
     */
    cleanup() {
        const now = Date.now();
        let removed = 0;
        for (const [userId, entry] of this.queues) {
            if (now - entry.lastActivity > this.ttl) {
                this.queues.delete(userId);
                removed++;
            }
        }
        if (removed > 0) {
            logger.info(`AI 队列清理: 移除 ${removed} 个空闲用户队列，剩余 ${this.queues.size}`);
        }
    }

    /**
     * 当前活跃队列数（调试用）
     */
    get size() {
        return this.queues.size;
    }
}

// 全局单例
const globalQueue = new AIQueue();

module.exports = globalQueue;
