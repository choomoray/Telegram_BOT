// handlers/groupMessageHandlers.js
const bot = require('../bot');
const logger = require('../logger');
const { generateMessageLink } = require('../utils/chatIdConverter');
const { removeLevelSuffix } = require('../utils/levelExtractor');
const { generateGroupIdFromMessage } = require('../utils/groupGenerator');
const {
    upsertMessage,
    findMessageByFileUniqueId,
    deleteMessageByFileUniqueId
} = require('../db/message');
const {
    insertMedia,
    findMediaByFileUniqueId,
    deleteMediaByFileUniqueId
} = require('../db/media');
const {
    upsertGroupList,
    setGroupDelete,
    syncGroupDeleteByText,
    findGroupList,
    deleteGroupList
} = require('../db/groupList');
const { getCollection, COLLECTIONS } = require('../db/index');
const { handleQuery } = require('./queryHandler');
const { isAdmin } = require('./queryHandler');
const { logOperation } = require('../utils/opLog');
const { executeCommand } = require('./commands');
const { getUserState } = require('../states');
const handleModeMessage = require('./modes');
const { extractMediaFromMessage } = require('../media'); // 统一媒体提取

const SUPPORTED_MEDIA_TYPES = ['photo', 'video', 'audio', 'document'];

// ---------- 媒体组控制 ----------
const groupLocks = new Map();
const groupProcessed = new Map();
const GROUP_TTL = 5 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of groupLocks.entries()) {
        if (typeof timestamp === 'number' && now - timestamp > GROUP_TTL) {
            groupLocks.delete(key);
        }
    }
    for (const [key, timestamp] of groupProcessed.entries()) {
        if (now - timestamp > GROUP_TTL) {
            groupProcessed.delete(key);
        }
    }
}, 60 * 1000);

// 待定时删除的消息注册表（收到关闭信号时立即执行删除）
const pendingDeletions = new Set();

/**
 * 延迟删除消息（60 秒后自动删除"处理中/收录成功"等提示）
 * 同时登记到 pendingDeletions，收到关闭信号时立即删除
 */
function scheduleDelete(chatId, messageId, delay = 60 * 1000) {
    const key = `${chatId}:${messageId}`;
    pendingDeletions.add(key);
    setTimeout(async () => {
        pendingDeletions.delete(key);
        try {
            await bot.deleteMessage(chatId, messageId);
            logger.info(`自动删除消息: chatId=${chatId}, messageId=${messageId}`);
        } catch (err) {
            logger.warn(`自动删除消息失败: ${err.message}`);
        }
    }, delay);
}

/**
 * 立即执行所有待定时删除的消息（收到关闭信号时调用，不再等待定时器）
 */
async function flushPendingDeletions() {
    for (const key of [...pendingDeletions]) {
        pendingDeletions.delete(key);
        const sep = key.lastIndexOf(':');
        const chatId = Number(key.slice(0, sep));
        const messageId = Number(key.slice(sep + 1));
        try {
            await bot.deleteMessage(chatId, messageId);
            logger.info(`关闭清理: 立即删除定时消息 chatId=${chatId}, messageId=${messageId}`);
        } catch (err) {
            logger.warn(`关闭清理: 删除定时消息失败 chatId=${chatId}, messageId=${messageId}: ${err.message}`);
        }
    }
}

/**
 * 编辑处理中消息为最终结果
 */
async function updateProcessingMessage(msg, processingMessageId, finalText, autoDelete = true) {
    try {
        await bot.editMessageText(finalText, {
            chat_id: msg.chat.id,
            message_id: processingMessageId,
            reply_markup: { inline_keyboard: [] }
        });
        if (autoDelete) {
            await scheduleDelete(msg.chat.id, processingMessageId);
        }
        logger.info(`处理中消息已更新: chatId=${msg.chat.id}, messageId=${processingMessageId}`);
    } catch (err) {
        logger.error(`更新处理中消息失败: ${err.message}`);
    }
}

/**
 * 识别当前群组消息是否为「频道转发」的媒体（关联频道自动转发或手动转发）
 * 识别路径：
 *   1. 转发来源标记：forward_origin.type==='channel'（新版 API）或 forward_from_chat（旧版 API）
 *   2. 自动转发标记 msg.is_automatic_forward === true（Telegram 对"频道→绑定讨论群组"的
 *      自动转发只给该标记、不一定带 forward_origin），结合绑定库 channel_group：
 *      群组文档 { id, type:'group', bind_id } 的 bind_id 即绑定频道 ID
 * @param {Object} msg - 当前收到的群组消息
 * @returns {Promise<{channelChatId: number|null, isAutoForward: boolean}|null>} 频道转发信息，非频道转发返回 null
 */
