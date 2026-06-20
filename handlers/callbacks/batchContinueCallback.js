// handlers/callbacks/batchContinueCallback.js
const bot = require('../../bot');
const logger = require('../../logger');
const { sendMediaGroupBatched } = require('../../media');

/**
 * 分批发送继续回调
 * 数据格式: qbatch:groupId:subgroupIdx:sentSoFar:totalMedia:totalSubgroups
 */
async function handleBatchContinueCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 6 || parts[0] !== 'qbatch') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const groupId = parts[1];
    const subgroupIdx = parseInt(parts[2], 10);
    const sentSoFar = parseInt(parts[3], 10);
    const totalMedia = parseInt(parts[4], 10);
    const totalSubgroups = parseInt(parts[5], 10);

    await bot.answerCallbackQuery(query.id, { text: '📤 正在发送...' });

    try {
        const result = await sendMediaGroupBatched(query.from.id, groupId, subgroupIdx);
        const newSent = sentSoFar + result.sentInBatch;

        if (result.done) {
            // 编辑旧消息移除按钮
            await bot.editMessageText(`✅ 第 ${Math.ceil(sentSoFar / 40) + 1} 批已发送完毕`, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            }).catch(() => {});
            // 发送新消息通知完成
            await bot.sendMessage(query.from.id, '✅ 已全部发送完毕');
            logger.info(`用户 ${query.from.id} 分批发送完成 group_id=${groupId}，共 ${newSent} 个媒体`);
        } else {
            const remaining = totalMedia - newSent;
            const batchNum = Math.ceil(sentSoFar / 40) + 1;
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '📤 继续发送', callback_data: `qbatch:${groupId}:${result.nextSubgroupIdx}:${newSent}:${totalMedia}:${totalSubgroups}` },
                        { text: '⏹ 停止发送', callback_data: `qbatch_stop:${groupId}` }
                    ]
                ]
            };

            // 编辑旧消息移除按钮
            await bot.editMessageText(`✅ 第 ${batchNum} 批已发送 ${result.sentInBatch} 个媒体`, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            }).catch(() => {});

            // 发送新消息作为进度询问
            await bot.sendMessage(
                query.from.id,
                `📤 已发送 ${newSent}/${totalMedia} 个媒体（${result.nextSubgroupIdx}/${totalSubgroups} 组）\n还剩 ${remaining} 个媒体未发送\n是否继续？`,
                { reply_markup: keyboard }
            );
            logger.info(`用户 ${query.from.id} 分批发送进度: ${newSent}/${totalMedia}`);
        }
    } catch (err) {
        logger.error(`分批发送失败: ${err.message}`);
        await bot.editMessageText(`❌ 发送失败: ${err.message}`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
        }).catch(() => {});
    }
}

module.exports = handleBatchContinueCallback;
