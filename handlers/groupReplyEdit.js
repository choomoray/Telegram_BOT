// handlers/groupReplyEdit.js
/**
 * 群组/频道内快捷编辑：管理员回复一条媒体消息并发送 /edit [新描述]
 *
 * - 定位：按被回复消息的位置反查 media 集合（群组位置/频道位置/顶层位置），
 *   直接得到该媒体的 file_unique_id，跳过"重新发送媒体"步骤
 * - 修改：/edit 带文字 → 一步直接修改；不带文字（仅群组）→ 提示后等待管理员下一条文本
 * - 标签：修改后按新文本重算该 message 自己的标签（标签按 message 独立，不影响组内其他 message）
 * - 清理：1 分钟后删除全部操作记录（机器人的提示 + 管理员的 /edit 命令消息 + 两步流程中的输入文本）
 */
const bot = require('../bot');
const logger = require('../logger');
const { getCollection, COLLECTIONS } = require('../db/getCollection');
const { setUserState, deleteUserState, getRawUserState } = require('../states');
const { isAdmin } = require('../utils/permissions');
const { removeLevelSuffix } = require('../utils/levelExtractor');
const { logOperation } = require('../utils/opLog');

const SUPPORTED_MEDIA_TYPES = ['photo', 'video', 'audio', 'document'];

/** 按被回复消息位置反查 media（群组位置/频道位置/顶层位置） */
async function findMediaByRepliedPosition(chatId, messageId) {
    const mediaCol = getCollection(COLLECTIONS.MEDIA);
    return await mediaCol.findOne({
        $or: [
            { 'group.chat_id': chatId, 'group.message_id': messageId },
            { 'channel.chat_id': chatId, 'channel.message_id': messageId },
            { chat_id: chatId, message_id: messageId }
        ]
    });
}

/** 1 分钟后删除操作记录（复用群组处理器的 scheduleDelete，收到关闭信号时也会立即清理） */
function scheduleDelete(chatId, messageId) {
    if (!chatId || !messageId) return;
    const { scheduleDelete: sd } = require('./groupMessageHandlers');
    sd(chatId, messageId);
}

/**
 * 编辑 caption：优先 HTML 解析；文本含 HTML 特殊字符解析失败时降级为纯文本编辑
 */
