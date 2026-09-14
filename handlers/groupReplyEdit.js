// handlers/groupReplyEdit.js
/**
 * 群组/频道内快捷编辑：管理员回复一条消息并发送 /edit [新描述]
 *
 * - 定位：按被回复消息的位置反查 media 集合（群组位置/频道位置/顶层位置），
 *   直接得到该媒体的 file_unique_id，跳过"重新发送媒体"步骤；
 *   被回复的是**频道帖的自动转发副本**时，再按转发来源定位频道源消息（改频道源消息会同步到群里）
 * - 目标：既支持媒体消息（改 caption），也支持机器人发出的**文本消息**
 *   （media_type='text'，正文在媒体库里存 media_name，改的是消息 text）
 * - 修改：/edit 带文字 → 一步直接修改；不带文字（仅群组）→ 提示后等待管理员下一条文本
 * - 标签：修改后按新文本重算该 message 自己的标签（标签按 message 独立，不影响组内其他 message）
 * - 清理：1 分钟后删除全部操作记录（机器人的提示 + 管理员的 /edit 命令消息 + 两步流程中的输入文本）
 */
const bot = require('../bot');
const logger = require('../logger');
const { getCollection, COLLECTIONS } = require('../db/getCollection');
const { findMediaByPosition } = require('../db/media');
const { setUserState, deleteUserState, getRawUserState } = require('../states');
const { isAdmin } = require('../utils/permissions');
const { removeLevelSuffix } = require('../utils/levelExtractor');
const { logOperation } = require('../utils/opLog');
const { resolveMessageOrigin } = require('../utils/messageLocator');
const { applyTextMediaEdit } = require('../utils/textMediaEdit');
const { projectEntities, shiftEntities } = require('../utils/textEntities');
const {
    isEditTargetError,
    resolveEditTargets,
    editContentWithFallback,
    editTargetKind
} = require('../utils/editTarget');

const SUPPORTED_MEDIA_TYPES = ['photo', 'video', 'audio', 'document'];

/** 按被回复消息位置反查 media（群组位置/频道位置/顶层位置 + 文本媒体的位置 file_unique_id） */
async function findMediaByRepliedPosition(chatId, messageId) {
    return await findMediaByPosition(chatId, messageId);
}

