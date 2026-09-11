// handlers/modes/deleteMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { findMediaByFileUniqueId } = require('../../db/media');
const { deleteMediaByFileUniqueId } = require('../../db/media');
const { deleteMessageByFileUniqueId, findMessageByFileUniqueId } = require('../../db/message');
const { syncGroupDeleteByText, syncGroupTags, removeMediaGroupIfEmpty } = require('../../db/groupList');
const { extractMediaFromMessage } = require('../../media');
const { deleteUserState } = require('../../states');
const { logOperation } = require('../../utils/opLog');

async function handleDeleteMode(msg, state) {
    const userId = msg.from.id;
    const mediaInfo = extractMediaFromMessage(msg);

    if (!mediaInfo) {
        await bot.sendMessage(userId, '❌ 请发送媒体消息', {
            reply_to_message_id: msg.message_id
        });
        return true;
    }

    const fileUniqueId = mediaInfo.fileUniqueId;

    let processingMsg;
    try {
        processingMsg = await bot.sendMessage(userId, '🗑️ 正在删除...', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送删除中消息失败: ${err.message}`);
        return true;
    }

    let targetGroupId = null; // 供失败日志定位媒体组
    try {
        const mediaDoc = await findMediaByFileUniqueId(fileUniqueId);
        if (!mediaDoc) {
            await bot.editMessageText('❌ 该数据不存在', {
                chat_id: userId,
                message_id: processingMsg.message_id
            });
            deleteUserState(userId);
            return true;
        }

        const groupId = mediaDoc.group_id;
        targetGroupId = groupId;

        // 检查该媒体是否有文本记录
        const messageDoc = await findMessageByFileUniqueId(fileUniqueId);
        const hadText = !!messageDoc;

        // 删除该条媒体（及其 message 记录）
        await deleteMediaByFileUniqueId(fileUniqueId);
        if (hadText) {
            await deleteMessageByFileUniqueId(fileUniqueId);
        }

        // 组状态以 media 实际记录数为准：
        //   组内已无媒体 → 删除 group_list（并清掉残留 message）
        //   仍有媒体     → 重算 is_group
        const { removed, remaining } = await removeMediaGroupIfEmpty(groupId);
        if (removed) {
            logger.info(`删除媒体后组内已无媒体，已删除 group_list: group_id=${groupId}`);
        } else {
            // 组内还有媒体：若删掉的是有文本的媒体，按组内剩余文本统一重算 is_delete
            // （组内还有其他文本 → 0；已无文本 → 时间戳，可被 /clean 清理）
            if (hadText) {
                await syncGroupDeleteByText(groupId);
                logger.info(`删除文本媒体后按组内文本重算 is_delete: group_id=${groupId}`);
            }
            // 剩余媒体仍带标签时同步 group_list.tags（删掉的恰好是唯一带标签那条）
            await syncGroupTags(groupId);
        }

        await bot.editMessageText('✅ 数据已删除', {
            chat_id: userId,
            message_id: processingMsg.message_id
        });
        deleteUserState(userId);
        logOperation({
            action: 'media_delete_one',
            source: 'private',
            userId,
            target: { type: 'media_group', id: groupId },
            counts: { media: 1 },
            detail: {
                hadText,
                deletedGroup: removed,
                remaining,
                mediaType: mediaDoc.media_type,
                fileUniqueId
            }
        }).catch(() => { });
        logger.info(`用户 ${userId} 删除单一媒体成功，group_id=${groupId}`);
    } catch (err) {
        logger.error(`删除失败: ${err.message}`);
        logOperation({
            action: 'media_delete_one',
            result: 'fail',
            source: 'private',
            userId,
            target: { type: 'media_group', id: targetGroupId || fileUniqueId },
            detail: {
                mediaType: mediaInfo.type,
                fileUniqueId
            },
            error: err.message
        }).catch(() => { });
        await bot.editMessageText('❌ 删除失败，请稍后重试', {
            chat_id: userId,
            message_id: processingMsg.message_id
        });
        deleteUserState(userId);
    }
    return true;
}

module.exports = handleDeleteMode;