// handlers/modes/messageReplyMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const {
    findMediaByFileUniqueId,
    insertMedia,
    getMaxSubgroup
} = require('../../db/media');
const { upsertMessage } = require('../../db/message');
const { upsertGroupList, setGroupDelete } = require('../../db/groupList');
const { extractMediaFromMessage, sendMediaAsReply, sendMediaGroupAsReply } = require('../../media');
const { extractLevel, removeLevelSuffix } = require('../../utils/levelExtractor');
const { setUserState, deleteUserState, updateUserActivity, getRawUserState } = require('../../states');

// ---------- 用户隔离上下文 ----------
const userContexts = new Map();

// 定期清理已退出模式的用户上下文
setInterval(() => {
    const states = require('../../states');
    for (const [userId, ctx] of userContexts.entries()) {
        const rawState = states.getRawUserState(userId);
        if (!rawState || rawState.mode !== 'message_reply') {
            clearUserContext(userId);
        }
    }
}, 10 * 60 * 1000);

function getContext(userId) {
    if (!userContexts.has(userId)) {
        userContexts.set(userId, {
            countedMediaSet: new Set(),
            pendingMediaGroups: new Map(),
            targetPendingGroups: new Map(),
            targetProcessedGroups: new Set(),
            targetQuerySent: new Set(),
            targetQueryMsgIds: new Map()
        });
    }
    return userContexts.get(userId);
}

function clearUserContext(userId) {
    const ctx = userContexts.get(userId);
    if (ctx) {
        // 清理定时器
        for (const [key, groupData] of ctx.pendingMediaGroups) {
            if (key.startsWith(`${userId}_`)) {
                clearTimeout(groupData.timer);
            }
        }
        for (const [key, groupData] of ctx.targetPendingGroups) {
            if (key.startsWith(`${userId}_`)) {
                clearTimeout(groupData.timer);
            }
        }
        userContexts.delete(userId);
    }
}

// 供外部调用的获取上下文方法（用于超时清理）
function getMessageReplyContext(userId) {
    return userContexts.get(userId);
}

async function exitMessageReplyMode(userId, sendExitMessage = true) {
    const rawState = getRawUserState(userId);
    if (rawState && rawState.mode === 'message_reply') {
        if (rawState.hintMsgInfo) {
            try {
                await bot.deleteMessage(rawState.hintMsgInfo.chat_id, rawState.hintMsgInfo.message_id);
            } catch (err) {
                logger.warn(`退出时删除群组提示消息失败: ${err.message}`);
            }
        }

        // 清理用户上下文
        clearUserContext(userId);

        deleteUserState(userId);
        if (sendExitMessage) {
            await bot.sendMessage(userId, '✅ 已退出消息回复模式')
                .catch(err => logger.error('发送退出提醒失败:', err.message));
        }
        logger.info(`用户 ${userId} 退出消息回复模式`);
    }
}

async function recordReplyMessage(sentMsg, targetGroupId) {
    try {
        const mediaInfo = extractMediaFromMessage(sentMsg);
        if (!mediaInfo) return;
        const { caption, fileUniqueId, type } = mediaInfo;
        if (!caption) return;
        const chatId = sentMsg.chat.id;
        const messageId = sentMsg.message_id;
        const groupId = targetGroupId;
        const level = extractLevel(caption);
        const cleanText = removeLevelSuffix(caption);
        await upsertMessage({
            message_id: messageId,
            chat_id: chatId,
            text: cleanText,
            file_unique_id: fileUniqueId,
            media_type: type,
            level: level,
            group_id: groupId
        });
        logger.info(`已收录消息回复模式产生的消息: chat_id=${chatId}, message_id=${messageId}, group_id=${groupId}`);
    } catch (err) {
        logger.error(`收录回复消息失败: ${err.message}`);
    }
}

