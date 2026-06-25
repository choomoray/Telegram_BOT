// handlers/commands/delete.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    setUserState,
    deleteUserState,
    getRawUserState
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { insertLog } = require('../../db/log');
const { entryMsg } = require('../../utils/reply');

async function handleDeleteCommand(userId, msg) {
    const rawState = getRawUserState(userId);
    if (rawState && (rawState.mode === 'delete' || rawState.mode === 'delete_group')) {
        logger.info(`用户 ${userId} 重复发送 /delete，重置状态`);
        deleteUserState(userId);
    }

    await cleanPreviousMode(userId);

    let processingMsg;
    try {
        processingMsg = await bot.sendMessage(userId, entryMsg('数据删除模式', '请发送要删除的媒体'), {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送删除模式提示失败: ${err.message}`);
        return;
    }

    setUserState(userId, {
        mode: 'delete',
        deleteType: 'single',
        processingMsgId: processingMsg.message_id,
        lastActivity: Date.now(),
        _onExit: async () => { }
    });

    logger.info(`用户 ${userId} 进入【单一媒体删除模式】，等待消息ID: ${processingMsg.message_id}`);

    insertLog(19, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
}

module.exports = handleDeleteCommand;