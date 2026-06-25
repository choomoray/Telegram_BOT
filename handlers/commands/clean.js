// handlers/commands/clean.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    setUserState,
    deleteUserState,
    getRawUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { insertLog } = require('../../db/log');
const { repeatModeMsg } = require('../../utils/reply');

async function handleCleanCommand(userId, msg) {
    const rawState = getRawUserState(userId);
    if (rawState && rawState.mode === 'clean') {
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 重复发送 /clean，仅重置活动时间`);
        await bot.sendMessage(userId, repeatModeMsg('数据库清理', '请使用按钮操作或输入 /exit 退出'))
            .catch(err => logger.error('发送消息失败:', err.message));
        return;
    }

    await cleanPreviousMode(userId);

    let processingMsg;
    try {
        processingMsg = await bot.sendMessage(userId, '🔍 空数据查找中，请稍等...', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送查找中消息失败: ${err.message}`);
        return;
    }

    setUserState(userId, {
        mode: 'clean',
        lastActivity: Date.now(),
        processingMsgId: processingMsg.message_id,
        _onExit: async () => { }
    });

    logger.info(`用户 ${userId} 进入数据库清理模式，等待消息ID: ${processingMsg.message_id}`);

    insertLog(18, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));

    (async () => {
        try {
            const groupListCol = getCollection(COLLECTIONS.GROUP_LIST);
            const now = Date.now();

            const cursor = groupListCol.find({ is_delete: { $gt: 0 } });
            const allDocs = await cursor.toArray();
            const total = allDocs.length;

            const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
            const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;

            let weekCount = 0, monthCount = 0;
            for (const doc of allDocs) {
                const deleteTime = doc.is_delete;
                if (deleteTime <= oneWeekAgo) weekCount++;
                if (deleteTime <= oneMonthAgo) monthCount++;
            }

            const keyboard = {
                inline_keyboard: [
                    [{ text: `🧹 清理一周之前空数据 (${weekCount}条)`, callback_data: 'clean:week' }],
                    [{ text: `🧹 清理一个月之前空数据 (${monthCount}条)`, callback_data: 'clean:month' }],
                    [{ text: `🧹 清理全部空数据 (${total}条)`, callback_data: 'clean:all' }],
                    [{ text: `🧹 自定义清理 (${total}组)`, callback_data: 'clean:custom' }],
                    [{ text: '🚪 退出', callback_data: 'clean:exit' }]
                ]
            };

            await bot.editMessageText(`🔍 找到 ${total} 条空数据，点击按钮执行清除操作：`, {
                chat_id: userId,
                message_id: processingMsg.message_id,
                reply_markup: keyboard
            });

            logger.info(`用户 ${userId} 空数据查询完成，总数: ${total}, 一周: ${weekCount}, 一月: ${monthCount}`);
        } catch (err) {
            logger.error(`用户 ${userId} 查询空数据失败: ${err.message}`);
            await bot.editMessageText('❌ 查询失败，请稍后重试', {
                chat_id: userId,
                message_id: processingMsg.message_id
            }).catch(() => { });
            deleteUserState(userId);
        }
    })();
}

module.exports = handleCleanCommand;