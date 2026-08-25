// handlers/shutdownCleanup.js
/**
 * 收到关闭信号时的立即清理：
 * 1. 立即执行所有"定时删除"的群组消息（处理中/收录成功等，不再等待 60s 定时器）
 * 2. 删除消息回复模式遗留的群组/频道提示消息（"💬 正在回复该消息"）
 * （日志队列刷盘由 index.js 在关闭流程中另行调用 logger.flushLogs）
 */
const logger = require('../logger');

async function cleanupOnShutdown() {
    // 1. 定时删除消息立即执行
    try {
        const { flushPendingDeletions } = require('./groupMessageHandlers');
        await flushPendingDeletions();
    } catch (err) {
        logger.warn(`关闭清理: 立即删除定时消息失败: ${err.message}`);
    }

    // 2. 删除消息回复模式遗留提示消息
    try {
        const messageReplyMode = require('./modes/messageReplyMode');
        await messageReplyMode.cleanupHintMessagesOnShutdown();
    } catch (err) {
        logger.warn(`关闭清理: 删除提示消息失败: ${err.message}`);
    }
}

module.exports = { cleanupOnShutdown };