async function processSingleMediaReply(userId, targetChatId, targetMessageId, targetGroupId, mediaInfo, userMsgId) {
    const ctx = getContext(userId);
    const { fileUniqueId, type, fileId, caption, has_spoiler, videoTime } = mediaInfo;

    const existing = await findMediaByFileUniqueId(fileUniqueId);
    if (existing) {
        logger.info(`用户发送的媒体已存在 media 集合，跳过收录: file_unique_id=${fileUniqueId}`);
        await bot.sendMessage(userId, '❌ 该媒体已存在，无法再次添加', {
            reply_to_message_id: userMsgId
        });
        return;
    }

    const maxSubgroup = await getMaxSubgroup(targetGroupId);
    const newSubgroup = maxSubgroup + 1;

    let sentMsg;
    try {
        sentMsg = await sendMediaAsReply(targetChatId, targetMessageId, { type, fileId, caption, has_spoiler });
    } catch (err) {
        logger.error(`回复单个媒体到群组失败: ${err.message}`);
        await bot.sendMessage(userId, '❌ 回复媒体失败，请重试', {
            reply_to_message_id: userMsgId
        });
        return;
    }

    await insertMedia({
        group_id: targetGroupId,
        subgroup: newSubgroup,
        file_id: fileId,
        file_unique_id: fileUniqueId,
        media_type: type,
        message_id: sentMsg.message_id,
        video_time: videoTime
    });

    await upsertGroupList(targetGroupId);
    await setGroupDelete(targetGroupId, 0);

    const countKey = `${targetGroupId}:${fileUniqueId}`;
    if (!ctx.countedMediaSet.has(countKey)) {
        ctx.countedMediaSet.add(countKey);
        logger.info(`用户发送的媒体已计入 group_list，并加入 Set: key=${countKey}`);
    }

    if (caption) {
        await recordReplyMessage(sentMsg, targetGroupId);
    }

    await bot.sendMessage(userId, '✅ 已回复', {
        reply_to_message_id: userMsgId
    });
    logger.info(`用户 ${userId} 已回复媒体到群组 ${targetChatId}/${targetMessageId}，新 subgroup=${newSubgroup}`);
}

async function processMediaGroupReply(userId, targetChatId, targetMessageId, targetGroupId, mediaItems, userMsgId) {
    const ctx = getContext(userId);
    if (mediaItems.length === 0) return;

    const sortedItems = [...mediaItems].sort((a, b) => a.message_id - b.message_id);

    const newItems = [];
    for (const item of sortedItems) {
        const existing = await findMediaByFileUniqueId(item.fileUniqueId);
        if (!existing) {
            newItems.push(item);
        } else {
            logger.info(`媒体已存在，跳过: file_unique_id=${item.fileUniqueId}`);
        }
    }

    if (newItems.length === 0) {
        await bot.sendMessage(userId, '❌ 所有媒体均已存在，无法添加', {
            reply_to_message_id: userMsgId
        });
        return;
    }

    const maxSubgroup = await getMaxSubgroup(targetGroupId);
    const newSubgroup = maxSubgroup + 1;

    let sentMessages;
    try {
        sentMessages = await sendMediaGroupAsReply(targetChatId, targetMessageId, newItems);
    } catch (err) {
        logger.error(`回复媒体组到群组失败: ${err.message}`);
        await bot.sendMessage(userId, '❌ 回复媒体组失败，请重试', {
            reply_to_message_id: userMsgId
        });
        return;
    }

    for (let i = 0; i < sentMessages.length; i++) {
        const sentMsg = sentMessages[i];
        const originalItem = newItems[i];
        if (!originalItem) continue;

        await insertMedia({
            group_id: targetGroupId,
            subgroup: newSubgroup,
            file_id: originalItem.fileId,
            file_unique_id: originalItem.fileUniqueId,
            media_type: originalItem.type,
            message_id: sentMsg.message_id,
            video_time: originalItem.videoTime
        });

        const countKey = `${targetGroupId}:${originalItem.fileUniqueId}`;
        if (!ctx.countedMediaSet.has(countKey)) {
            ctx.countedMediaSet.add(countKey);
        }

        if (originalItem.caption) {
            await recordReplyMessage(sentMsg, targetGroupId);
        }
    }

    for (let i = 0; i < newItems.length; i++) {
        await upsertGroupList(targetGroupId);
    }
    await setGroupDelete(targetGroupId, 0);

    await bot.sendMessage(userId, `✅ 已回复媒体组 (${newItems.length} 个)`, {
        reply_to_message_id: userMsgId
    });
    logger.info(`用户 ${userId} 已回复媒体组到群组 ${targetChatId}/${targetMessageId}，新 subgroup=${newSubgroup}，共 ${newItems.length} 个媒体`);
}

