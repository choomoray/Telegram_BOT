// handlers/modes/searchMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { findMediaByFileUniqueId } = require('../../db/media');
const { findMessageByFileUniqueId } = require('../../db/message');
const { deleteUserState } = require('../../states');
const { generateMessageLink } = require('../../utils/chatIdConverter');
const { extractMediaFromMessage } = require('../../media');

async function handleSearchMode(msg, state) {
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
        processingMsg = await bot.sendMessage(userId, '🔍 正在查找中...', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送查找中消息失败: ${err.message}`);
        return true;
    }

    try {
        let found = await findMessageByFileUniqueId(fileUniqueId);
        if (!found) {
            const mediaDoc = await findMediaByFileUniqueId(fileUniqueId);
            if (mediaDoc) {
                const messageCol = getCollection(COLLECTIONS.MESSAGE);
                found = await messageCol.findOne({ group_id: mediaDoc.group_id });
            }
        }

        if (!found) {
            await bot.editMessageText('❌ 很遗憾，没有找到', {
                chat_id: userId,
                message_id: processingMsg.message_id
            });
            deleteUserState(userId);
            logger.info(`用户 ${userId} 查找模式未找到媒体，自动退出`);
            return true;
        }

        const link = generateMessageLink(found.chat_id, found.message_id);
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '直接查看', callback_data: `qdirect:${found.group_id}` },
                    { text: '跳转查看', url: link }
                ]
            ]
        };

        await bot.editMessageText('✅ 找到了，请选择查看方式', {
            chat_id: userId,
            message_id: processingMsg.message_id,
            reply_markup: keyboard
        });

        deleteUserState(userId);
        logger.info(`用户 ${userId} 查找模式找到媒体，自动退出`);
    } catch (err) {
        logger.error(`查找模式处理失败: ${err.message}`);
        await bot.editMessageText('❌ 查找失败，请稍后重试', {
            chat_id: userId,
            message_id: processingMsg.message_id
        });
        deleteUserState(userId);
    }
    return true;
}

module.exports = handleSearchMode;