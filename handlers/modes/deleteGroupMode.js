// handlers/modes/deleteGroupMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { findMediaByFileUniqueId } = require('../../db/media');
const { deleteMediaByFileUniqueId } = require('../../db/media');
const { deleteMessageByFileUniqueId } = require('../../db/message');
const { deleteGroupList } = require('../../db/groupList');
const { extractMediaFromMessage } = require('../../media');
const { deleteUserState } = require('../../states');

async function handleDeleteGroupMode(msg, state) {
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
        processingMsg = await bot.sendMessage(userId, '🗑️ 正在删除媒体组...', {
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
        const mediaCol = getCollection(COLLECTIONS.MEDIA);
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const groupListCol = getCollection(COLLECTIONS.GROUP_LIST);

        // 删除该组的所有媒体
        await mediaCol.deleteMany({ group_id: groupId });
        // 删除该组的所有消息
        await messageCol.deleteMany({ group_id: groupId });
        // 删除 group_list 记录
        await deleteGroupList(groupId);

        await bot.editMessageText('✅ 媒体组已删除', {
            chat_id: userId,
            message_id: processingMsg.message_id
        });
        deleteUserState(userId);
        logger.info(`用户 ${userId} 删除媒体组成功，group_id=${groupId}`);
    } catch (err) {
        logger.error(`删除媒体组失败: ${err.message}`);
        await bot.editMessageText('❌ 删除失败，请稍后重试', {
            chat_id: userId,
            message_id: processingMsg.message_id
        });
        deleteUserState(userId);
    }
    return true;
}

module.exports = handleDeleteGroupMode;