// handlers/cleanHelpers.js
const bot = require('../bot');
const logger = require('../logger');
const { getRawUserState, setUserState } = require('../states');
const { sendMediaGroupAsReply } = require('../media');

/**
 * 发送下一组媒体（按组发送）
 */
async function sendNextBatch(userId, chatId) {
    const state = getRawUserState(userId);
    if (!state || state.mode !== 'clean' || state.step !== 'custom') return;

    if (state.awaitingContinue) return; // 正在等待继续确认

    const allMedia = state.allMedia;

    // 找出所有未发送且未删除的媒体，按 groupId 分组
    const pendingByGroup = new Map();
    for (const item of allMedia) {
        if (!item.sent && !item.deleted) {
            const groupId = item.groupId;
            if (!pendingByGroup.has(groupId)) {
                pendingByGroup.set(groupId, []);
            }
            pendingByGroup.get(groupId).push(item);
        }
    }

    if (pendingByGroup.size === 0) {
        // 没有待发送的组了，保持状态，提示用户可以手动删除
        await bot.sendMessage(chatId, '✅ 所有待清理媒体已发送完毕。现在你可以发送想要删除的媒体（或媒体组），或输入 /exit 退出。');
        return;
    }

    // 选择第一个组（按 groupId 排序）
    const sortedGroupIds = Array.from(pendingByGroup.keys()).sort();
    const currentGroupId = sortedGroupIds[0];
    const groupMedia = pendingByGroup.get(currentGroupId);

    // 计算组内媒体数量
    const groupSize = groupMedia.length;
    logger.info(`用户 ${userId} 自定义清理发送组 ${currentGroupId}，共 ${groupSize} 个媒体`);

    // 分批发送（每组最多10个）
    const MAX_ALBUM_SIZE = 10;
    for (let i = 0; i < groupMedia.length; i += MAX_ALBUM_SIZE) {
        const chunk = groupMedia.slice(i, i + MAX_ALBUM_SIZE);
        try {
            await sendMediaGroupAsReply(chatId, undefined, chunk);
            logger.info(`用户 ${userId} 自定义清理发送组内一批媒体，共 ${chunk.length} 个`);
        } catch (err) {
            logger.error(`发送自定义清理媒体组失败: ${err.message}`);
            return;
        }

        // 短暂延时避免频率限制
        if (i + MAX_ALBUM_SIZE < groupMedia.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    // 标记该组所有媒体为已发送
    groupMedia.forEach(item => { item.sent = true; });
    state.sentCount = (state.sentCount || 0) + groupSize;
    setUserState(userId, state);

    // 检查是否需要询问继续（累计发送满20个媒体后询问）
    if (state.sentCount >= 20) {
        // 询问是否继续
        const continueMsg = await bot.sendMessage(chatId, '是否继续发送下一批？', {
            reply_markup: {
                inline_keyboard: [[
                    { text: '继续', callback_data: 'clean_continue' }
                ]]
            }
        });
        state.awaitingContinue = true;
        state.continueMsgId = continueMsg.message_id;
        setUserState(userId, state);
    } else {
        // 立即发送下一组
        setImmediate(() => sendNextBatch(userId, chatId));
    }
}

module.exports = { sendNextBatch };