async function processTargetGroup(userId, groupKey, mediaItems, processingMsgId) {
    const ctx = getContext(userId);
    // 如果该组已被立即处理，则跳过
    if (ctx.targetProcessedGroups.has(groupKey)) {
        logger.info(`组 ${groupKey} 已被立即处理，跳过`);
        ctx.targetPendingGroups.delete(groupKey);
        ctx.targetQuerySent.delete(groupKey);
        return;
    }

    logger.info(`处理目标媒体组，共有 ${mediaItems.length} 个媒体`);
    try {
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const mediaCol = getCollection(COLLECTIONS.MEDIA);

        let targetMessage = null;
        for (const item of mediaItems) {
            logger.info(`检查媒体 file_unique_id=${item.fileUniqueId}`);
            const msgDoc = await messageCol.findOne({ file_unique_id: item.fileUniqueId });
            if (msgDoc) {
                logger.info(`找到匹配的消息: ${msgDoc.message_id}`);
                targetMessage = msgDoc;
                break;
            } else {
                logger.info(`未在 message 集合中找到，检查 media 集合`);
                const mediaDoc = await mediaCol.findOne({ file_unique_id: item.fileUniqueId });
                if (mediaDoc) {
                    logger.info(`在 media 集合中找到，但无消息记录，不可回复`);
                } else {
                    logger.info(`media 集合中也未找到`);
                }
            }
        }

        if (!targetMessage) {
            await bot.editMessageText('❌ 媒体组中没有可回复的媒体', {
                chat_id: userId,
                message_id: processingMsgId
            });
            logger.info(`用户 ${userId} 目标媒体组无可用媒体，退出模式`);
            await exitMessageReplyMode(userId, true);
            return;
        }

        const targetGroupId = targetMessage.group_id;
        const targetChatId = targetMessage.chat_id;
        const targetMessageId = targetMessage.message_id;

        let hintMsg;
        try {
            hintMsg = await bot.sendMessage(targetChatId, '💬 Der包正在回复该消息', {
                reply_to_message_id: targetMessageId
            });
        } catch (err) {
            logger.warn(`发送群组提示消息失败: ${err.message}`);
            hintMsg = null;
        }

        await bot.editMessageText('✅ 找到了，现在可以向我发送消息了', {
            chat_id: userId,
            message_id: processingMsgId
        });

        setUserState(userId, {
            mode: 'message_reply',
            step: 'ready',
            targetGroupId,
            targetChatId,
            targetMessageId,
            hintMsgInfo: hintMsg ? { chat_id: targetChatId, message_id: hintMsg.message_id } : null,
            lastActivity: Date.now()
        });

        logger.info(`用户 ${userId} 消息回复模式已找到目标（媒体组），进入就绪状态`);
    } catch (err) {
        logger.error(`处理目标媒体组失败: ${err.message}`);
        await bot.editMessageText('❌ 查询失败，请稍后重试', {
            chat_id: userId,
            message_id: processingMsgId
        });
        await exitMessageReplyMode(userId, true);
    } finally {
        // 删除暂存记录和查询标记
        ctx.targetPendingGroups.delete(groupKey);
        ctx.targetQuerySent.delete(groupKey);

        // 删除该组多余查询消息（除了当前这条）
        if (ctx.targetQueryMsgIds.has(groupKey)) {
            const ids = ctx.targetQueryMsgIds.get(groupKey);
            for (const id of ids) {
                if (id !== processingMsgId) {
                    try {
                        await bot.deleteMessage(userId, id).catch(() => { });
                    } catch (e) { }
                }
            }
            ctx.targetQueryMsgIds.delete(groupKey);
        }
    }
}

