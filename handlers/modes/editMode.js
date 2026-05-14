// handlers/modes/editMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { findMediaByFileUniqueId } = require('../../db/media');
const { setGroupDelete } = require('../../db/groupList');
const { insertLog } = require('../../db/log');
const { deleteUserState, setUserState } = require('../../states');
const { extractMediaFromMessage } = require('../../media');
const { extractLevel, removeLevelSuffix } = require('../../utils/levelExtractor');

/**
 * 从 group_id 中提取 chat_id
 */
function extractChatIdFromGroupId(groupId) {
    const parts = groupId.split('_');
    if (parts.length >= 2) {
        return parts[0];
    }
    return null;
}

async function handleEditMode(msg, state) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const messageText = msg.text;

    // 步骤1：等待用户发送媒体
    if (state.step === 'waiting_for_media') {
        const mediaInfo = extractMediaFromMessage(msg);
        if (!mediaInfo) {
            await bot.sendMessage(chatId, '❌ 请发送媒体消息（图片、视频、音频或文档）', {
                reply_to_message_id: messageId
            });
            return true;
        }

        const fileUniqueId = mediaInfo.fileUniqueId;

        // 发送处理中消息
        let processingMsg;
        try {
            processingMsg = await bot.sendMessage(chatId, '🔍 正在查找媒体...', {
                reply_to_message_id: messageId,
                allow_sending_without_reply: true
            });
        } catch (err) {
            logger.error(`发送查找中消息失败: ${err.message}`);
            return true;
        }

        // 在 media 数据库中查找该媒体
        const mediaDoc = await findMediaByFileUniqueId(fileUniqueId);
        if (!mediaDoc) {
            await bot.editMessageText('❌ 未找到该媒体', {
                chat_id: chatId,
                message_id: processingMsg.message_id
            });
            deleteUserState(userId);
            return true;
        }

        // 获取目标消息的 chat_id 和 message_id
        const targetGroupId = mediaDoc.group_id;
        const targetMessageId = mediaDoc.message_id;
        const targetChatId = extractChatIdFromGroupId(targetGroupId);

        if (!targetChatId) {
            logger.error(`无法从 group_id 提取 chat_id: ${targetGroupId}`);
            await bot.editMessageText('❌ 媒体数据异常，无法编辑', {
                chat_id: chatId,
                message_id: processingMsg.message_id
            });
            deleteUserState(userId);
            return true;
        }

        // 保存目标信息
        setUserState(userId, {
            ...state,
            step: 'waiting_for_text',
            targetChatId: parseInt(targetChatId),
            targetMessageId: targetMessageId,
            targetGroupId: targetGroupId,
            targetFileUniqueId: fileUniqueId,
            targetMediaType: mediaDoc.media_type,
            processingMsgId: processingMsg.message_id,
            lastActivity: Date.now()
        });

        // 编辑原消息为“✅ 找到了，请输入修改内容”
        await bot.editMessageText('✅ 找到了，请输入修改内容', {
            chat_id: chatId,
            message_id: processingMsg.message_id
        });

        logger.info(`用户 ${userId} 进入编辑模式第二步，待编辑消息: ${targetChatId}/${targetMessageId}`);
        return true;
    }

    // 步骤2：等待用户输入新文本
    if (state.step === 'waiting_for_text') {
        if (!messageText) {
            await bot.sendMessage(chatId, '❌ 请发送文本内容', {
                reply_to_message_id: messageId
            });
            return true;
        }

        const {
            targetChatId,
            targetMessageId,
            targetGroupId,
            targetFileUniqueId,
            targetMediaType
        } = state;

        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const isClearing = (messageText.trim() === 'null');

        try {
            // 查询现有消息记录
            const existingMessage = await messageCol.findOne({
                chat_id: targetChatId,
                message_id: targetMessageId
            });

            if (isClearing) {
                // ---------- 清空文本 ----------
                if (existingMessage) {
                    // 删除 message 记录
                    await messageCol.deleteOne({ chat_id: targetChatId, message_id: targetMessageId });
                    logger.info(`已删除消息记录: chat_id=${targetChatId}, message_id=${targetMessageId}`);

                    // 检查该组是否还有其他文本消息
                    const otherMessages = await messageCol.countDocuments({ group_id: targetGroupId });
                    if (otherMessages === 0) {
                        // 无其他文本，设置 group_list.is_delete 为当前时间戳
                        await setGroupDelete(targetGroupId, Date.now());
                        logger.info(`组内无其他文本，设置 is_delete 为时间戳: group_id=${targetGroupId}`);
                    } else {
                        // 还有文本，确保 is_delete = 0
                        await setGroupDelete(targetGroupId, 0);
                    }
                } else {
                    logger.info(`清空操作但数据库中无记录，无需操作`);
                }

                // 编辑 Telegram 消息的 caption 为空字符串
                await bot.editMessageCaption('', {
                    chat_id: targetChatId,
                    message_id: targetMessageId
                });
            } else {
                // ---------- 编辑或新增文本 ----------
                // 提取等级标记（如果文本末尾有 #S 等）
                const level = extractLevel(messageText);
                const cleanText = removeLevelSuffix(messageText);

                if (existingMessage) {
                    // 更新现有记录
                    await messageCol.updateOne(
                        { chat_id: targetChatId, message_id: targetMessageId },
                        { $set: { text: cleanText, level: level } }
                    );
                    logger.info(`已更新消息文本: chat_id=${targetChatId}, message_id=${targetMessageId}`);
                } else {
                    // 插入新记录
                    const newMessage = {
                        chat_id: targetChatId,
                        message_id: targetMessageId,
                        text: cleanText,
                        file_unique_id: targetFileUniqueId,
                        media_type: targetMediaType,
                        level: level,
                        group_id: targetGroupId
                    };
                    await messageCol.insertOne(newMessage);
                    logger.info(`已插入新消息记录: chat_id=${targetChatId}, message_id=${targetMessageId}`);
                }

                // 确保 group_list.is_delete = 0（该组有文本）
                await setGroupDelete(targetGroupId, 0);

                // 编辑 Telegram 消息的 caption
                await bot.editMessageCaption(messageText, {
                    chat_id: targetChatId,
                    message_id: targetMessageId,
                    parse_mode: 'HTML'
                });
            }

            // 回复用户修改成功（引用用户输入的新文本）
            await bot.sendMessage(chatId, '✅ 修改完毕', {
                reply_to_message_id: messageId
            });

            // 插入操作日志
            insertLog(23, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));

            logger.info(`用户 ${userId} 成功编辑消息 ${targetChatId}/${targetMessageId}`);
        } catch (err) {
            logger.error(`编辑失败: ${err.message}`);
            await bot.sendMessage(chatId, '❌ 修改失败，请检查是否有权限或消息是否已过期', {
                reply_to_message_id: messageId
            });
        }

        // 退出编辑模式
        deleteUserState(userId);
        return true;
    }

    // 未知步骤，自动退出
    logger.warn(`用户 ${userId} 编辑模式未知步骤: ${state.step}，自动退出`);
    deleteUserState(userId);
    return true;
}

module.exports = handleEditMode;