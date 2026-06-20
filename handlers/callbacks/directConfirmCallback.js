// handlers/callbacks/directConfirmCallback.js
const bot = require('../../bot');
const logger = require('../../logger');
const { sendMediaGroupBatched } = require('../../media');

async function handleDirectConfirmCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 2 || parts[0] !== 'qdirect_confirm') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const groupId = parts[1];
    await bot.answerCallbackQuery(query.id, { text: '📤 正在发送...' });

    try {
        const result = await sendMediaGroupBatched(query.from.id, groupId, 0, 5);
        const sent = result.sentInBatch;

        if (result.done) {
            await bot.editMessageText('✅ 已全部发送完毕', {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            }).catch(() => {});
            logger.info(`用户 ${query.from.id} 发送完成 group_id=${groupId}，共 ${sent} 个媒体`);
        } else {
            const remaining = result.totalMedia - sent;
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '📤 继续发送', callback_data: `qbatch:${groupId}:${result.nextSubgroupIdx}:${sent}:${result.totalMedia}:${result.totalSubgroups}` },
                        { text: '⏹ 停止发送', callback_data: `qbatch_stop:${groupId}` }
                    ]
                ]
            };

            // 将确认消息改为"已开始发送"
            await bot.editMessageText(`✅ 开始发送，第 1 批已发送 ${sent} 个媒体`, {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            }).catch(() => {});

            // 发送新消息作为进度询问
            await bot.sendMessage(
                query.from.id,
                `📤 已发送 ${sent}/${result.totalMedia} 个媒体（${result.nextSubgroupIdx}/${result.totalSubgroups} 组）\n还剩 ${remaining} 个媒体未发送\n是否继续？`,
                { reply_markup: keyboard }
            );
            logger.info(`用户 ${query.from.id} 确认发送首批: ${sent}/${result.totalMedia}`);
        }
    } catch (err) {
        logger.error(`直接确认发送失败: ${err.message}`);
        await bot.sendMessage(query.from.id, `❌ 发送失败: ${err.message}`);
    }
}

module.exports = handleDirectConfirmCallback;