/** 1 分钟后删除操作记录（复用群组处理器的 scheduleDelete，收到关闭信号时也会立即清理） */
function scheduleDelete(chatId, messageId) {
    if (!chatId || !messageId) return;
    const { scheduleDelete: sd } = require('./groupMessageHandlers');
    sd(chatId, messageId);
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
 * 取出「/edit@Bot 之后的正文」以及它在原消息文本里的起始下标
 *
 * 起始下标用来把管理员消息的 entities 平移到正文上；**不能用 indexOf 按内容猜** ——
 * 正文可能和命令前缀里的字符重合（如 `/edit@SexFavoritesBOT BOT`）。
 * @param {string} rawText - 管理员这条消息的原始文本
 * @returns {{text: string, start: number}} 正文（去掉首尾空白）与它的起始下标
 */
function extractEditBody(rawText) {
    const text = String(rawText || '');
    const m = text.match(/^\s*\/edit(?:@\w+)?/i);
    const from = m ? m[0].length : 0;
    let start = from;
    while (start < text.length && /\s/.test(text[start])) start++;
    let end = text.length;
    while (end > start && /\s/.test(text[end - 1])) end--;
    return { text: text.slice(start, end), start };
}

/**
 * 执行修改：编辑 Telegram 消息正文（caption / text）+ 更新数据库 + 重算标签 + 确认提示
 * + 1 分钟后删除全部操作记录
 *
 * @param {Object} msg - 管理员的 /edit 命令消息
 * @param {Object} p
 *   - mediaDoc：媒体库记录（**库外消息为 null**：只改 Telegram，不动数据库）
 *   - editTargets：候选编辑位置
 *   - newText：新正文；`null` 表示清空（仅媒体 caption 支持）
 *   - promptMsgId：两步流程的提示消息（一步流程为 null）
 *   - kind：'text'（文本消息）/ 'caption'（媒体描述）
 *   - entities：**已经平移到 newText 上**的富文本 entities（严格保留用户发送的格式）
 */
async function applyReplyEdit(msg, { mediaDoc, editTargets, newText, promptMsgId, kind, entities }) {
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id : null;
    const messageCol = getCollection(COLLECTIONS.MESSAGE);
    const cleanText = removeLevelSuffix(newText);
    const isClearing = newText.trim() === 'null';
    const isTextTarget = kind === 'text';
    const hasRecord = !!mediaDoc;
    const fileUniqueId = hasRecord ? mediaDoc.file_unique_id : null;
    // 落库用 cleanText（去掉 #X 后缀/首尾空白）→ entities 从 newText 再平移一次
    const dbEntities = isTextTarget ? projectEntities(entities, newText, cleanText) : null;
    // 群组/频道来源（日志 source）与修改前正文（日志 detail.before）
    const source = msg.chat.type === 'channel' ? 'channel' : 'group';
    const beforeDoc = hasRecord ? await messageCol.findOne({ file_unique_id: fileUniqueId }) : null;
    const before = (beforeDoc && beforeDoc.text) || (isTextTarget && hasRecord ? mediaDoc.media_name : undefined);

    const { updateMessageDb } = require('./modes/editMode');
    const { reMatchMessageTags, clearMessageTags } = require('../utils/tagSync');

    const updateDbAndTags = async (target) => {
        if (!hasRecord) return false; // 库外消息：只改 Telegram，数据库无可更新
        // 文本消息：正文在 media.media_name（顺带同步可能存在的 message 记录）
        if (isTextTarget) {
            await applyTextMediaEdit(fileUniqueId, cleanText, dbEntities);
            return true;
        }
        // 清空描述：先清标签（此刻 message 记录还在，才能递减标签使用次数），再删记录；
        // 编辑描述：保留已有标签，只补充新文本匹配到的（放在 updateMessageDb 之后，确保记录存在）
        if (isClearing) {
            await clearMessageTags(fileUniqueId);
        }
        await updateMessageDb(messageCol, {
            isClearing,
            targetChatId: target.chatId,
            targetMessageId: target.messageId,
            targetGroupId: mediaDoc.group_id,
            targetFileUniqueId: fileUniqueId,
            targetMediaType: mediaDoc.media_type,
            cleanText
        });
        if (!isClearing && cleanText) {
            await reMatchMessageTags(fileUniqueId, cleanText);
        }
        return true;
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
        // 1. 编辑 Telegram 消息正文
        //    位置：频道源位置优先（频道 → 讨论群自动转发时改动会自动同步到群里的副本），
        //    该位置改不了（超 48 小时 / 不是机器人发的）时再退群组位置重试
        const edited = await editContentWithFallback(bot, editTargets, kind, isClearing ? '' : newText, entities);

        // 2. 更新数据库 + 标签重算
        await updateDbAndTags(edited);

        // 3. 确认提示，1 分钟后删除全部操作记录
        const okText = isClearing
            ? '✅ 已清空描述'
            : (hasRecord ? '✅ 修改完毕' : '✅ 修改完毕（媒体库中无该消息记录，仅改了 Telegram 消息）');
        const okMsg = await bot.sendMessage(chatId, okText, {
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
            target: { type: 'media', id: fileUniqueId || 'unknown' },
            counts: { edits: 1 },
            detail: {
                via: 'reply_edit',
                kind,
                before,
                after: cleanText,
                clearing: isClearing,
                over48h: false,
                hasRecord,
                groupId: mediaDoc ? mediaDoc.group_id : undefined,
                mediaType: mediaDoc ? mediaDoc.media_type : undefined,
                targetChatId: edited.chatId,
                targetMessageId: edited.messageId,
                editVia: edited.via
            }
        }).catch(() => { });
        logger.info(`群组快捷编辑成功: chatId=${chatId}, target=${edited.chatId}/${edited.messageId} (via=${edited.via}, kind=${kind}), clearing=${isClearing}, userId=${userId}`);
    } catch (err) {
        const isEditDenied = isEditTargetError(err);

        if (isEditDenied && hasRecord) {
            // 超 48 小时 / 该位置不是机器人发的：仅更新数据库 + 重算标签（群组内不弹确认按钮），并提示
            try {
                await updateDbAndTags(editTargets[0]);
                const warnText = isTextTarget
                    ? '⚠️ 消息已超过编辑时效（48小时），已仅更新数据库中的文本'
                    : '⚠️ 消息已超过编辑时效（48小时），已仅更新数据库中的描述';
                const warnMsg = await bot.sendMessage(chatId, warnText, {
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
                    target: { type: 'media', id: fileUniqueId },
                    counts: { edits: 1 },
                    detail: {
                        via: 'reply_edit',
                        kind,
                        before,
                        after: cleanText,
                        clearing: isClearing,
                        over48h: true,
                        groupId: mediaDoc.group_id,
                        mediaType: mediaDoc.media_type,
                        targetChatId: editTargets[0].chatId,
                        targetMessageId: editTargets[0].messageId
                    }
                }).catch(() => { });
                logger.info(`群组快捷编辑超时，仅更新数据库: chatId=${chatId}, target=${editTargets[0].chatId}/${editTargets[0].messageId}`);
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
                    target: { type: 'media', id: fileUniqueId },
                    detail: { via: 'reply_edit', kind, over48h: true, groupId: mediaDoc.group_id },
                    error: dbErr.message
                }).catch(() => { });
            }
        } else if (isEditDenied) {
            // 库外消息且改不了：不是机器人发的 / 只是频道转发的副本（Telegram 只允许改机器人自己的消息）
            logger.warn(`群组快捷编辑失败（库外消息不可编辑）: ${err.message}`);
            const failMsg = await bot.sendMessage(
                chatId,
                '❌ 无法修改该消息（不是机器人发送的，或只是频道转发的副本）；请在原频道/群组里回复它再试',
                { reply_to_message_id: msg.message_id, allow_sending_without_reply: true }
            );
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
                target: { type: 'media', id: 'unknown' },
                detail: { via: 'reply_edit', kind, over48h: false, hasRecord: false },
                error: err.message
            }).catch(() => { });
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
                target: { type: 'media', id: fileUniqueId || 'unknown' },
                detail: { via: 'reply_edit', kind, over48h: false, groupId: mediaDoc ? mediaDoc.group_id : undefined },
                error: err.message
            }).catch(() => { });
        }
    }
}