async function resolveChannelForwardInfo(msg) {
    try {
        if (!['group', 'supergroup'].includes(msg.chat.type)) return null;

        // 路径1：转发来源标记
        let originType = null;
        let originChatId = null;
        if (msg.forward_origin && msg.forward_origin.type) {
            originType = msg.forward_origin.type;
            if (msg.forward_origin.chat) originChatId = msg.forward_origin.chat.id;
        } else if (msg.forward_from_chat) {
            originType = msg.forward_from_chat.type;
            originChatId = msg.forward_from_chat.id;
        }
        if (originType === 'channel') {
            return { channelChatId: originChatId, isAutoForward: !!msg.is_automatic_forward };
        }

        // 路径2：自动转发标记 + 绑定库定位频道
        if (msg.is_automatic_forward) {
            const channelGroupCol = getCollection(COLLECTIONS.CHANNEL_GROUP);
            const groupDoc = await channelGroupCol.findOne({ id: msg.chat.id, type: 'group' });
            if (groupDoc && groupDoc.bind_id) {
                return { channelChatId: groupDoc.bind_id, isAutoForward: true };
            }
        }

        return null;
    } catch (err) {
        logger.error(`识别频道转发来源失败: ${err.message}`);
        return null;
    }
}

/**
 * 判断是否为「频道 → 讨论群组」的自动转发重复媒体（去重分支兜底）
 * Telegram 机制：频道发布媒体会自动转发一份到绑定的讨论群组，
 * 此时群组收到的媒体在媒体库中已存在（已从频道收录），应静默忽略而非提示重复。
 * @param {Object} msg - 当前收到的群组消息
 * @param {Object} existingMessage - 媒体库中已存在的 message 记录
 * @returns {Promise<boolean>}
 */
async function isChannelAutoForward(msg, existingMessage) {
    try {
        if (!['group', 'supergroup'].includes(msg.chat.type)) return false;
        if (!existingMessage || !existingMessage.chat_id) return false;

        // 方式一：转发来源为频道且与已收录消息同源
        let originChatId = null;
        if (msg.forward_origin && msg.forward_origin.type === 'channel' && msg.forward_origin.chat) {
            originChatId = msg.forward_origin.chat.id;
        } else if (msg.forward_from_chat) {
            originChatId = msg.forward_from_chat.id;
        }
        if (originChatId && existingMessage.chat_id === originChatId) {
            return true;
        }

        // 方式二：已收录媒体来自被管理的频道，且当前群组绑定了该频道
        // （使用绑定库 channel_group 的 bind_id 精确判定频道↔群组关系）
        const channelGroupCol = getCollection(COLLECTIONS.CHANNEL_GROUP);
        const group = await channelGroupCol.findOne({ id: msg.chat.id, type: 'group' });
        if (!group || !group.bind_id) return false;
        if (existingMessage.chat_id === group.bind_id) return true;
        // 放宽：已收录媒体的归属频道与当前群组都在管理库中（兼容 bind_id 未填写的旧绑定）
        const channel = await channelGroupCol.findOne({ id: existingMessage.chat_id, type: 'channel' });
        return !!channel;
    } catch (err) {
        logger.error(`判断频道转发失败: ${err.message}`);
        return false;
    }
}

/**
 * 频道转发媒体归属记录：群组收到频道转发的媒体时，
 * 1. 媒体库中已有该媒体 → 写入双位置（group=群组位置、channel=频道位置）不重复收录；
 *    有文本时同步 message.channel_forward（标记频道转发 + 频道源位置 + 群组位置）
 * 2. 媒体库中没有该媒体（频道侧未收录 / 记录已被清理）→ **照常收录**：
 *    新建 group_list + media（群组位置），有文本再写 message；空描述则只留 media，
 *    group_list.is_delete 记为时间戳（表示可被 /clean 清理），后续补文本会自动变为 0
 * 使回复操作时用户可选择回复在频道还是群组；给空媒体加注释时也能拿到双位置。
 * @param {Object} msg - 当前收到的群组消息
 * @param {Object} mediaInfo - 媒体信息
 * @param {Object} [channelForwardInfo] - resolveChannelForwardInfo 的返回值，可选（未传时从已有记录推导）
 */
