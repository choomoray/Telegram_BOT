// handlers/modes/deleteMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { findMediaByFileUniqueId } = require('../../db/media');
const { deleteMediaByFileUniqueId } = require('../../db/media');
const { deleteMessageByFileUniqueId, findMessageByFileUniqueId } = require('../../db/message');
const { deleteGroupList, setGroupDelete } = require('../../db/groupList');
const { extractMediaFromMessage } = require('../../media');
const { deleteUserState } = require('../../states');

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
            } else {
                // 如果删除了有文本的媒体，且组内没有其他文本消息，则设置 is_delete 为时间戳
                if (hadText) {
                    const otherMessages = await getCollection(COLLECTIONS.MESSAGE).countDocuments({ group_id: groupId });
                    if (otherMessages === 0) {
                        await setGroupDelete(groupId, Date.now());
                        logger.info(`删除文本媒体后，组内无其他文本，设置 is_delete 为时间戳: group_id=${groupId}`);
                    }
                }
            }
        }

        await bot.editMessageText('✅ 数据已删除', {
            chat_id: userId,
            message_id: processingMsg.message_id
        });
        deleteUserState(userId);
        logger.info(`用户 ${userId} 删除单一媒体成功，group_id=${groupId}`);
    } catch (err) {
        logger.error(`删除失败: ${err.message}`);
        await bot.editMessageText('❌ 删除失败，请稍后重试', {
            chat_id: userId,
            message_id: processingMsg.message_id
        });
        deleteUserState(userId);
    }
    return true;
}

module.exports = handleDeleteMode;