/**
 * 回复 /edit 入口
 * @param {Object} msg - 管理员的 /edit 命令消息（正文与 entities 都取自它）
 * @param {string} fullCommand - 调用方传入的整条命令文本（已 trim）；正文解析改为按 msg.text
 *   的下标做，以便把 entities 精确平移到正文上，此参数保留只为兼容调用方
 * @returns {Promise<boolean>} 是否已处理（true=已处理并返回；false=未处理，走原逻辑）
 */
async function handleReplyEditCommand(msg, fullCommand = '') {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const reply = msg.reply_to_message;
    if (!reply) return false;

    // 权限：群组/超级群组按管理员身份；频道只有管理员能发帖（帖子无 from，天然受限）
    if (['group', 'supergroup'].includes(chatType)) {
        const userId = msg.from ? msg.from.id : null;
        if (!userId || !isAdmin(userId)) return false;
    }

    // 被回复的消息必须是媒体或**机器人发出的文本消息**（文本消息此前无法编辑）
    const repliedType = SUPPORTED_MEDIA_TYPES.find(t => reply[t]);
    const repliedIsText = !repliedType && !!reply.text;
    if (!repliedType && !repliedIsText) {
        const errMsg = await bot.sendMessage(chatId, '⚠️ 请回复一条媒体或文本消息再使用 /edit', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
        scheduleDelete(chatId, errMsg.message_id);
        scheduleDelete(chatId, msg.message_id);
        return true;
    }

    // 反查 media：先按被回复消息的位置（群组/频道位置）；
    // 找不到再看被回复的是不是频道转发副本 → 按转发来源定位频道源消息（改频道源消息会同步到群里）
    let mediaDoc = await findMediaByRepliedPosition(chatId, reply.message_id);
    if (!mediaDoc) {
        const origin = await resolveMessageOrigin(reply, bot);
        if (origin) {
            mediaDoc = await findMediaByPosition(origin.chatId, origin.messageId);
            if (mediaDoc) {
                logger.info(`群组快捷编辑：按转发来源定位到源消息 chat=${origin.chatId}/${origin.messageId} (via=${origin.via})`);
            }
        }
    }

    // 目标类型：库里有记录按记录判断（文本媒体 → 改 text）；
    // 库里没有但回复的是文本消息 → 也按文本编辑（只改 Telegram，数据库无可更新）
    let kind = null;
    if (mediaDoc) {
        kind = editTargetKind(mediaDoc);
    } else if (repliedIsText) {
        kind = 'text';
    }

    if (!kind) {
        const errMsg = await bot.sendMessage(chatId, '❌ 未在媒体库中找到该媒体', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
        scheduleDelete(chatId, errMsg.message_id);
        scheduleDelete(chatId, msg.message_id);
        return true;
    }

    // 编辑目标位置：频道源位置优先（频道 → 讨论群自动转发时改频道源消息，Telegram 自动同步到群里的副本），
    // 其次群组位置，最后顶层位置；改不了的位置会在编辑时自动降级到下一个。
    // 库外消息没有记录可推导位置 → 只能直接改被回复的那条。
    const editTargets = mediaDoc
        ? resolveEditTargets(mediaDoc)
        : [{ chatId, messageId: reply.message_id, via: 'reply' }];
    if (!editTargets.length) {
        const errMsg = await bot.sendMessage(chatId, '❌ 媒体位置数据异常，无法编辑', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
        scheduleDelete(chatId, errMsg.message_id);
        scheduleDelete(chatId, msg.message_id);
        return true;
    }

    // 提取 /edit 后的新描述（兼容 /edit@机器人用户名 形式），
    // 并按「正文在命令消息里的起始下标」把 entities 平移到正文上（严格保留管理员发送的格式）
    const { text: newText, start: newTextStart } = extractEditBody(msg.text);
    const entities = shiftEntities(msg.entities, newTextStart, newText.length);

    // 清空（/null）只对媒体描述有效：Telegram 不允许把文本消息改成空文本
    if (kind === 'text' && newText.trim() === 'null') {
        const errMsg = await bot.sendMessage(chatId, '❌ 文本消息无法清空（Telegram 不允许空文本），请直接发送新的文本内容', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
        scheduleDelete(chatId, errMsg.message_id);
        scheduleDelete(chatId, msg.message_id);
        return true;
    }

    if (newText) {
        // 一步直接修改（entities 已平移到正文上 → 严格保留管理员发来的格式）
        await applyReplyEdit(msg, {
            mediaDoc,
            editTargets,
            newText,
            promptMsgId: null,
            kind,
            entities
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
    const promptText = kind === 'text'
        ? '✏️ 请发送新的文本内容'
        : '✏️ 请发送新的描述（发送 /null 可清空描述）';
    const promptMsg = await bot.sendMessage(chatId, promptText, {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
    });
    setUserState(userId, {
        mode: 'edit',
        step: 'waiting_for_group_text',
        targetKind: kind,
        targetChatId: editTargets[0].chatId,
        targetMessageId: editTargets[0].messageId,
        editTargets,
        targetGroupId: mediaDoc ? mediaDoc.group_id : null,
        targetFileUniqueId: mediaDoc ? mediaDoc.file_unique_id : null,
        targetMediaType: mediaDoc ? mediaDoc.media_type : 'text',
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
    logger.info(`用户 ${userId} 群组快捷编辑进入两步等待: chatId=${chatId}, target=${editTargets[0].chatId}/${editTargets[0].messageId} (via=${editTargets[0].via}, kind=${kind})`);
    return true;
}

module.exports = { handleReplyEditCommand, applyReplyEdit, findMediaByRepliedPosition };