async function transferRecordToGroup(msg, mediaInfo, channelForwardInfo) {
    try {
        const { fileUniqueId, caption, type, fileId, videoTime } = mediaInfo;
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const mediaCol = getCollection(COLLECTIONS.MEDIA);

        const existingMessage = await messageCol.findOne({ file_unique_id: fileUniqueId });
        const existingMedia = await mediaCol.findOne({ file_unique_id: fileUniqueId });

        // 频道源位置：优先取识别信息/已有 message 记录，均无则 null
        const channelChatId = (channelForwardInfo && channelForwardInfo.channelChatId) ||
            (existingMessage && existingMessage.chat_id) || null;
        const channelMessageId = existingMessage ? existingMessage.message_id : null;

        const channelForward = {
            is_channel: true,
            channel_chat_id: channelChatId,
            channel_message_id: channelMessageId,
            group_chat_id: msg.chat.id,
            group_message_id: msg.message_id
        };

        // ---------- 媒体库中不存在该媒体：照常收录（空描述也必须收录） ----------
        let groupId = existingMedia ? existingMedia.group_id : null;
        const collectedNow = !existingMedia;
        if (collectedNow) {
            groupId = generateGroupIdFromMessage(msg);
            if (!groupId) {
                logger.error(`频道转发媒体无法生成 group_id: chatId=${msg.chat.id}, messageId=${msg.message_id}`);
                return;
            }
            await upsertGroupList(groupId);
            const doc = {
                group_id: groupId,
                subgroup: 1,
                file_id: fileId,
                file_unique_id: fileUniqueId,
                media_type: type,
                // 位置只写 group / channel 子文档（顶层 message_id 已废弃）
                group: { chat_id: msg.chat.id, message_id: msg.message_id }
            };
            if (type === 'video' && videoTime !== undefined && videoTime !== null) {
                doc.video_time = videoTime;
            }
            if (mediaInfo.thumbFileId) doc.thumb_file_id = mediaInfo.thumbFileId;
            // 频道位置仅在已知频道消息 ID 时写入（否则无法据此回复频道）
            if (channelChatId && channelMessageId) {
                doc.channel = { chat_id: channelChatId, message_id: channelMessageId };
            }
            await insertMedia(doc);
            logger.info(`频道转发媒体库中不存在，照常收录: file_unique_id=${fileUniqueId}, group_id=${groupId}, group=${msg.chat.id}/${msg.message_id}${caption ? ', 含描述' : ', 空描述(可被清理)'}`);
        }

        // ---------- message 记录：已有则补充 channel_forward（有文本时更新文本），无则按需新建 ----------
        if (existingMessage) {
            // 已有记录（通常为频道侧收录）：保持 chat_id/message_id 为频道源位置，补充 channel_forward
            const update = { channel_forward: channelForward };
            if (caption) update.text = removeLevelSuffix(caption);
            await messageCol.updateOne({ file_unique_id: fileUniqueId }, { $set: update });
        } else if (caption) {
            await upsertMessage({
                message_id: msg.message_id,
                chat_id: msg.chat.id,
                text: removeLevelSuffix(caption),
                file_unique_id: fileUniqueId,
                media_type: type,
                group_id: groupId,
                channel_forward: channelForward
            });
        }

        // ---------- media 记录：原本就有则补双位置（顶层 message_id 保留首次收录位置） ----------
        if (!collectedNow) {
            const update = {
                'group.chat_id': msg.chat.id,
                'group.message_id': msg.message_id
            };
            if (channelChatId) {
                update['channel.chat_id'] = channelChatId;
                if (channelMessageId) update['channel.message_id'] = channelMessageId;
            }
            await mediaCol.updateOne({ file_unique_id: fileUniqueId }, { $set: update });
        }

        // ---------- 文本状态变化后重算 is_delete（有文本 → 0；空描述 → 时间戳） ----------
        if (groupId && (collectedNow || caption)) {
            await syncGroupDeleteByText(groupId);
        }

        logger.info(`频道转发媒体记录完成: file_unique_id=${fileUniqueId}, group=${msg.chat.id}/${msg.message_id}, channel=${channelChatId}/${channelMessageId}${collectedNow ? ', 本次新收录' : ''}`);
        // 频道转发归属日志（区分「库里已有 → 仅补位置」与「库里没有 → 本次新收录」）
        logOperation({
            action: 'channel_forward',
            source: 'group',
            userId: msg.from ? msg.from.id : undefined,
            chatId: msg.chat.id,
            messageId: msg.message_id,
            target: { type: 'media', id: fileUniqueId },
            counts: collectedNow ? { media: 1, groups: 1 } : {},
            detail: {
                mediaType: type,
                fileName: fileUniqueId,
                collectedNow,
                hasCaption: !!caption,
                channelChatId,
                channelMessageId,
                groupId
            }
        }).catch(() => { });
    } catch (err) {
        logger.error(`频道转发归属记录失败: ${err.message}`);
    }
}

