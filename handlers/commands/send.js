// handlers/commands/send.js
/**
 * /send 指令：进入发送模式
 * 用户选择目标群组/频道后，可将消息/媒体/媒体组发送到该群组并收录
 */
const bot = require('../../bot');
const logger = require('../../logger');
const { setUserState, updateUserActivity } = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { insertLog } = require('../../db/log');

async function handleSendCommand(userId, msg) {
    updateUserActivity(userId);

    await cleanPreviousMode(userId);

    setUserState(userId, {
        mode: 'send',
        step: 'selecting',          // selecting: 等待选择目标群组/频道
        targetChatId: null,
        targetName: null,
        pendingMediaGroup: null,    // 媒体组暂存
        lastActivity: Date.now(),
        _onExit: async () => { }
    });

    logger.info(`用户 ${userId} 进入发送模式`);

    const { showGroupList } = require('../modes/sendMode');
    await showGroupList(userId, msg.message_id, 1);

    insertLog(25, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
}

module.exports = handleSendCommand;
