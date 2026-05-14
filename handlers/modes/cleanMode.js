// handlers/modes/cleanMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { getRawUserState, setUserState } = require('../../states');
const { extractMediaFromMessage } = require('../../media');
const { deleteGroupList } = require('../../db/groupList');

async function handleCleanMode(msg, state) {
    const userId = msg.from.id;
    // 如果是在自定义清理子状态
    if (state.step === 'custom') {
        const mediaInfo = extractMediaFromMessage(msg);
        if (!mediaInfo) {
            // 非媒体消息忽略
            logger.info(`用户 ${userId} 在自定义清理中发送非媒体消息，已忽略`);
            return true;
        }

        const fileUniqueId = mediaInfo.fileUniqueId;
        const currentState = getRawUserState(userId);
        if (!currentState || currentState.mode !== 'clean' || currentState.step !== 'custom') {
            return true;
        }

        // 在 allMedia 中查找该媒体
        const mediaItem = currentState.allMedia.find(item => item.fileUniqueId === fileUniqueId && !item.deleted);
        if (!mediaItem) {
            await bot.sendMessage(userId, '❌ 该媒体不在待清理列表中或已被删除', {
                reply_to_message_id: msg.message_id
            });
            return true;
        }

        const targetGroupId = mediaItem.groupId;

        // 执行删除操作：删除该组所有媒体
        try {
            const mediaCol = getCollection(COLLECTIONS.MEDIA);
            const messageCol = getCollection(COLLECTIONS.MESSAGE);
            const groupListCol = getCollection(COLLECTIONS.GROUP_LIST);

            // 从 media 删除该组所有
            await mediaCol.deleteMany({ group_id: targetGroupId });
            // 从 message 删除该组所有
            await messageCol.deleteMany({ group_id: targetGroupId });
            // 从 group_list 删除该组
            await deleteGroupList(targetGroupId);

            // 更新状态：将该组所有媒体标记为已删除
            let deletedCount = 0;
            currentState.allMedia.forEach(item => {
                if (item.groupId === targetGroupId && !item.deleted) {
                    item.deleted = true;
                    deletedCount++;
                }
            });

            setUserState(userId, currentState);

            await bot.sendMessage(userId, `✅ 已删除该组（共 ${deletedCount} 个媒体）`, {
                reply_to_message_id: msg.message_id
            });
            logger.info(`用户 ${userId} 在自定义清理中删除了组 ${targetGroupId}，共 ${deletedCount} 个媒体`);
        } catch (err) {
            logger.error(`自定义清理删除组失败: ${err.message}`);
            await bot.sendMessage(userId, '❌ 删除失败，请稍后重试', {
                reply_to_message_id: msg.message_id
            });
        }

        return true;
    }

    // 非自定义状态，忽略消息
    logger.info(`用户 ${userId} 在清理模式，等待按钮操作`);
    return true;
}

module.exports = handleCleanMode;