/**
 * 处理新消息（媒体收录）- 媒体组仅第一条回复，后续静默收录
 */
async function handleNewMediaMessage(msg) {
    const mediaInfo = extractMediaFromMessage(msg); // 统一函数
    if (!mediaInfo) return;

    // 频道→讨论群组自动转发（或手动转发）的频道媒体：不重复收录，
    // 记录 message.channel_forward + media 双位置（群组位置 + 频道位置），使回复时可选频道或群组
    const channelForwardInfo = await resolveChannelForwardInfo(msg);
    if (channelForwardInfo) {
        await transferRecordToGroup(msg, mediaInfo, channelForwardInfo);
        return;
    }

    const { fileUniqueId, type, fileId, caption, videoTime, thumbFileId } = mediaInfo;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const hasMediaGroup = !!msg.media_group_id;
    const source = msg.chat.type === 'channel' ? 'channel' : 'group';
    const groupId = generateGroupIdFromMessage(msg);
    if (!groupId) {
        logger.error(`无法生成 group_id: chatId=${chatId}, messageId=${messageId}`);
        return;
    }

    // ---------- 媒体组处理：判断是否需要回复 ----------
    let shouldReply = true;
    let isFirstOfGroup = false;
    let processingMsg = null;

    if (hasMediaGroup) {
        if (groupProcessed.has(groupId)) {
            shouldReply = false;
        } else if (groupLocks.has(groupId)) {
            shouldReply = false;
        } else {
            isFirstOfGroup = true;
            groupLocks.set(groupId, Date.now());
            try {
                processingMsg = await bot.sendMessage(chatId, '♻️ 接收到消息，正在处理中...', {
                    reply_to_message_id: messageId,
                    allow_sending_without_reply: true
                });
            } catch (err) {
                logger.error(`发送处理中消息失败: ${err.message}`);
                groupLocks.delete(groupId);
                return;
            }
        }
    } else {
        try {
            processingMsg = await bot.sendMessage(chatId, '♻️ 接收到消息，正在处理中...', {
                reply_to_message_id: messageId,
                allow_sending_without_reply: true
            });
        } catch (err) {
            logger.error(`发送处理中消息失败: ${err.message}`);
            return;
        }
    }

    // ---------- 数据库操作 ----------
    const operations = [];

    try {
        // 1. 去重检查
        const existingMedia = await findMediaByFileUniqueId(fileUniqueId);
        if (existingMedia) {
            const existingMessage = await findMessageByFileUniqueId(fileUniqueId);
            if (existingMessage) {
                // 频道→讨论群组自动转发（Telegram 机制）：媒体已在频道收录，
                // 群组收到同一条转发媒体时把记录归属转移为群组（不重复收录、不提示）
                if (await isChannelAutoForward(msg, existingMessage)) {
                    await transferRecordToGroup(msg, mediaInfo);
                    logger.info(`频道转发媒体归属转移(去重兜底): chatId=${msg.chat.id}, file_unique_id=${fileUniqueId}`);
                    if (hasMediaGroup && isFirstOfGroup) {
                        groupProcessed.set(groupId, Date.now());
                    }
                    return;
                }
                if (shouldReply && isFirstOfGroup) {
                    const link = generateMessageLink(existingMessage.chat_id, existingMessage.message_id);
                    const button = {
                        inline_keyboard: [[
                            { text: '🔗 跳转查看', url: link }
                        ]]
                    };
                    await bot.editMessageText('❌ 数据重复', {
                        chat_id: chatId,
                        message_id: processingMsg.message_id,
                        reply_markup: button
                    });
                    logger.info(`重复数据回复已发送: chatId=${chatId}, file_unique_id=${fileUniqueId}`);
                } else if (shouldReply && !hasMediaGroup) {
                    const link = generateMessageLink(existingMessage.chat_id, existingMessage.message_id);
                    const button = {
                        inline_keyboard: [[
                            { text: '🔗 跳转查看', url: link }
                        ]]
                    };
                    await bot.editMessageText('❌ 数据重复', {
                        chat_id: chatId,
                        message_id: processingMsg.message_id,
                        reply_markup: button
                    });
                    logger.info(`重复数据回复已发送: chatId=${chatId}, file_unique_id=${fileUniqueId}`);
                } else {
                    logger.info(`媒体组后续消息重复，静默忽略: groupId=${groupId}, file_unique_id=${fileUniqueId}`);
                }
            } else {
                if (shouldReply) {
                    await updateProcessingMessage(msg, processingMsg.message_id, '❌ 未收录的重复数据', false);
                }
            }

            if (hasMediaGroup && isFirstOfGroup) {
                groupProcessed.set(groupId, Date.now());
            }
            // 重复命中也是有效统计口径（重复率/来源分析），与成功收录分开记录
            logOperation({
                action: 'media_save_duplicate',
                source,
                userId: msg.from ? msg.from.id : undefined,
                chatId,
                messageId,
                target: { type: 'media', id: fileUniqueId },
                counts: { media: 1 },
                detail: {
                    mediaType: type,
                    fileName: fileUniqueId,
                    groupId,
                    isMediaGroup: hasMediaGroup,
                    existingChatId: existingMedia.chat_id || (existingMedia.group && existingMedia.group.chat_id) || null,
                    existingGroupId: existingMedia.group_id || null
                }
            }).catch(() => { });
            return;
        }

        // 2. 收录操作
        await upsertGroupList(groupId);
        operations.push({ type: 'groupList', groupId });

        // 写入媒体位置：频道收录存 channel，群组收录存 group
        const { buildMediaLocation } = require('../db/media');
        const location = await buildMediaLocation(chatId, messageId, msg.chat.type);

        await insertMedia({
            group_id: groupId,
            subgroup: 1,
            file_id: fileId,
            file_unique_id: fileUniqueId,
            media_type: type,
            video_time: videoTime,
            thumb_file_id: thumbFileId,
            ...location
        });
        logger.info(`media 插入: file_unique_id=${fileUniqueId}, type=${type}, message_id=${messageId}, group_id=${groupId}, subgroup=1${videoTime ? `, video_time=${videoTime}` : ''}${location.group ? `, group=${location.group.chat_id}/${location.group.message_id}` : ''}${location.channel ? `, channel=${location.channel.chat_id}/${location.channel.message_id}` : ''}`);
        operations.push({ type: 'media', fileUniqueId, groupId });

        // 组内文本状态变化后统一重算 is_delete：
        // 有文本 → 0（无需清理）；空描述 → 时间戳（可被 /clean 清理），后续补/改文本会自动回到 0
        const groupDocBefore = await findGroupList(groupId);
        const prevIsDelete = groupDocBefore ? groupDocBefore.is_delete : null;

        if (caption) {
            const cleanText = removeLevelSuffix(caption);
            await upsertMessage({
                message_id: messageId,
                chat_id: chatId,
                text: cleanText,
                file_unique_id: fileUniqueId,
                media_type: type,
                group_id: groupId
            });
            operations.push({ type: 'message', fileUniqueId, groupId });
        }

        const isDelete = await syncGroupDeleteByText(groupId);
        if (isDelete !== prevIsDelete) {
            operations.push({ type: 'setGroupDelete', groupId, value: prevIsDelete });
        }
        logger.info(`group_list 文本状态重算: group_id=${groupId}, is_delete=${isDelete}${caption ? '（有描述）' : '（空描述，可被清理）'}`);

        if (shouldReply) {
            const successText = hasMediaGroup ? '✅ 媒体组收录成功' : '✅ 收录成功';
            await updateProcessingMessage(msg, processingMsg.message_id, successText, true);
        }

        // 收录成功日志（每条媒体一条，含类型/时长/是否有描述/标签来源等报表字段）
        logOperation({
            action: 'media_save',
            source,
            userId: msg.from ? msg.from.id : undefined,
            chatId,
            messageId,
            target: { type: 'media_group', id: groupId },
            counts: { media: 1, captions: caption ? 1 : 0, groups: 1 },
            detail: {
                mediaType: type,
                fileName: fileUniqueId,
                videoTime: videoTime || undefined,
                hasCaption: !!caption,
                captionLength: caption ? caption.length : 0,
                isMediaGroup: hasMediaGroup,
                mediaGroupId: msg.media_group_id || undefined,
                position: location.channel ? 'channel' : 'group',
                isDelete
            }
        }).catch(() => { });

        if (hasMediaGroup && isFirstOfGroup) {
            groupProcessed.set(groupId, Date.now());
        }

    } catch (err) {
        logger.error(`❌ 收录媒体失败，开始回滚: ${err.message}`);
        // 失败也要留痕：便于统计失败率与排障
        logOperation({
            action: 'media_save_fail',
            result: 'fail',
            source,
            userId: msg.from ? msg.from.id : undefined,
            chatId,
            messageId,
            target: { type: 'media_group', id: groupId },
            counts: { media: 1 },
            detail: { mediaType: type, fileName: fileUniqueId, isMediaGroup: hasMediaGroup, rolledBack: operations.length },
            error: err.message
        }).catch(() => { });
        for (const op of operations.reverse()) {
            try {
                switch (op.type) {
                    case 'media':
                        await deleteMediaByFileUniqueId(op.fileUniqueId);
                        break;
                    case 'message':
                        await deleteMessageByFileUniqueId(op.fileUniqueId);
                        break;
                    case 'groupList': {
                        const col = getCollection(COLLECTIONS.GROUP_LIST);
                        await col.updateOne(
                            { group_id: op.groupId },
                            { $inc: { is_group: -1 } }
                        );
                        const groupDoc = await col.findOne({ group_id: op.groupId });
                        if (groupDoc && groupDoc.is_group <= 0) {
                            await deleteGroupList(op.groupId);
                        }
                        break;
                    }
                    case 'setGroupDelete':
                        await setGroupDelete(op.groupId, op.value);
                        break;
                }
            } catch (rollbackErr) {
                logger.error(`回滚操作失败: ${rollbackErr.message}`, op);
            }
        }
        if (shouldReply) {
            await updateProcessingMessage(msg, processingMsg.message_id, '❌ 收录失败，请稍后重试', true);
        }
        if (hasMediaGroup && isFirstOfGroup) {
            groupProcessed.set(groupId, Date.now());
        }
    } finally {
        if (hasMediaGroup && isFirstOfGroup) {
            groupLocks.delete(groupId);
        }
    }
}

