// handlers/modes/editMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { findMediaByFileUniqueId } = require('../../db/media');
const { setGroupDelete } = require('../../db/groupList');
const { insertLog } = require('../../db/log');
const { deleteUserState, setUserState } = require('../../states');
const { extractMediaFromMessage } = require('../../media');
const { removeLevelSuffix } = require('../../utils/levelExtractor');

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

        // 获取目标消息的 chat_id 和 message_id（优先群组位置，其次频道位置，最后从 group_id 推导）
        const targetGroupId = mediaDoc.group_id;
        const targetChatId = (mediaDoc.group && mediaDoc.group.chat_id) ||
            (mediaDoc.channel && mediaDoc.channel.chat_id) ||
            extractChatIdFromGroupId(targetGroupId);
        const targetMessageId = (mediaDoc.group && mediaDoc.group.message_id) ||
            (mediaDoc.channel && mediaDoc.channel.message_id) ||
            mediaDoc.message_id;

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
                targetFileUniqueId, targetMediaType, cleanText
            });

            // 编辑为无文本媒体添加了文本 → 主动进入打标签流程（标签按 message 独立，只写这一条）
            if (!isClearing && cleanText && targetGroupId) {
                const { sendSuccessWithTags } = require('./sendMode');
                await sendSuccessWithTags(userId, '✅ 修改完毕（可为此媒体打标签）', targetGroupId, cleanText, null, targetFileUniqueId);
            } else {
                // 清空文本 / 无组信息：该 message 的标签也清空（标签跟随文本）
                if (isClearing && targetFileUniqueId) {
                    const { clearMessageTags } = require('../../utils/tagSync');
                    await clearMessageTags(targetFileUniqueId);
                }
                await bot.sendMessage(chatId, '✅ 修改完毕', {
                    reply_to_message_id: messageId
                });
                deleteUserState(userId);
            }
            insertLog(23, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
            logger.info(`用户 ${userId} 成功编辑消息 ${targetChatId}/${targetMessageId}`);
        } catch (err) {
            const errMsg = err.message || '';
            // 判断是否为"消息无法编辑"类错误（超过48小时、权限不足等）
            const isEditDenied = errMsg.includes("can't be edited") || errMsg.includes("Can't edit");

            if (isEditDenied) {
                // 保存待执行的数据操作到状态，询问用户
                setUserState(userId, {
                    ...state,
                    step: 'confirm_db_only',
                    pendingEdit: { isClearing, cleanText },
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

    // 步骤2.5：群组/频道内回复 /edit 后的第二步——管理员下一条文本即新描述
    // （操作记录 1 分钟后全部删除：机器人的提示 + 管理员的 /edit 命令 + 这条输入文本）
    if (state.step === 'waiting_for_group_text') {
        if (!messageText) {
            const errMsg = await bot.sendMessage(chatId, '❌ 请发送文本内容', {
                reply_to_message_id: messageId
            });
            const { scheduleDelete } = require('../groupMessageHandlers');
            scheduleDelete(chatId, errMsg.message_id);
            return true;
        }

        const {
            targetChatId,
            targetMessageId,
            targetGroupId,
            targetFileUniqueId,
            targetMediaType,
            groupChatId,
            groupCmdMsgId,
            groupPromptMsgId
        } = state;

        const notifyChat = groupChatId || chatId;
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const isClearing = (messageText.trim() === 'null');
        const cleanText = removeLevelSuffix(messageText);
        const { scheduleDelete } = require('../groupMessageHandlers');
        const { reMatchMessageTags, clearMessageTags } = require('../../utils/tagSync');

        const updateDbAndTags = async () => {
            await updateMessageDb(messageCol, {
                isClearing, targetChatId, targetMessageId, targetGroupId,
                targetFileUniqueId, targetMediaType, cleanText
            });
            if (isClearing) {
                await clearMessageTags(targetFileUniqueId);
            } else if (cleanText) {
                await reMatchMessageTags(targetFileUniqueId, cleanText);
            }
        };

        const scheduleAllCleanup = (extraMsgId) => {
            if (extraMsgId) scheduleDelete(notifyChat, extraMsgId);
            if (groupCmdMsgId) scheduleDelete(notifyChat, groupCmdMsgId); // 管理员的 /edit 命令消息
            if (groupPromptMsgId) scheduleDelete(notifyChat, groupPromptMsgId);
            scheduleDelete(notifyChat, messageId); // 管理员输入的这条文本
        };

        try {
            // 先尝试编辑 Telegram 消息的 caption（HTML 解析失败时降级纯文本）
            if (isClearing) {
                await bot.editMessageCaption('', {
                    chat_id: targetChatId,
                    message_id: targetMessageId
                });
            } else {
                try {
                    await bot.editMessageCaption(messageText, {
                        chat_id: targetChatId,
                        message_id: targetMessageId,
                        parse_mode: 'HTML'
                    });
                } catch (capErr) {
                    if ((capErr.message || '').includes('parse')) {
                        await bot.editMessageCaption(messageText, {
                            chat_id: targetChatId,
                            message_id: targetMessageId
                        });
                    } else {
                        throw capErr;
                    }
                }
            }

            await updateDbAndTags();

            const okMsg = await bot.sendMessage(notifyChat, isClearing ? '✅ 已清空描述' : '✅ 修改完毕', {
                reply_to_message_id: messageId,
                allow_sending_without_reply: true
            });
            scheduleAllCleanup(okMsg.message_id);
            deleteUserState(userId);
            insertLog(23, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
            logger.info(`用户 ${userId} 群组快捷编辑两步完成: ${targetChatId}/${targetMessageId}`);
        } catch (err) {
            const errMsg = err.message || '';
            const isEditDenied = errMsg.includes("can't be edited") || errMsg.includes("Can't edit");

            if (isEditDenied) {
                // 超过 48 小时：仅更新数据库 + 重算标签
                try {
                    await updateDbAndTags();
                    const warnMsg = await bot.sendMessage(notifyChat, '⚠️ 消息已超过编辑时效（48小时），已仅更新数据库中的描述', {
                        reply_to_message_id: messageId,
                        allow_sending_without_reply: true
                    });
                    scheduleAllCleanup(warnMsg.message_id);
                    deleteUserState(userId);
                } catch (dbErr) {
                    logger.error(`群组快捷编辑两步仅更新数据库失败: ${dbErr.message}`);
                    const failMsg = await bot.sendMessage(notifyChat, '❌ 更新失败，请稍后重试', {
                        reply_to_message_id: messageId,
                        allow_sending_without_reply: true
                    });
                    scheduleAllCleanup(failMsg.message_id);
                    deleteUserState(userId);
                }
            } else {
                logger.error(`群组快捷编辑两步失败: ${err.message}`);
                const failMsg = await bot.sendMessage(notifyChat, '❌ 修改失败，请稍后重试', {
                    reply_to_message_id: messageId,
                    allow_sending_without_reply: true
                });
                scheduleAllCleanup(failMsg.message_id);
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
 * 若媒体记录中存在频道位置（频道转发媒体），新建/更新 message 时一并写入
 * channel_forward（双位置），使补注释后的消息立即可选"回复在频道/群组"。
 */
async function updateMessageDb(messageCol, {
    isClearing, targetChatId, targetMessageId, targetGroupId,
    targetFileUniqueId, targetMediaType, cleanText
}) {
    // 从媒体记录获取双位置（group + channel），用于补全 channel_forward
    let channelForward = null;
    try {
        const { findMediaByFileUniqueId } = require('../../db/media');
        const mediaDoc = await findMediaByFileUniqueId(targetFileUniqueId);
        if (mediaDoc && mediaDoc.channel && mediaDoc.channel.chat_id) {
            channelForward = {
                is_channel: true,
                channel_chat_id: mediaDoc.channel.chat_id,
                channel_message_id: mediaDoc.channel.message_id || null,
                group_chat_id: (mediaDoc.group && mediaDoc.group.chat_id) || targetChatId,
                group_message_id: (mediaDoc.group && mediaDoc.group.message_id) || targetMessageId
            };
        }
    } catch (err) {
        logger.error(`构建 channel_forward 失败: ${err.message}`);
    }

    const existing = await messageCol.findOne({ file_unique_id: targetFileUniqueId });

    if (isClearing) {
        if (existing) {
            await messageCol.deleteOne({ file_unique_id: targetFileUniqueId });
            logger.info(`已删除消息记录: file_unique_id=${targetFileUniqueId}`);

            const otherMessages = await messageCol.countDocuments({ group_id: targetGroupId });
            if (otherMessages === 0) {
                await setGroupDelete(targetGroupId, Date.now());
                logger.info(`组内无其他文本，设置 is_delete 为时间戳: group_id=${targetGroupId}`);
            } else {
                await setGroupDelete(targetGroupId, 0);
            }
        }
    } else {
        if (existing) {
            const update = { text: cleanText, updated_at: Date.now() };
            if (channelForward) update.channel_forward = channelForward;
            await messageCol.updateOne({ file_unique_id: targetFileUniqueId }, { $set: update });
            logger.info(`已更新消息文本: file_unique_id=${targetFileUniqueId}`);
        } else {
            await messageCol.insertOne({
                chat_id: targetChatId,
                message_id: targetMessageId,
                text: cleanText,
                file_unique_id: targetFileUniqueId,
                media_type: targetMediaType,
                group_id: targetGroupId,
                updated_at: Date.now(),
                ...(channelForward ? { channel_forward: channelForward } : {})
            });
            logger.info(`已插入新消息记录: file_unique_id=${targetFileUniqueId}`);
        }
        await setGroupDelete(targetGroupId, 0);
    }
}

module.exports = handleEditMode;
module.exports.updateMessageDb = updateMessageDb;