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
            targetMediaType,
            processingMsgId
        } = state;

        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const isClearing = (messageText.trim() === 'null');

        // 提取等级标记（如果文本末尾有 #S 等）
        const level = extractLevel(messageText);
        const cleanText = removeLevelSuffix(messageText);

        try {
            // 先尝试编辑 Telegram 消息的 caption（可能会因超时而失败）
            if (isClearing) {
                await bot.editMessageCaption('', {
                    chat_id: targetChatId,
                    message_id: targetMessageId
                });
            } else {
                await bot.editMessageCaption(messageText, {
                    chat_id: targetChatId,
                    message_id: targetMessageId,
                    parse_mode: 'HTML'
                });
            }

            // Telegram 编辑成功 → 更新数据库
            await updateMessageDb(messageCol, {
                isClearing, targetChatId, targetMessageId, targetGroupId,
                targetFileUniqueId, targetMediaType, cleanText, level
            });

            await bot.sendMessage(chatId, '✅ 修改完毕', {
                reply_to_message_id: messageId
            });
            insertLog(23, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
            logger.info(`用户 ${userId} 成功编辑消息 ${targetChatId}/${targetMessageId}`);

            deleteUserState(userId);
        } catch (err) {
            const errMsg = err.message || '';
            // 判断是否为"消息无法编辑"类错误（超过48小时、权限不足等）
            const isEditDenied = errMsg.includes("can't be edited") || errMsg.includes("Can't edit");

            if (isEditDenied) {
                // 保存待执行的数据操作到状态，询问用户
                setUserState(userId, {
                    ...state,
                    step: 'confirm_db_only',
                    pendingEdit: { isClearing, cleanText, level },
                    lastActivity: Date.now()
                });

                const keyboard = {
                    inline_keyboard: [[
                        { text: '✅ 仅更新数据库', callback_data: `edit_dbonly:${targetGroupId}` },
                        { text: '❌ 取消', callback_data: `edit_dbonly_cancel` }
                    ]]
                };

                await bot.editMessageText(
                    `⚠️ 消息已超过编辑时效（48小时），无法修改 Telegram 上的描述。\n是否只更改数据库中的描述？`,
                    {
                        chat_id: chatId,
                        message_id: processingMsgId,
                        reply_markup: keyboard
                    }
                );
                logger.info(`用户 ${userId} 编辑消息超时，已询问是否仅更新数据库`);
            } else {
                logger.error(`编辑失败: ${err.message}`);
                await bot.sendMessage(chatId, '❌ 修改失败，请稍后重试', {
                    reply_to_message_id: messageId
                });
                deleteUserState(userId);
            }
        }
        return true;
    }

    // 步骤3：处理确认仅更新数据库的回调
    if (state.step === 'confirm_db_only') {
        // 由回调处理器处理，此处无需操作
        return true;
    }

    // 未知步骤，自动退出
    logger.warn(`用户 ${userId} 编辑模式未知步骤: ${state.step}，自动退出`);
    deleteUserState(userId);
    return true;
}

/**
 * 执行数据库更新操作（更新/插入 message 记录 + group_list 标记）
 */
async function updateMessageDb(messageCol, {
    isClearing, targetChatId, targetMessageId, targetGroupId,
    targetFileUniqueId, targetMediaType, cleanText, level
}) {
    if (isClearing) {
        const existing = await messageCol.findOne({
            chat_id: targetChatId, message_id: targetMessageId
        });
        if (existing) {
            await messageCol.deleteOne({ chat_id: targetChatId, message_id: targetMessageId });
            logger.info(`已删除消息记录: chat_id=${targetChatId}, message_id=${targetMessageId}`);

            const otherMessages = await messageCol.countDocuments({ group_id: targetGroupId });
            if (otherMessages === 0) {
                await setGroupDelete(targetGroupId, Date.now());
                logger.info(`组内无其他文本，设置 is_delete 为时间戳: group_id=${targetGroupId}`);
            } else {
                await setGroupDelete(targetGroupId, 0);
            }
        }
    } else {
        const existing = await messageCol.findOne({
            chat_id: targetChatId, message_id: targetMessageId
        });
        if (existing) {
            await messageCol.updateOne(
                { chat_id: targetChatId, message_id: targetMessageId },
                { $set: { text: cleanText, level: level } }
            );
            logger.info(`已更新消息文本: chat_id=${targetChatId}, message_id=${targetMessageId}`);
        } else {
            await messageCol.insertOne({
                chat_id: targetChatId,
                message_id: targetMessageId,
                text: cleanText,
                file_unique_id: targetFileUniqueId,
                media_type: targetMediaType,
                level: level,
                group_id: targetGroupId
            });
            logger.info(`已插入新消息记录: chat_id=${targetChatId}, message_id=${targetMessageId}`);
        }
        await setGroupDelete(targetGroupId, 0);
    }
}

module.exports = handleEditMode;