async function handleMessageReplyMode(msg, state) {
    const userId = msg.from.id;
    const messageText = msg.text;
    const mediaInfo = extractMediaFromMessage(msg);
    const userMsgId = msg.message_id;
    const ctx = getContext(userId);

    // 如果是媒体组，检查该组是否已处理过（成功或失败）或已发送查询消息
    if (msg.media_group_id) {
        const groupKey = `${userId}_${msg.media_group_id}`;
        if (ctx.targetProcessedGroups.has(groupKey)) {
            logger.info(`用户 ${userId} 媒体组 ${groupKey} 已处理完成，忽略后续消息`);
            return true;
        }
        // 如果已经发送了查询消息但尚未处理，也忽略后续消息（防止重复发送查询消息）
        if (ctx.targetQuerySent.has(groupKey)) {
            logger.info(`用户 ${userId} 媒体组 ${groupKey} 已有查询消息，忽略后续消息`);
            return true;
        }
    }

    if (state.step === 'waiting_for_target') {
        if (!mediaInfo) {
            await bot.sendMessage(userId, '❌ 请发送媒体消息', {
                reply_to_message_id: userMsgId
            });
            return true;
        }

        if (msg.media_group_id) {
            const groupKey = `${userId}_${msg.media_group_id}`;

            // 先检查当前消息是否可回复
            const messageCol = getCollection(COLLECTIONS.MESSAGE);
            const targetMessage = await messageCol.findOne({ file_unique_id: mediaInfo.fileUniqueId });

            if (targetMessage) {
                // 当前消息可回复，立即处理，并标记该组已处理
                ctx.targetProcessedGroups.add(groupKey);
                ctx.targetQuerySent.add(groupKey); // 防止后续消息再次触发

                // 如果该组有暂存，清除它们
                if (ctx.targetPendingGroups.has(groupKey)) {
                    clearTimeout(ctx.targetPendingGroups.get(groupKey).timer);
                    ctx.targetPendingGroups.delete(groupKey);
                }

                logger.info(`用户 ${userId} 媒体组第一条消息可回复，立即处理`);

                // 发送查询中消息（用于编辑）
                let processingMsg;
                try {
                    processingMsg = await bot.sendMessage(userId, '🔍 正在查询中，请稍等...', {
                        reply_to_message_id: userMsgId,
                        allow_sending_without_reply: true
                    });

                    // 记录查询消息ID
                    if (!ctx.targetQueryMsgIds.has(groupKey)) {
                        ctx.targetQueryMsgIds.set(groupKey, []);
                    }
                    ctx.targetQueryMsgIds.get(groupKey).push(processingMsg.message_id);
                } catch (err) {
                    logger.error(`发送查询中消息失败: ${err.message}`);
                    ctx.targetProcessedGroups.delete(groupKey);
                    ctx.targetQuerySent.delete(groupKey);
                    return true;
                }

                // 执行立即处理（类似于单条媒体）
                try {
                    const targetGroupId = targetMessage.group_id;
                    const targetChatId = targetMessage.chat_id;
                    const targetMessageId = targetMessage.message_id;

                    let hintMsg;
                    try {
                        hintMsg = await bot.sendMessage(targetChatId, '💬 Der包正在回复该消息', {
                            reply_to_message_id: targetMessageId
                        });
                    } catch (err) {
                        logger.warn(`发送群组提示消息失败: ${err.message}`);
                        hintMsg = null;
                    }

                    await bot.editMessageText('✅ 找到了，现在可以向我发送消息了', {
                        chat_id: userId,
                        message_id: processingMsg.message_id
                    });

                    setUserState(userId, {
                        mode: 'message_reply',
                        step: 'ready',
                        targetGroupId,
                        targetChatId,
                        targetMessageId,
                        hintMsgInfo: hintMsg ? { chat_id: targetChatId, message_id: hintMsg.message_id } : null,
                        lastActivity: Date.now()
                    });

                    logger.info(`用户 ${userId} 消息回复模式立即找到目标，进入就绪状态`);
                } catch (err) {
                    logger.error(`立即处理目标失败: ${err.message}`);
                    await bot.editMessageText('❌ 处理失败', {
                        chat_id: userId,
                        message_id: processingMsg.message_id
                    });
                    await exitMessageReplyMode(userId, true);
                } finally {
                    ctx.targetQuerySent.delete(groupKey);
                    // 清理多余查询消息（应该只有一条，但为了安全）
                    if (ctx.targetQueryMsgIds.has(groupKey)) {
                        const ids = ctx.targetQueryMsgIds.get(groupKey);
                        for (const id of ids) {
                            if (id !== processingMsg.message_id) {
                                try {
                                    await bot.deleteMessage(userId, id).catch(() => { });
                                } catch (e) { }
                            }
                        }
                        ctx.targetQueryMsgIds.delete(groupKey);
                    }
                }
                return true;
            }

            // 当前消息不可回复，检查是否有暂存记录
            let existing = ctx.targetPendingGroups.get(groupKey);

            if (existing) {
                // 已有暂存记录，只需添加媒体信息，不发送新查询消息
                existing.items.push({
                    ...mediaInfo,
                    message_id: msg.message_id
                });
                if (existing.timer) clearTimeout(existing.timer);
                existing.timer = setTimeout(async () => {
                    await processTargetGroup(userId, groupKey, existing.items, existing.processingMsgId);
                }, 5000); // 5秒，确保收集所有消息
                ctx.targetPendingGroups.set(groupKey, existing);
                logger.info(`用户 ${userId} 目标选择媒体组后续消息暂存，当前组内数量: ${existing.items.length}`);
                return true;
            } else {
                // 第一次接收到该组的消息，发送查询消息
                ctx.targetQuerySent.add(groupKey); // 标记已发送查询消息

                let processingMsg;
                try {
                    processingMsg = await bot.sendMessage(userId, '🔍 正在查询中，请稍等...', {
                        reply_to_message_id: userMsgId,
                        allow_sending_without_reply: true
                    });

                    // 记录查询消息ID
                    if (!ctx.targetQueryMsgIds.has(groupKey)) {
                        ctx.targetQueryMsgIds.set(groupKey, []);
                    }
                    ctx.targetQueryMsgIds.get(groupKey).push(processingMsg.message_id);
                } catch (err) {
                    logger.error(`发送查询中消息失败: ${err.message}`);
                    ctx.targetQuerySent.delete(groupKey);
                    return true;
                }

                existing = {
                    items: [{
                        ...mediaInfo,
                        message_id: msg.message_id
                    }],
                    timer: null,
                    processingMsgId: processingMsg.message_id
                };
                existing.timer = setTimeout(async () => {
                    await processTargetGroup(userId, groupKey, existing.items, existing.processingMsgId);
                }, 5000); // 5秒
                ctx.targetPendingGroups.set(groupKey, existing);
                logger.info(`用户 ${userId} 目标选择媒体组消息暂存，当前组内数量: ${existing.items.length}`);
                return true;
            }
        }

        // 单条媒体处理
        let processingMsg;
        try {
            processingMsg = await bot.sendMessage(userId, '🔍 正在查询中，请稍等...', {
                reply_to_message_id: userMsgId,
                allow_sending_without_reply: true
            });
        } catch (err) {
            logger.error(`发送查询中消息失败: ${err.message}`);
            return true;
        }

        const fileUniqueId = mediaInfo.fileUniqueId;
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const mediaCol = getCollection(COLLECTIONS.MEDIA);

        try {
            let targetMessage = await messageCol.findOne({ file_unique_id: fileUniqueId });
            if (!targetMessage) {
                const mediaDoc = await mediaCol.findOne({ file_unique_id: fileUniqueId });
                if (!mediaDoc) {
                    await bot.editMessageText('❌ 数据库中找不到该媒体', {
                        chat_id: userId,
                        message_id: processingMsg.message_id
                    });
                    await exitMessageReplyMode(userId, true);
                    return true;
                } else {
                    await bot.editMessageText('❌ 媒体不在消息数据库中，无法回复', {
                        chat_id: userId,
                        message_id: processingMsg.message_id
                    });
                    await exitMessageReplyMode(userId, true);
                    return true;
                }
            }

            const targetGroupId = targetMessage.group_id;
            const targetChatId = targetMessage.chat_id;
            const targetMessageId = targetMessage.message_id;

            let hintMsg;
            try {
                hintMsg = await bot.sendMessage(targetChatId, '💬 Der包正在回复该消息', {
                    reply_to_message_id: targetMessageId
                });
            } catch (err) {
                logger.warn(`发送群组提示消息失败: ${err.message}`);
                hintMsg = null;
            }

            await bot.editMessageText('✅ 找到了，现在可以向我发送消息了', {
                chat_id: userId,
                message_id: processingMsg.message_id
            });

            setUserState(userId, {
                ...state,
                step: 'ready',
                targetGroupId,
                targetChatId,
                targetMessageId,
                hintMsgInfo: hintMsg ? { chat_id: targetChatId, message_id: hintMsg.message_id } : null,
                lastActivity: Date.now()
            });

            logger.info(`用户 ${userId} 消息回复模式已找到目标，进入就绪状态`);
        } catch (err) {
            logger.error(`查询目标媒体失败: ${err.message}`);
            await bot.editMessageText('❌ 查询失败，请稍后重试', {
                chat_id: userId,
                message_id: processingMsg.message_id
            });
            await exitMessageReplyMode(userId, true);
        }
        return true;
    }

    if (state.step === 'ready') {
        if (!mediaInfo) {
            logger.info(`用户 ${userId} 在就绪状态发送非媒体消息，已忽略`);
            return true;
        }

        // 在就绪状态，支持发送媒体组作为回复
        if (msg.media_group_id) {
            const groupKey = `${userId}_${msg.media_group_id}`;
            const existing = ctx.pendingMediaGroups.get(groupKey) || { items: [], timer: null };
            existing.items.push({
                ...mediaInfo,
                message_id: msg.message_id
            });
            if (existing.timer) clearTimeout(existing.timer);
            existing.timer = setTimeout(async () => {
                await processMediaGroupReply(
                    userId,
                    state.targetChatId,
                    state.targetMessageId,
                    state.targetGroupId,
                    existing.items,
                    userMsgId
                );
                ctx.pendingMediaGroups.delete(groupKey);
            }, 3000); // 3秒等待组内所有消息
            ctx.pendingMediaGroups.set(groupKey, existing);
            logger.info(`用户 ${userId} 在就绪状态收到媒体组消息暂存，当前组内数量: ${existing.items.length}`);
        } else {
            await processSingleMediaReply(
                userId,
                state.targetChatId,
                state.targetMessageId,
                state.targetGroupId,
                mediaInfo,
                userMsgId
            );
        }

        updateUserActivity(userId);
        return true;
    }

    logger.warn(`用户 ${userId} 消息回复模式未知步骤: ${state.step}，自动退出`);
    await exitMessageReplyMode(userId, true);
    return true;
}

module.exports = handleMessageReplyMode;
module.exports.getMessageReplyContext = getMessageReplyContext;
module.exports.clearUserContext = clearUserContext;