async function editCaptionRobust(chatId, messageId, text) {
    try {
        await bot.editMessageCaption(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    } catch (err) {
        if ((err.message || '').includes('parse')) {
            await bot.editMessageCaption(text, { chat_id: chatId, message_id: messageId });
        } else {
            throw err;
        }
    }
}

/** 清理两步等待状态（若存在） */
function cleanupPendingState(userId) {
    if (!userId) return;
    const st = getRawUserState(userId);
    if (st && st.mode === 'edit' && st.step === 'waiting_for_group_text') {
        deleteUserState(userId);
    }
}

/**
 * 执行修改：编辑 Telegram caption + 更新数据库 + 重算标签 + 确认提示 + 1 分钟后删除全部操作记录
 */
async function applyReplyEdit(msg, { mediaDoc, targetChatId, targetMessageId, newText, promptMsgId }) {
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id : null;
    const messageCol = getCollection(COLLECTIONS.MESSAGE);
    const cleanText = removeLevelSuffix(newText);
    const isClearing = newText.trim() === 'null';
    // 群组/频道来源（日志 source）与修改前文本（日志 detail.before）
    const source = msg.chat.type === 'channel' ? 'channel' : 'group';
    const beforeDoc = await messageCol.findOne({ file_unique_id: mediaDoc.file_unique_id });
    const before = beforeDoc ? beforeDoc.text : undefined;

    const { updateMessageDb } = require('./modes/editMode');
    const { reMatchMessageTags, clearMessageTags } = require('../utils/tagSync');

    const updateDbAndTags = async () => {
        await updateMessageDb(messageCol, {
            isClearing,
            targetChatId,
            targetMessageId,
            targetGroupId: mediaDoc.group_id,
            targetFileUniqueId: mediaDoc.file_unique_id,
            targetMediaType: mediaDoc.media_type,
            cleanText
        });
        if (isClearing) {
            await clearMessageTags(mediaDoc.file_unique_id);
        } else if (cleanText) {
            await reMatchMessageTags(mediaDoc.file_unique_id, cleanText);
        }
    };

    const scheduleAllCleanup = (extraMsgId) => {
        if (extraMsgId) scheduleDelete(chatId, extraMsgId);
        scheduleDelete(chatId, msg.message_id); // 管理员的 /edit 命令消息（含频道帖子）
        if (promptMsgId) scheduleDelete(chatId, promptMsgId);
    };

    // 处理中提示
    let procMsg = null;
    try {
        procMsg = await bot.sendMessage(chatId, '♻️ 正在修改...', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.warn(`发送处理中提示失败: ${err.message}`);
    }

    try {
        // 1. 编辑 Telegram 消息的 caption
        if (isClearing) {
            await bot.editMessageCaption('', { chat_id: targetChatId, message_id: targetMessageId });
        } else {
            await editCaptionRobust(targetChatId, targetMessageId, newText);
        }

        // 2. 更新数据库 + 标签重算
        await updateDbAndTags();

        // 3. 确认提示，1 分钟后删除全部操作记录
        const okMsg = await bot.sendMessage(chatId, isClearing ? '✅ 已清空描述' : '✅ 修改完毕', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
        scheduleAllCleanup(okMsg.message_id);
        if (procMsg) scheduleDelete(chatId, procMsg.message_id);

        cleanupPendingState(userId);
        // 群组/频道回复 /edit 成功留痕（over48h=false 表示 Telegram 侧也改成功了）
        logOperation({
            action: 'media_edit',
            source,
            userId,
            chatId,
            messageId: msg.message_id,
            target: { type: 'media', id: mediaDoc.file_unique_id },
            counts: { edits: 1 },
            detail: {
                via: 'reply_edit',
                before,
                after: cleanText,
                clearing: isClearing,
                over48h: false,
                groupId: mediaDoc.group_id,
                mediaType: mediaDoc.media_type,
                targetChatId,
                targetMessageId
            }
        }).catch(() => { });
        logger.info(`群组快捷编辑成功: chatId=${chatId}, target=${targetChatId}/${targetMessageId}, clearing=${isClearing}, userId=${userId}`);
    } catch (err) {
        const errMsg = err.message || '';
        const isEditDenied = errMsg.includes("can't be edited") || errMsg.includes("Can't edit");

        if (isEditDenied) {
            // 超过 48 小时编辑时效：仅更新数据库 + 重算标签（群组内不弹确认按钮），并提示
            try {
                await updateDbAndTags();
                const warnMsg = await bot.sendMessage(chatId, '⚠️ 消息已超过编辑时效（48小时），已仅更新数据库中的描述', {
                    reply_to_message_id: msg.message_id,
                    allow_sending_without_reply: true
                });
                scheduleAllCleanup(warnMsg.message_id);
                if (procMsg) scheduleDelete(chatId, procMsg.message_id);
                cleanupPendingState(userId);
                // 48 小时降级同样是一次成功的编辑（只改了数据库），单独留痕
                logOperation({
                    action: 'media_edit',
                    source,
                    userId,
                    chatId,
                    messageId: msg.message_id,
                    target: { type: 'media', id: mediaDoc.file_unique_id },
                    counts: { edits: 1 },
                    detail: {
                        via: 'reply_edit',
                        before,
                        after: cleanText,
                        clearing: isClearing,
                        over48h: true,
                        groupId: mediaDoc.group_id,
                        mediaType: mediaDoc.media_type,
                        targetChatId,
                        targetMessageId
                    }
                }).catch(() => { });
                logger.info(`群组快捷编辑超时，仅更新数据库: chatId=${chatId}, target=${targetChatId}/${targetMessageId}`);
            } catch (dbErr) {
                logger.error(`群组快捷编辑仅更新数据库失败: ${dbErr.message}`);
                const failMsg = await bot.sendMessage(chatId, '❌ 更新失败，请稍后重试', {
                    reply_to_message_id: msg.message_id,
                    allow_sending_without_reply: true
                });
                scheduleAllCleanup(failMsg.message_id);
                if (procMsg) scheduleDelete(chatId, procMsg.message_id);
                cleanupPendingState(userId);
                logOperation({
                    action: 'media_edit',
                    result: 'fail',
                    source,
                    userId,
                    chatId,
                    messageId: msg.message_id,
                    target: { type: 'media', id: mediaDoc.file_unique_id },
                    detail: { via: 'reply_edit', over48h: true, groupId: mediaDoc.group_id },
                    error: dbErr.message
                }).catch(() => { });
            }
        } else {
            logger.error(`群组快捷编辑失败: ${err.message}`);
            const failMsg = await bot.sendMessage(chatId, '❌ 修改失败，请稍后重试', {
                reply_to_message_id: msg.message_id,
                allow_sending_without_reply: true
            });
            scheduleAllCleanup(failMsg.message_id);
            if (procMsg) scheduleDelete(chatId, procMsg.message_id);
            cleanupPendingState(userId);
            // 真正的失败（非 48 小时降级）
            logOperation({
                action: 'media_edit',
                result: 'fail',
                source,
                userId,
                chatId,
                messageId: msg.message_id,
                target: { type: 'media', id: mediaDoc.file_unique_id },
                detail: { via: 'reply_edit', over48h: false, groupId: mediaDoc.group_id },
                error: err.message
            }).catch(() => { });
        }
    }
}

/**
 * 回复 /edit 入口
 * @returns {Promise<boolean>} 是否已处理（true=已处理并返回；false=未处理，走原逻辑）
 */
async function handleReplyEditCommand(msg, fullCommand) {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const reply = msg.reply_to_message;
    if (!reply) return false;

    // 权限：群组/超级群组按管理员身份；频道只有管理员能发帖（帖子无 from，天然受限）
    if (['group', 'supergroup'].includes(chatType)) {
        const userId = msg.from ? msg.from.id : null;
        if (!userId || !isAdmin(userId)) return false;
    }

    // 被回复的消息必须是媒体
    const repliedType = SUPPORTED_MEDIA_TYPES.find(t => reply[t]);
    if (!repliedType) {
        const errMsg = await bot.sendMessage(chatId, '⚠️ 请回复一条媒体消息再使用 /edit', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
        scheduleDelete(chatId, errMsg.message_id);
        scheduleDelete(chatId, msg.message_id);
        return true;
    }

    // 反查 media
    const mediaDoc = await findMediaByRepliedPosition(chatId, reply.message_id);
    if (!mediaDoc) {
        const errMsg = await bot.sendMessage(chatId, '❌ 未在媒体库中找到该媒体', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
        scheduleDelete(chatId, errMsg.message_id);
        scheduleDelete(chatId, msg.message_id);
        return true;
    }

    // 目标位置：优先群组位置，其次频道位置，最后顶层位置
    const targetChatId = (mediaDoc.group && mediaDoc.group.chat_id) ||
        (mediaDoc.channel && mediaDoc.channel.chat_id) || mediaDoc.chat_id;
    const targetMessageId = (mediaDoc.group && mediaDoc.group.message_id) ||
        (mediaDoc.channel && mediaDoc.channel.message_id) || mediaDoc.message_id;
    if (!targetChatId || !targetMessageId) {
        const errMsg = await bot.sendMessage(chatId, '❌ 媒体位置数据异常，无法编辑', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
        scheduleDelete(chatId, errMsg.message_id);
        scheduleDelete(chatId, msg.message_id);
        return true;
    }

    // 提取 /edit 后的新描述（兼容 /edit@机器人用户名 形式）
    const newText = fullCommand.replace(/^\/edit(?:@\w+)?\s*/, '').trim();

    if (newText) {
        // 一步直接修改
        await applyReplyEdit(msg, {
            mediaDoc,
            targetChatId,
            targetMessageId,
            newText,
            promptMsgId: null
        });
        return true;
    }

    // 无文字：频道不支持两步（频道帖子无法可靠归属"下一条"）
    if (chatType === 'channel') {
        const errMsg = await bot.sendMessage(chatId, '⚠️ 频道中请直接发送：/edit 新描述', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
        scheduleDelete(chatId, errMsg.message_id);
        scheduleDelete(chatId, msg.message_id);
        return true;
    }

    // 群组两步：进入等待文本状态（下一条文本即新描述）
    const userId = msg.from.id;
    const promptMsg = await bot.sendMessage(chatId, '✏️ 请发送新的描述（发送 /null 可清空描述）', {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
    });
    setUserState(userId, {
        mode: 'edit',
        step: 'waiting_for_group_text',
        targetChatId,
        targetMessageId,
        targetGroupId: mediaDoc.group_id,
        targetFileUniqueId: mediaDoc.file_unique_id,
        targetMediaType: mediaDoc.media_type,
        groupChatId: chatId,
        groupCmdMsgId: msg.message_id,
        groupPromptMsgId: promptMsg.message_id,
        lastActivity: Date.now(),
        _onExit: async () => {
            // 超时/退出时删除遗留的提示与命令消息
            try { await bot.deleteMessage(chatId, promptMsg.message_id); } catch (e) { }
            try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }
        }
    });
    logger.info(`用户 ${userId} 群组快捷编辑进入两步等待: chatId=${chatId}, target=${targetChatId}/${targetMessageId}`);
    return true;
}

module.exports = { handleReplyEditCommand };
