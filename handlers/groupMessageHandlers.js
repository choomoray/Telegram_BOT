// handlers/groupMessageHandlers.js
const bot = require('../bot');
const logger = require('../logger');
const { generateMessageLink } = require('../utils/chatIdConverter');
const { extractLevel, removeLevelSuffix } = require('../utils/levelExtractor');
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

/**
 * 延迟删除消息
 */
async function scheduleDelete(chatId, messageId, delay = 60 * 1000) {
    setTimeout(async () => {
        try {
            await bot.deleteMessage(chatId, messageId);
            logger.info(`自动删除消息: chatId=${chatId}, messageId=${messageId}`);
        } catch (err) {
            logger.warn(`自动删除消息失败: ${err.message}`);
        }
    }, delay);
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
 * 处理新消息（媒体收录）- 媒体组仅第一条回复，后续静默收录
 */
async function handleNewMediaMessage(msg) {
    const mediaInfo = extractMediaFromMessage(msg); // 统一函数
    if (!mediaInfo) return;

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

        await insertMedia({
            group_id: groupId,
            subgroup: 1,
            file_id: fileId,
            file_unique_id: fileUniqueId,
            media_type: type,
            message_id: messageId,
            video_time: videoTime
        });
        logger.info(`media 插入: file_unique_id=${fileUniqueId}, type=${type}, message_id=${messageId}, group_id=${groupId}, subgroup=1${videoTime ? `, video_time=${videoTime}` : ''}`);
        operations.push({ type: 'media', fileUniqueId, groupId });

        if (caption) {
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
            const level = extractLevel(caption);
            const cleanText = removeLevelSuffix(caption);
            if (existingMessage) {
                await upsertMessage({
                    ...existingMessage,
                    text: cleanText,
                    level: level
                });
            } else {
                await upsertMessage({
                    message_id: messageId,
                    chat_id: chatId,
                    text: cleanText,
                    file_unique_id: fileUniqueId,
                    media_type: type,
                    level: level,
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
                if (executed) {
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
    handleGroupEditedMessage
};