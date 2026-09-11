// handlers/modes/editMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { findMediaByFileUniqueId } = require('../../db/media');
const { syncGroupDeleteByText } = require('../../db/groupList');
const { logOperation } = require('../../utils/opLog');
const { deleteUserState, setUserState } = require('../../states');
const { extractMediaFromMessage } = require('../../media');
const { removeLevelSuffix } = require('../../utils/levelExtractor');
const {
    isEditTargetError,
    resolveEditTargets,
    editCaptionWithFallback,
    editCaptionHtml
} = require('../../utils/editTarget');

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

        // 获取目标消息位置：媒体可能同时存在「频道源位置」与「群组位置」
        // （频道 → 讨论群自动转发时，两条都在库里；改频道源消息 Telegram 会自动同步到群里的副本）
        const targetGroupId = mediaDoc.group_id;
        const editTargets = resolveEditTargets(mediaDoc, extractChatIdFromGroupId(targetGroupId));

        if (!editTargets.length) {
            logger.error(`媒体缺少可编辑位置，无法编辑: group_id=${targetGroupId}, message_id=${mediaDoc.message_id}`);
            await bot.editMessageText('❌ 媒体数据异常，无法编辑', {
                chat_id: chatId,
                message_id: processingMsg.message_id
            });
            deleteUserState(userId);
            return true;
        }

        // 保存目标信息（targetChatId/targetMessageId 取首选位置，用于日志与库记录）
        setUserState(userId, {
            ...state,
            step: 'waiting_for_text',
            targetChatId: editTargets[0].chatId,
            targetMessageId: editTargets[0].messageId,
            editTargets: editTargets,
            targetGroupId: targetGroupId,
            targetFileUniqueId: fileUniqueId,
            targetMediaType: mediaDoc.media_type,
            processingMsgId: processingMsg.message_id,
            lastActivity: Date.now()
        });

        // 编辑原消息为“✅ 找到了，请输入修改内容”，并给出「清空描述 / 退出」快捷按钮
        await bot.editMessageText('✅ 找到了，请输入修改内容', {
            chat_id: chatId,
            message_id: processingMsg.message_id,
            reply_markup: {
                inline_keyboard: [[
                    { text: '🗑 清空描述', callback_data: 'edit_clear' },
                    { text: '🚪 退出', callback_data: 'edit_exit' }
                ]]
            }
        });

        logger.info(`用户 ${userId} 进入编辑模式第二步，待编辑消息: ${editTargets[0].chatId}/${editTargets[0].messageId} (via=${editTargets[0].via})`);
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
            targetGroupId,
            targetFileUniqueId,
            targetMediaType,
            processingMsgId
        } = state;

        // 编辑目标：频道源位置优先（频道 → 讨论群自动转发时改动会同步到群里的副本），
        // 该位置改不了（超 48 小时 / 非机器人发送）时再退到群组位置重试
        const editTargets = (Array.isArray(state.editTargets) && state.editTargets.length)
            ? state.editTargets
            : [{ chatId: state.targetChatId, messageId: state.targetMessageId, via: 'legacy' }];

        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const isClearing = (messageText.trim() === 'null');

        const cleanText = removeLevelSuffix(messageText);

        try {
            // 先尝试编辑 Telegram 消息的 caption（可能会因超时 / 位置不是机器人发的而失败）
            const edited = await editCaptionWithFallback(editTargets, async (t) => {
                if (isClearing) {
                    await bot.editMessageCaption('', {
                        chat_id: t.chatId,
                        message_id: t.messageId
                    });
                } else {
                    await editCaptionHtml(bot, t.chatId, t.messageId, messageText);
                }
            });

            // 清空描述 = 移除该 message 的标签：必须先清标签（此刻 message 记录还在，才能递减标签使用次数），
            // 再删 message 记录；编辑描述则**保留已有标签**（只补充新文本匹配到的）
            if (isClearing && targetFileUniqueId) {
                const { clearMessageTags } = require('../../utils/tagSync');
                await clearMessageTags(targetFileUniqueId);
            }

            // Telegram 编辑成功 → 更新数据库（位置取实际改成功的那条）
            await updateMessageDb(messageCol, {
                isClearing, targetChatId: edited.chatId, targetMessageId: edited.messageId, targetGroupId,
                targetFileUniqueId, targetMediaType, cleanText
            });

            // 编辑成功 → 主动弹出打标签界面（标签按 message 独立，只写这一条；已有标签保留）
            if (!isClearing && cleanText && targetGroupId) {
                const { sendSuccessWithTags } = require('./sendMode');
                await sendSuccessWithTags(userId, '✅ 修改完毕（可为此媒体打标签）', targetGroupId, cleanText, null, targetFileUniqueId);
            } else {
                // 清空文本 / 无组信息
                await bot.sendMessage(chatId, '✅ 修改完毕', {
                    reply_to_message_id: messageId
                });
                deleteUserState(userId);
            }
            logOperation({
                action: 'media_edit',
                source: 'private',
                userId,
                chatId,
                messageId,
                target: { type: 'media', id: targetFileUniqueId },
                counts: { edits: 1 },
                detail: {
                    via: 'private_edit',
                    mediaType: targetMediaType,
                    groupId: targetGroupId,
                    targetChatId: edited.chatId,
                    targetMessageId: edited.messageId,
                    editVia: edited.via,
                    after: cleanText,
                    textLength: cleanText ? cleanText.length : 0
                }
            }).catch(() => { });
            logger.info(`用户 ${userId} 成功编辑消息 ${edited.chatId}/${edited.messageId} (via=${edited.via})`);
        } catch (err) {
            // 判断是否为"消息无法编辑"类错误（超过 48 小时 / 不是机器人发送的消息等）
            const isEditDenied = isEditTargetError(err);

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
                // 失败也留痕：区分「48 小时降级（仅更新数据库）」与真正的失败
                logOperation({
                    action: 'media_edit',
                    result: 'fail',
                    source: 'private',
                    userId,
                    chatId,
                    messageId,
                    target: { type: 'media', id: targetFileUniqueId },
                    detail: { via: 'private_edit', over48h: !!isEditDenied, mediaType: targetMediaType },
                    error: err.message
                }).catch(() => { });
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
            targetGroupId,
            targetFileUniqueId,
            targetMediaType,
            groupChatId,
            groupCmdMsgId,
            groupPromptMsgId
        } = state;

        // 编辑目标：频道源位置优先，改不了再退群组位置（与私聊 /edit 一致）
        const editTargets = (Array.isArray(state.editTargets) && state.editTargets.length)
            ? state.editTargets
            : [{ chatId: state.targetChatId, messageId: state.targetMessageId, via: 'legacy' }];

        const notifyChat = groupChatId || chatId;
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const isClearing = (messageText.trim() === 'null');
        const cleanText = removeLevelSuffix(messageText);
        const { scheduleDelete } = require('../groupMessageHandlers');
        const { reMatchMessageTags, clearMessageTags } = require('../../utils/tagSync');

        const updateDbAndTags = async (target) => {
            // 清空描述：先清标签（此刻 message 记录还在，才能递减标签使用次数），再删记录；
            // 编辑描述：保留已有标签，只补充新文本匹配到的标签（在 updateMessageDb 之后，确保记录存在）
            if (isClearing) {
                await clearMessageTags(targetFileUniqueId);
            }
            await updateMessageDb(messageCol, {
                isClearing, targetChatId: target.chatId, targetMessageId: target.messageId, targetGroupId,
                targetFileUniqueId, targetMediaType, cleanText
            });
            if (!isClearing && cleanText) {
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
            // 先尝试编辑 Telegram 消息的 caption（HTML 解析失败降级纯文本；位置不可用则换另一个位置）
            const edited = await editCaptionWithFallback(editTargets, async (t) => {
                if (isClearing) {
                    await bot.editMessageCaption('', {
                        chat_id: t.chatId,
                        message_id: t.messageId
                    });
                } else {
                    await editCaptionHtml(bot, t.chatId, t.messageId, messageText);
                }
            });

            await updateDbAndTags(edited);

            const okMsg = await bot.sendMessage(notifyChat, isClearing ? '✅ 已清空描述' : '✅ 修改完毕', {
                reply_to_message_id: messageId,
                allow_sending_without_reply: true
            });
            scheduleAllCleanup(okMsg.message_id);
            deleteUserState(userId);
            logOperation({
                action: 'media_edit',
                source: 'group',
                userId,
                chatId: notifyChat,
                target: { type: 'media', id: targetFileUniqueId },
                counts: { edits: 1 },
                detail: {
                    via: 'group_two_step',
                    groupId: targetGroupId,
                    targetChatId: edited.chatId,
                    targetMessageId: edited.messageId,
                    editVia: edited.via,
                    mediaType: targetMediaType,
                    clearing: isClearing,
                    after: cleanText || undefined
                }
            }).catch(() => { });
            logger.info(`用户 ${userId} 群组快捷编辑两步完成: ${edited.chatId}/${edited.messageId} (via=${edited.via})`);
        } catch (err) {
            const isEditDenied = isEditTargetError(err);

            if (isEditDenied) {
                // 超 48 小时 / 该位置不是机器人发的：仅更新数据库 + 重算标签
                // （库记录位置沿用首选位置，与 message 记录的频道源位置一致）
                try {
                    await updateDbAndTags(editTargets[0]);
                    logOperation({
                        action: 'media_edit',
                        source: 'group',
                        userId,
                        chatId: notifyChat,
                        target: { type: 'media', id: targetFileUniqueId },
                        counts: { edits: 1 },
                        detail: {
                            via: 'group_two_step',
                            groupId: targetGroupId,
                            over48h: true,
                            clearing: isClearing,
                            after: cleanText || undefined
                        }
                    }).catch(() => { });
                    const warnMsg = await bot.sendMessage(notifyChat, '⚠️ 消息已超过编辑时效（48小时），已仅更新数据库中的描述', {
                        reply_to_message_id: messageId,
                        allow_sending_without_reply: true
                    });
                    scheduleAllCleanup(warnMsg.message_id);
                    deleteUserState(userId);
                } catch (dbErr) {
                    logger.error(`群组快捷编辑两步仅更新数据库失败: ${dbErr.message}`);
                    logOperation({
                        action: 'media_edit',
                        source: 'group',
                        result: 'fail',
                        userId,
                        chatId: notifyChat,
                        target: { type: 'media', id: targetFileUniqueId },
                        detail: { via: 'group_two_step', over48h: true },
                        error: dbErr.message
                    }).catch(() => { });
                    const failMsg = await bot.sendMessage(notifyChat, '❌ 更新失败，请稍后重试', {
                        reply_to_message_id: messageId,
                        allow_sending_without_reply: true
                    });
                    scheduleAllCleanup(failMsg.message_id);
                    deleteUserState(userId);
                }
            } else {
                logger.error(`群组快捷编辑两步失败: ${err.message}`);
                logOperation({
                    action: 'media_edit',
                    source: 'group',
                    result: 'fail',
                    userId,
                    chatId: notifyChat,
                    target: { type: 'media', id: targetFileUniqueId },
                    detail: { via: 'group_two_step' },
                    error: err.message
                }).catch(() => { });
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

            // 描述清空后按组内剩余文本统一重算：
            // 组内还有其他文本 → 0（无需清理）；已无文本 → 时间戳（可被 /clean 清理）
            if (targetGroupId) await syncGroupDeleteByText(targetGroupId);
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
        // 补/改文本后组内必然有文本 → is_delete=0（无需清理）
        if (targetGroupId) await syncGroupDeleteByText(targetGroupId);
    }
}

module.exports = handleEditMode;
module.exports.updateMessageDb = updateMessageDb;