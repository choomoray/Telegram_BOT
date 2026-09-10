// handlers/modes/deleteMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { findMediaByFileUniqueId } = require('../../db/media');
const { deleteMediaByFileUniqueId } = require('../../db/media');
const { deleteMessageByFileUniqueId, findMessageByFileUniqueId } = require('../../db/message');
const { deleteGroupList, syncGroupDeleteByText } = require('../../db/groupList');
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
        const groupListCol = getCollection(COLLECTIONS.GROUP_LIST);
        const groupDoc = await groupListCol.findOne({ group_id: groupId });

        if (!groupDoc) {
            await bot.editMessageText('❌ 数据异常，请稍后重试', {
                chat_id: userId,
                message_id: processingMsg.message_id
            });
            deleteUserState(userId);
            return true;
        }

        // 检查该媒体是否有文本记录
        const messageDoc = await findMessageByFileUniqueId(fileUniqueId);
        const hadText = !!messageDoc;

        if (groupDoc.is_group === 1) {
            // 唯一媒体，删除整个组
            await deleteMediaByFileUniqueId(fileUniqueId);
            if (hadText) {
                await deleteMessageByFileUniqueId(fileUniqueId);
            }
            await deleteGroupList(groupId);
        } else {
            // 组内还有其他媒体，仅删除当前媒体，并减少计数
            await deleteMediaByFileUniqueId(fileUniqueId);
            if (hadText) {
                await deleteMessageByFileUniqueId(fileUniqueId);
            }
            await groupListCol.updateOne(
                { group_id: groupId },
                { $inc: { is_group: -1 } }
            );

            // 检查更新后的 is_group 值，如果变为 0，则删除该组记录
            const updatedGroup = await groupListCol.findOne({ group_id: groupId });
            if (updatedGroup && updatedGroup.is_group === 0) {
                await deleteGroupList(groupId);
                logger.info(`删除媒体后 group_list 计数归零，已删除 group_id=${groupId}`);
            } else if (hadText) {
                // 删除的是有文本的媒体 → 按组内剩余文本统一重算 is_delete
                // （组内还有其他文本 → 0；已无文本 → 时间戳，可被 /clean 清理）
                await syncGroupDeleteByText(groupId);
                logger.info(`删除文本媒体后按组内文本重算 is_delete: group_id=${groupId}`);
            }
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
                deletedGroup: groupDoc.is_group === 1,
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