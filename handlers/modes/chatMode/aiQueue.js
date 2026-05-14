// handlers/modes/chatMode/aiQueue.js
const logger = require('../../../logger');

class AIQueue {
    constructor() {
        this.queue = Promise.resolve();
    }

    /**
     * 排队执行一个异步任务，确保同一个用户的 AI 请求串行执行
     * @param {number} userId
     * @param {Function} task - 异步函数
     * @returns {Promise<any>}
     */
    async enqueue(userId, task) {
        const previous = this.queue;
        let resolve;
        this.queue = new Promise((res) => { resolve = res; });

        await previous;
        try {
            return await task();
        } catch (err) {
            throw err;
        } finally {
            resolve();
        }
    }
}

// 全局单例
const globalQueue = new AIQueue();

module.exports = globalQueue;