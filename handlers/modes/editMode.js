// handlers/modes/editMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { findMediaByFileUniqueId, findMediaByPosition } = require('../../db/media');
const { syncGroupDeleteByText } = require('../../db/groupList');
const { logOperation } = require('../../utils/opLog');
const { deleteUserState, setUserState } = require('../../states');
const { extractMediaFromMessage } = require('../../media');
const { removeLevelSuffix } = require('../../utils/levelExtractor');
const { resolveMessageOrigin } = require('../../utils/messageLocator');
const { applyTextMediaEdit } = require('../../utils/textMediaEdit');
const { projectEntities } = require('../../utils/textEntities');
const {
    isEditTargetError,
    resolveEditTargets,
    editTargetKind,
    editContentWithFallback
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

/**
 * 定位成功后的统一收尾：记下目标位置与正文载体类型（caption / text），
 * 把"正在查找"提示改成"✅ 找到了"，等用户输入新正文
 * @param {Object} p
 *   - mediaDoc：媒体库记录（库外消息为 null）
 *   - targetKind：'caption'（媒体描述）/ 'text'（文本消息）/ 'auto'（库外，不知道载体）
 *   - processingMsgId：要改写成结果提示的消息
 *   - editTargets：显式候选位置（库外消息用；库里有记录时按记录推导）
 * @returns {Promise<boolean>}
 */
async function enterWaitingForText(userId, chatId, state, { mediaDoc, targetKind, processingMsgId, editTargets: givenTargets }) {
    const targetGroupId = mediaDoc ? mediaDoc.group_id : null;
    // 获取目标消息位置：媒体可能同时存在「频道源位置」与「群组位置」
    // （频道 → 讨论群自动转发时，两条都在库里；改频道源消息 Telegram 会自动同步到群里的副本）
    const editTargets = (Array.isArray(givenTargets) && givenTargets.length)
        ? givenTargets
        : (mediaDoc ? resolveEditTargets(mediaDoc, extractChatIdFromGroupId(targetGroupId)) : []);

    if (!editTargets.length) {
        logger.error(`消息缺少可编辑位置，无法编辑: group_id=${targetGroupId}`);
        if (processingMsgId) {
            await bot.editMessageText('❌ 媒体数据异常，无法编辑', {
                chat_id: chatId,
                message_id: processingMsgId
            }).catch(() => { });
        }
        deleteUserState(userId);
        return true;
    }

    // 保存目标信息（targetChatId/targetMessageId 取首选位置，用于日志与库记录）
    setUserState(userId, {
        ...state,
        step: 'waiting_for_text',
        targetKind,
        targetChatId: editTargets[0].chatId,
        targetMessageId: editTargets[0].messageId,
        editTargets,
        targetGroupId,
        targetFileUniqueId: mediaDoc ? mediaDoc.file_unique_id : null,
        targetMediaType: mediaDoc ? mediaDoc.media_type : null,
        processingMsgId,
        lastActivity: Date.now()
    });

    // 只有「媒体描述」能清空（/null）；文本消息与库外消息只给「退出」
    const canClear = targetKind === 'caption';
    let foundText = '✅ 找到了，请输入修改内容';
    if (targetKind === 'text') foundText = '✅ 找到了（文本消息），请输入新的文本内容';
    else if (targetKind === 'auto') foundText = '✅ 找到了（媒体库中无该消息记录，仅修改 Telegram），请输入新的文本内容';

    await bot.editMessageText(foundText, {
        chat_id: chatId,
        message_id: processingMsgId,
        reply_markup: {
            inline_keyboard: [canClear
                ? [
                    { text: '🗑 清空描述', callback_data: 'edit_clear' },
                    { text: '🚪 退出', callback_data: 'edit_exit' }
                ]
                : [{ text: '🚪 退出', callback_data: 'edit_exit' }]]
        }
    });

    logger.info(`用户 ${userId} 进入编辑模式第二步，待编辑消息: ${editTargets[0].chatId}/${editTargets[0].messageId} (via=${editTargets[0].via}, kind=${targetKind})`);
    return true;
}

/**
 * 用「消息链接 / 含转发源的消息」定位目标（私聊里不必重新发送媒体）：
 * 库里能找到记录 → 按记录判定正文载体（媒体 caption / 文本 text）；
 * 库里没有 → 'auto'（先按 caption 试、Telegram 报没有 caption 再按文本试），只改 Telegram
 * @returns {Promise<boolean>} 是否已处理
 */
async function enterEditByLocatedMessage(userId, chatId, state, msg, origin) {
    let processingMsg = null;
    try {
        processingMsg = await bot.sendMessage(chatId, '🔍 正在查找消息...', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送查找中消息失败: ${err.message}`);
        return true;
    }

    const mediaDoc = await findMediaByPosition(origin.chatId, origin.messageId);
    logger.info(`用户 ${userId} 通过 ${origin.via} 定位消息: chat=${origin.chatId}/${origin.messageId}, 库中${mediaDoc ? '有' : '无'}记录`);

    if (mediaDoc) {
        return await enterWaitingForText(userId, chatId, state, {
            mediaDoc,
            targetKind: editTargetKind(mediaDoc),
            processingMsgId: processingMsg.message_id
        });
    }

    return await enterWaitingForText(userId, chatId, state, {
        mediaDoc: null,
        targetKind: 'auto',
        processingMsgId: processingMsg.message_id,
        editTargets: [{ chatId: origin.chatId, messageId: origin.messageId, via: origin.via }]
    });
}

async function handleEditMode(msg, state) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const messageText = msg.text;

    // 步骤1：等待用户发送媒体（或消息链接 / 含转发源的消息）
    if (state.step === 'waiting_for_media') {
        const mediaInfo = extractMediaFromMessage(msg);

        // 1a) 不是媒体：可能是「消息链接」或「含转发源的消息」（含机器人发出的文本消息）→ 直接定位
        if (!mediaInfo) {
            const origin = await resolveMessageOrigin(msg, bot);
            if (origin) {
                return await enterEditByLocatedMessage(userId, chatId, state, msg, origin);
            }
            await bot.sendMessage(chatId, '❌ 请发送媒体消息（图片、视频、音频或文档），或发送该消息的链接 / 转发该消息', {
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

        return await enterWaitingForText(userId, chatId, state, {
            mediaDoc,
            targetKind: editTargetKind(mediaDoc),
            processingMsgId: processingMsg.message_id
        });
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
        // 正文载体：'text' 文本消息（media_type='text'，改的是消息 text）/ 'caption' 媒体描述 /
        // 'auto' 库外消息（消息链接、转发来源定位，媒体库里没有记录，只能直接改 Telegram）
        const kind = (state.targetKind === 'text' || state.targetKind === 'auto') ? state.targetKind : 'caption';
        const hasRecord = !!targetFileUniqueId;
        // 严格保留用户发送的格式：把这条消息的 entities 带上（落库用 cleanText，偏移量各平移一次）
        const msgEntities = msg.entities;
        const dbEntities = projectEntities(msgEntities, msg.text, cleanText);

        // 文本消息不能清空：Telegram 不允许把文本消息改成空文本（保持状态，等用户重新输入）
        if (kind === 'text' && isClearing) {
            await bot.sendMessage(chatId, '❌ 文本消息无法清空（Telegram 不允许空文本），请直接发送新的文本内容', {
                reply_to_message_id: messageId
            });
            return true;
        }

        try {
            // 1) 先编辑 Telegram 正文：文本消息改 text、媒体改 caption
            //    （可能会因超时 / 位置不是机器人发的而失败）
            const edited = await editContentWithFallback(bot, editTargets, kind, isClearing ? '' : messageText, msgEntities);

            // 2) 库外消息（消息链接 / 转发来源定位，媒体库里没有记录）：只改 Telegram，数据库无可更新
            if (!hasRecord) {
                await bot.sendMessage(chatId, '✅ 修改完毕（媒体库中无该消息记录，仅修改了 Telegram 消息）', {
                    reply_to_message_id: messageId
                });
                deleteUserState(userId);
                logOperation({
                    action: 'media_edit',
                    source: 'private',
                    userId,
                    chatId,
                    messageId,
                    target: { type: 'media', id: 'unknown' },
                    counts: { edits: 1 },
                    detail: {
                        via: 'private_located_edit',
                        kind,
                        targetChatId: edited.chatId,
                        targetMessageId: edited.messageId,
                        editVia: edited.via,
                        after: cleanText,
                        noRecord: true
                    }
                }).catch(() => { });
                logger.info(`用户 ${userId} 编辑库外消息 ${edited.chatId}/${edited.messageId} (via=${edited.via}, kind=${kind})`);
                return true;
            }

            // 3) 文本消息（media_type='text'）：正文存在 media.media_name（顺带同步可能存在的 message 记录）
            if (kind === 'text') {
                await applyTextMediaEdit(targetFileUniqueId, cleanText, dbEntities);
                await bot.sendMessage(chatId, '✅ 修改完毕', {
                    reply_to_message_id: messageId
                });
                deleteUserState(userId);
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
                        kind: 'text',
                        mediaType: targetMediaType,
                        groupId: targetGroupId,
                        targetChatId: edited.chatId,
                        targetMessageId: edited.messageId,
                        editVia: edited.via,
                        after: cleanText
                    }
                }).catch(() => { });
                logger.info(`用户 ${userId} 成功编辑文本消息 ${edited.chatId}/${edited.messageId} (via=${edited.via})`);
                return true;
            }

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

            // 编辑成功 → 自动进入打标签会话（标签按 message 独立，只写这一条；已有标签保留）
            // 打标签不切换 / 不退出编辑模式（见 utils/tagSession.js）
            if (!isClearing && cleanText && targetGroupId) {
                const { addTagToMessage, getMessageTags } = require('../../db/message');
                const { getTags, tagUsed } = require('../../db/tags');
                const { matchTagsInText } = require('../../utils/tagUi');
                const { syncGroupTags } = require('../../db/groupList');

                // 编辑描述：保留已有标签，只补充新文本里匹配到且尚未打上的
                const allTags = await getTags();
                const matched = matchTagsInText(cleanText, allTags);
                const prevTags = await getMessageTags(targetFileUniqueId);
                const autoAdded = matched.filter(t => !prevTags.includes(t));
                for (const tag of autoAdded) {
                    await addTagToMessage(targetFileUniqueId, tag);
                    await tagUsed(tag, 1);
                }
                if (autoAdded.length) await syncGroupTags(targetGroupId);
                if (autoAdded.length) {
                    logOperation({
                        action: 'tag_add',
                        source: 'private',
                        userId,
                        target: { type: 'media', id: targetFileUniqueId },
                        counts: { tags: autoAdded.length, messages: 1 },
                        detail: { tags: autoAdded, auto: true, matchedFrom: cleanText.slice(0, 60) }
                    }).catch(() => { });
                }

                // 进入打标签队列（队列里已有目标时排在其后，点《完成》后依次切换）
                const { enqueueTagTarget } = require('../../utils/tagSession');
                const res = await enqueueTagTarget(userId, {
                    groupId: targetGroupId,
                    fileUniqueId: targetFileUniqueId,
                    baseText: '✅ 修改完毕（可为此媒体打标签）'
                });
                if (!res.active && res.queued) {
                    await bot.sendMessage(chatId, '✅ 修改完毕\n🏷️ 已加入打标签队列', {
                        reply_to_message_id: messageId,
                        allow_sending_without_reply: true
                    }).catch(() => { });
                }
                // 编辑完成后退出编辑模式（打标签会话独立存在，不受模式清理影响）
                deleteUserState(userId);
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
                    kind: 'caption',
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
            const what = kind === 'text' ? '文本' : '描述';

            if (isEditDenied && !hasRecord) {
                // 库外消息又改不了：不是机器人发的 / 只是频道转发的副本（Telegram 只允许改机器人自己的消息）
                logger.warn(`编辑库外消息失败: ${err.message}`);
                logOperation({
                    action: 'media_edit',
                    result: 'fail',
                    source: 'private',
                    userId,
                    chatId,
                    messageId,
                    target: { type: 'media', id: 'unknown' },
                    detail: { via: 'private_located_edit', kind, over48h: false, noRecord: true },
                    error: err.message
                }).catch(() => { });
                await bot.sendMessage(chatId, '❌ 无法修改该消息（不是机器人发送的，或只是频道转发的副本）；请在原群组/频道里修改它', {
                    reply_to_message_id: messageId
                });
                deleteUserState(userId);
            } else if (isEditDenied) {
                // 保存待执行的数据操作到状态，询问用户
                setUserState(userId, {
                    ...state,
                    step: 'confirm_db_only',
                    pendingEdit: { isClearing, cleanText, entities: dbEntities },
                    lastActivity: Date.now()
                });

                const keyboard = {
                    inline_keyboard: [[
                        { text: '✅ 仅更新数据库', callback_data: `edit_dbonly:${targetGroupId}` },
                        { text: '❌ 取消', callback_data: `edit_dbonly_cancel` }
                    ]]
                };

                await bot.editMessageText(
                    `⚠️ 消息已超过编辑时效（48小时），无法修改 Telegram 上的${what}。\n是否只更改数据库中的${what}？`,
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
                    target: { type: 'media', id: targetFileUniqueId || 'unknown' },
                    detail: { via: 'private_edit', kind, over48h: !!isEditDenied, mediaType: targetMediaType },
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
        // 正文载体：'text' 文本消息（改消息 text）/ 'caption' 媒体描述 / 'auto' 库外消息
        const kind = (state.targetKind === 'text' || state.targetKind === 'auto') ? state.targetKind : 'caption';
        const hasRecord = !!targetFileUniqueId;
        // 严格保留管理员发送的格式：把这条文本消息的 entities 带上（落库用 cleanText，偏移量各平移一次）
        const msgEntities = msg.entities;
        const dbEntities = projectEntities(msgEntities, msg.text, cleanText);
        const { scheduleDelete } = require('../groupMessageHandlers');
        const { reMatchMessageTags, clearMessageTags } = require('../../utils/tagSync');

        const updateDbAndTags = async (target) => {
            if (!hasRecord) return false; // 库外消息：只改 Telegram，数据库无可更新
            // 文本消息：正文在 media.media_name（顺带同步可能存在的 message 记录）
            if (kind === 'text') {
                await applyTextMediaEdit(targetFileUniqueId, cleanText, dbEntities);
                return true;
            }
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
            return true;
        };

        const scheduleAllCleanup = (extraMsgId) => {
            if (extraMsgId) scheduleDelete(notifyChat, extraMsgId);
            if (groupCmdMsgId) scheduleDelete(notifyChat, groupCmdMsgId); // 管理员的 /edit 命令消息
            if (groupPromptMsgId) scheduleDelete(notifyChat, groupPromptMsgId);
            scheduleDelete(notifyChat, messageId); // 管理员输入的这条文本
        };

        // 文本消息不能清空：Telegram 不允许把文本消息改成空文本（保持状态，等管理员重新输入）
        if (kind === 'text' && isClearing) {
            const errMsg = await bot.sendMessage(notifyChat, '❌ 文本消息无法清空（Telegram 不允许空文本），请直接发送新的文本内容', {
                reply_to_message_id: messageId,
                allow_sending_without_reply: true
            });
            scheduleAllCleanup(errMsg.message_id);
            return true;
        }

        try {
            // 1) 先编辑 Telegram 正文：文本消息改 text、媒体改 caption
            //    （HTML 解析失败降级纯文本；位置不可用则换另一个位置）
            const edited = await editContentWithFallback(bot, editTargets, kind, isClearing ? '' : messageText, msgEntities);

            await updateDbAndTags(edited);

            const okText = isClearing
                ? '✅ 已清空描述'
                : (hasRecord ? '✅ 修改完毕' : '✅ 修改完毕（媒体库中无该消息记录，仅修改了 Telegram 消息）');
            const okMsg = await bot.sendMessage(notifyChat, okText, {
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
                target: { type: 'media', id: targetFileUniqueId || 'unknown' },
                counts: { edits: 1 },
                detail: {
                    via: 'group_two_step',
                    kind,
                    groupId: targetGroupId,
                    targetChatId: edited.chatId,
                    targetMessageId: edited.messageId,
                    editVia: edited.via,
                    mediaType: targetMediaType,
                    clearing: isClearing,
                    after: cleanText || undefined
                }
            }).catch(() => { });
            logger.info(`用户 ${userId} 群组快捷编辑两步完成: ${edited.chatId}/${edited.messageId} (via=${edited.via}, kind=${kind})`);
        } catch (err) {
            const isEditDenied = isEditTargetError(err);
            const what = kind === 'text' ? '文本' : '描述';

            if (isEditDenied && !hasRecord) {
                // 库外消息又改不了：不是机器人发的 / 只是频道转发的副本
                logger.warn(`群组快捷编辑两步失败（库外消息不可编辑）: ${err.message}`);
                logOperation({
                    action: 'media_edit',
                    source: 'group',
                    result: 'fail',
                    userId,
                    chatId: notifyChat,
                    target: { type: 'media', id: 'unknown' },
                    detail: { via: 'group_two_step', kind, over48h: false, noRecord: true },
                    error: err.message
                }).catch(() => { });
                const failMsg = await bot.sendMessage(
                    notifyChat,
                    '❌ 无法修改该消息（不是机器人发送的，或只是频道转发的副本）；请在原频道/群组里回复它再试',
                    { reply_to_message_id: messageId, allow_sending_without_reply: true }
                );
                scheduleAllCleanup(failMsg.message_id);
                deleteUserState(userId);
            } else if (isEditDenied) {
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
                            kind,
                            groupId: targetGroupId,
                            over48h: true,
                            clearing: isClearing,
                            after: cleanText || undefined
                        }
                    }).catch(() => { });
                    const warnMsg = await bot.sendMessage(notifyChat, `⚠️ 消息已超过编辑时效（48小时），已仅更新数据库中的${what}`, {
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