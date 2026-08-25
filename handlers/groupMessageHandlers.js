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
    findGroupList,
    deleteGroupList
} = require('../db/groupList');
const { getCollection, COLLECTIONS } = require('../db/index');
const { handleQuery } = require('./queryHandler');
const { isAdmin } = require('./queryHandler');
const { insertLog } = require('../db/log');
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
 * 1. message 记录（有文本时）新增 channel_forward 项：标记为频道转发 + 频道源位置 + 群组位置
 *    （不覆盖 chat_id/message_id，保持频道源位置）
 * 2. media 记录写入双位置：group=群组位置、channel=频道位置（有则存），不再覆盖顶层 message_id
 * 使回复操作时用户可选择回复在频道还是群组；给空媒体加注释时也能拿到双位置。
 * 媒体本身（media 记录与 group_id）保持频道收录时的归属，不重复收录。
 * @param {Object} msg - 当前收到的群组消息
 * @param {Object} mediaInfo - 媒体信息
 * @param {Object} [channelForwardInfo] - resolveChannelForwardInfo 的返回值，可选（未传时从已有记录推导）
 */
async function transferRecordToGroup(msg, mediaInfo, channelForwardInfo) {
    try {
        const { fileUniqueId, caption, type } = mediaInfo;
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

        if (existingMessage) {
            // 已有记录（通常为频道侧收录）：保持 chat_id/message_id 为频道源位置，补充 channel_forward
            const update = { channel_forward: channelForward };
            if (caption) update.text = removeLevelSuffix(caption);
            await messageCol.updateOne({ file_unique_id: fileUniqueId }, { $set: update });
        } else if (caption) {
            // 无 message 记录（频道侧未收录文本），群组转发带文本则创建（位置为群组，频道源尽可能补全）
            await upsertMessage({
                message_id: msg.message_id,
                chat_id: msg.chat.id,
                text: removeLevelSuffix(caption),
                file_unique_id: fileUniqueId,
                media_type: type,
                group_id: existingMedia ? existingMedia.group_id : null,
                channel_forward: channelForward
            });
        }

        // media 记录：group/channel 双位置（不再覆盖顶层 message_id，保留首次收录位置）
        if (existingMedia) {
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

        logger.info(`频道转发媒体记录双位置: file_unique_id=${fileUniqueId}, group=${msg.chat.id}/${msg.message_id}, channel=${channelChatId}/${channelMessageId}`);
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

    const { fileUniqueId, type, fileId, caption, videoTime } = mediaInfo;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const hasMediaGroup = !!msg.media_group_id;
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
            message_id: messageId,
            video_time: videoTime,
            ...location
        });
        logger.info(`media 插入: file_unique_id=${fileUniqueId}, type=${type}, message_id=${messageId}, group_id=${groupId}, subgroup=1${videoTime ? `, video_time=${videoTime}` : ''}${location.group ? `, group=${location.group.chat_id}/${location.group.message_id}` : ''}${location.channel ? `, channel=${location.channel.chat_id}/${location.channel.message_id}` : ''}`);
        operations.push({ type: 'media', fileUniqueId, groupId });

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

            await setGroupDelete(groupId, 0);
            operations.push({ type: 'setGroupDelete', groupId, value: 0 });
        } else {
            const groupDoc = await findGroupList(groupId);
            if (groupDoc) {
                if (groupDoc.is_delete === null) {
                    await setGroupDelete(groupId, Date.now());
                    operations.push({ type: 'setGroupDelete', groupId, value: Date.now() });
                    logger.info(`无文本媒体新建组，设置 is_delete 为当前时间戳: group_id=${groupId}`);
                } else if (groupDoc.is_delete !== 0) {
                    await setGroupDelete(groupId, Date.now());
                    operations.push({ type: 'setGroupDelete', groupId, value: Date.now() });
                    logger.info(`无文本媒体加入已有组，更新 is_delete 为当前时间戳: group_id=${groupId}, old=${groupDoc.is_delete}`);
                }
            }
        }

        if (shouldReply) {
            const successText = hasMediaGroup ? '✅ 媒体组收录成功' : '✅ 收录成功';
            await updateProcessingMessage(msg, processingMsg.message_id, successText, true);
            insertLog(1).catch(err => logger.error(`记录日志失败: ${err.message}`));
        }

        if (hasMediaGroup && isFirstOfGroup) {
            groupProcessed.set(groupId, Date.now());
        }

    } catch (err) {
        logger.error(`❌ 收录媒体失败，开始回滚: ${err.message}`);
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
            await setGroupDelete(groupId, 0);
            await updateProcessingMessage(msg, processingMsg.message_id, '✅ 编辑成功', true);
            insertLog(2).catch(err => logger.error(`记录日志失败: ${err.message}`));
        } else {
            if (existingMessage) {
                const delGroupId = existingMessage.group_id;
                await deleteMessageByFileUniqueId(fileUniqueId);
                await setGroupDelete(delGroupId, Date.now());
            }
            await updateProcessingMessage(msg, processingMsg.message_id, '✅ 删除成功', true);
            insertLog(3).catch(err => logger.error(`记录日志失败: ${err.message}`));
        }
    } catch (err) {
        logger.error(`处理编辑消息失败: ${err.message}`);
        await updateProcessingMessage(msg, processingMsg.message_id, '❌ 编辑失败，请稍后重试', true);
    }
}

/**
 * 群组/频道消息总入口（普通消息）
 */
async function handleGroupMessage(msg) {
    if (!['group', 'supergroup', 'channel'].includes(msg.chat.type)) return;

    const hasMedia = SUPPORTED_MEDIA_TYPES.some(type => msg[type]);

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