/**
 * 处理编辑消息
 */
async function handleEditedMessage(msg) {
    const mediaInfo = extractMediaFromMessage(msg);
    if (!mediaInfo) return;

    const { fileUniqueId, type, caption } = mediaInfo;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const source = msg.chat.type === 'channel' ? 'channel' : 'group';
    const groupId = generateGroupIdFromMessage(msg);
    if (!groupId) return;

    let processingMsg;
    try {
        processingMsg = await bot.sendMessage(chatId, '♻️ 接收到编辑消息，正在处理中...', {
            reply_to_message_id: messageId,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送处理中消息失败: ${err.message}`);
        return;
    }

    try {
        const existingMessage = await findMessageByFileUniqueId(fileUniqueId);
        if (caption) {
            const cleanText = removeLevelSuffix(caption);
            if (existingMessage) {
                await upsertMessage({
                    ...existingMessage,
                    text: cleanText
                });
            } else {
                await upsertMessage({
                    message_id: messageId,
                    chat_id: chatId,
                    text: cleanText,
                    file_unique_id: fileUniqueId,
                    media_type: type,
                    group_id: groupId
                });
            }
            await syncGroupDeleteByText(groupId);
            // 标签按 message 独立：编辑后按新文本重算该 message 自己的标签（不影响组内其他 message）
            const { reMatchMessageTags } = require('../utils/tagSync');
            await reMatchMessageTags(fileUniqueId, cleanText);
            await updateProcessingMessage(msg, processingMsg.message_id, '✅ 编辑成功', true);
            logOperation({
                action: 'media_edit',
                source,
                userId: msg.from ? msg.from.id : undefined,
                chatId,
                messageId,
                target: { type: 'media', id: fileUniqueId },
                counts: { edits: 1 },
                detail: {
                    mediaType: type,
                    groupId,
                    before: existingMessage ? existingMessage.text : undefined,
                    after: cleanText,
                    textLength: cleanText.length,
                    isNewRecord: !existingMessage
                }
            }).catch(() => { });
        } else {
            if (existingMessage) {
                const delGroupId = existingMessage.group_id;
                await deleteMessageByFileUniqueId(fileUniqueId);
                // 描述被清空：组内若还有其他文本则保持 0，否则记为时间戳（可被 /clean 清理）
                await syncGroupDeleteByText(delGroupId);
            }
            await updateProcessingMessage(msg, processingMsg.message_id, '✅ 删除成功', true);
            logOperation({
                action: 'media_delete',
                source,
                userId: msg.from ? msg.from.id : undefined,
                chatId,
                messageId,
                target: { type: 'media', id: fileUniqueId },
                counts: { edits: 1 },
                detail: {
                    mediaType: type,
                    groupId,
                    removedText: existingMessage ? existingMessage.text : undefined,
                    hadText: !!existingMessage
                }
            }).catch(() => { });
        }
    } catch (err) {
        logger.error(`处理编辑消息失败: ${err.message}`);
        logOperation({
            action: 'media_edit',
            result: 'fail',
            source,
            userId: msg.from ? msg.from.id : undefined,
            chatId,
            messageId,
            target: { type: 'media', id: fileUniqueId },
            error: err.message
        }).catch(() => { });
        await updateProcessingMessage(msg, processingMsg.message_id, '❌ 编辑失败，请稍后重试', true);
    }
}

/**
 * 群组/频道消息总入口（普通消息）
 */
async function handleGroupMessage(msg) {
    if (!['group', 'supergroup', 'channel'].includes(msg.chat.type)) return;

    const hasMedia = SUPPORTED_MEDIA_TYPES.some(type => msg[type]);

    // 群组/频道：管理员回复媒体 + /edit（支持 /edit@机器人用户名 形式）快捷编辑
    // （频道帖子无 from，须在身份校验前拦截；群组内非管理员会由 handleReplyEditCommand 返回 false 走原逻辑）
    const isReplyEdit = !!msg.reply_to_message && /^\/edit(?:@\w+)?(\s|$)/i.test((msg.text || '').trim());
    if (isReplyEdit && !hasMedia) {
        const { handleReplyEditCommand } = require('./groupReplyEdit');
        const handled = await handleReplyEditCommand(msg, (msg.text || '').trim());
        if (handled) {
            logger.info(`[群组] 回复 /edit 快捷编辑已处理: chatId=${msg.chat.id}, messageId=${msg.message_id}`);
            return;
        }
    }

    if (hasMedia) {
        logger.info(`[群组媒体消息] 收到: chatId=${msg.chat.id}, messageId=${msg.message_id}, mediaGroupId=${msg.media_group_id || '单条'}`);
        await handleNewMediaMessage(msg);
    } else {
        const userId = msg.from ? msg.from.id : null;
        if (userId && isAdmin(userId)) {
            const messageText = msg.text || '';

            // 1. 优先检查用户是否有活跃模式（如 edit, chat 等）
            const userState = getUserState(userId);
            if (userState && userState.mode) {
                logger.info(`[群组] 管理员 ${userId} 处于模式 ${userState.mode}，交给模式处理器`);
                await handleModeMessage(msg, userState);
                return;
            }

            // 2. 处理命令
            if (messageText.startsWith('/')) {
                const fullCommand = messageText.trim();
                const executed = await executeCommand(fullCommand, userId, msg);
                if (executed === 'executed') {
                    logger.info(`[群组] 管理员 ${userId} 执行命令: ${fullCommand}`);
                    return;
                }
            }

            // 3. 最后处理查询
            logger.info(`[群组查询] 管理员 ${userId} 发送文本: ${msg.text}`);
            await handleQuery(msg);
        } else {
            logger.info(`[群组] 非管理员或匿名文本消息已忽略: userId=${userId}`);
        }
    }
}

/**
 * 群组编辑消息入口
 */
async function handleGroupEditedMessage(editedMsg) {
    if (!['group', 'supergroup', 'channel'].includes(editedMsg.chat.type)) return;
    const hasMedia = SUPPORTED_MEDIA_TYPES.some(type => editedMsg[type]);
    if (!hasMedia) return;

    await handleEditedMessage(editedMsg);
}

module.exports = {
    handleGroupMessage,
    handleGroupEditedMessage,
    scheduleDelete,
    flushPendingDeletions
};