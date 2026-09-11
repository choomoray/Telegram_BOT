// handlers/modes/messageReplyMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const {
    findMediaByFileUniqueId,
    insertMedia,
    getMaxSubgroup,
    buildMediaLocation
} = require('../../db/media');
const { upsertGroupList, syncGroupDeleteByText } = require('../../db/groupList');
const { recordAndTag } = require('../../utils/tagSession');
const { extractMediaFromMessage, sendMediaAsReply, sendMediaGroupAsReply } = require('../../media');
const { logOperation } = require('../../utils/opLog');
const { setUserState, deleteUserState, updateUserActivity, getRawUserState } = require('../../states');

// ---------- 图标常量（与选择按钮/群组列表保持一致） ----------
const CHANNEL_ICON = '📢';
const GROUP_ICON = '👥';

function targetDisplay(target) {
    return target === 'channel'
        ? { icon: CHANNEL_ICON, label: '频道' }
        : { icon: GROUP_ICON, label: '群组' };
}

/**
 * 由 message 记录一次性解析"群组/频道"双位置（频道转发消息时两者都有，否则为 null）
 *
 * 位置来源有两处，必须都看：
 *   1. `message.channel_forward`（频道转发收录时写入的双位置）；
 *   2. `media.group` / `media.channel` 子文档（媒体自己的双位置）。
 * 只看 1 会导致大量媒体无法选择回复位置——例如空描述媒体没有 message 记录、
 * 或 message 记录里 channel_forward 不完整（channel_message_id 为 null），
 * 此时 media 里其实两个位置都齐全，却会退化成"只能回复到频道"。
 *
 * @param {Object} messageDoc - message 记录
 * @param {Object} [mediaDoc] - 同一媒体的 media 记录（可选，用于补全位置）
 * @returns {{ group: {chatId:number,messageId:number}|null, channel: {chatId:number,messageId:number}|null, isForwarded: boolean }}
 */
function deriveReplyLocations(messageDoc, mediaDoc) {
    const fwd = (messageDoc && messageDoc.channel_forward) || null;
    const isChannelForward = !!(fwd && fwd.is_channel);
    const has = (chatId, messageId) => !!(chatId && messageId);

    // ---- 群组位置：channel_forward.group_* 优先，缺失时用 media.group ----
    let group = (isChannelForward && has(fwd.group_chat_id, fwd.group_message_id))
        ? { chatId: fwd.group_chat_id, messageId: fwd.group_message_id }
        : null;
    if (!group && mediaDoc && mediaDoc.group && has(mediaDoc.group.chat_id, mediaDoc.group.message_id)) {
        group = { chatId: mediaDoc.group.chat_id, messageId: mediaDoc.group.message_id };
    }

    // ---- 频道位置：channel_forward.channel_* 优先，缺失时用 media.channel ----
    // 频道源位置还可能是 message 自身的 chat_id/message_id（频道侧收录时就是这样存的），
    // 因此最后再兜底一次：消息自身所在聊天 === 转发来源频道 时，它就是频道位置。
    let channel = (isChannelForward && has(fwd.channel_chat_id, fwd.channel_message_id))
        ? { chatId: fwd.channel_chat_id, messageId: fwd.channel_message_id }
        : null;
    if (!channel && mediaDoc && mediaDoc.channel && has(mediaDoc.channel.chat_id, mediaDoc.channel.message_id)) {
        channel = { chatId: mediaDoc.channel.chat_id, messageId: mediaDoc.channel.message_id };
    }
    if (!channel && isChannelForward && messageDoc && has(messageDoc.chat_id, messageDoc.message_id)
        && messageDoc.chat_id === fwd.channel_chat_id) {
        channel = { chatId: messageDoc.chat_id, messageId: messageDoc.message_id };
    }

    // 双位置都存在且**不是同一个位置**才算"真的有群组/频道两个可选位置"
    // （media 里 group 与 channel 偶尔会指向同一个聊天，那是数据问题，不能拿它当转发证据）
    const distinct = !!(group && channel && (group.chatId !== channel.chatId || group.messageId !== channel.messageId));
    const isForwarded = isChannelForward || distinct;
    return { group, channel, isForwarded };
}

/**
 * 取媒体记录（用于补全回复位置）。传入了就直接用，否则按 file_unique_id 查一次。
 * @param {Object|null} mediaDoc
 * @param {string|null} fileUniqueId
 */
async function loadMediaForLocations(mediaDoc, fileUniqueId) {
    if (mediaDoc) return mediaDoc;
    if (!fileUniqueId) return null;
    try {
        return await findMediaByFileUniqueId(fileUniqueId);
    } catch (err) {
        logger.warn(`查询媒体位置失败: file_unique_id=${fileUniqueId}, ${err.message}`);
        return null;
    }
}

/**
 * 目标媒体的"可回复位置"解析：优先用 message 记录；没有 message 记录
 * （空描述媒体——组内绝大多数媒体都没有 message）时，用 media 自身的双位置合成一个
 * 最小 messageDoc，保证"回复在群组 / 回复在频道"的选择仍然可用。
 *
 * 合成 doc 的 chat_id/message_id 取「群组位置优先，否则频道位置」，作为未选位置时的默认值
 * （与"默认回复在群组"一致）。
 *
 * @param {Object|null} messageDoc - message 记录
 * @param {Object|null} mediaDoc - media 记录
 * @returns {{messageDoc: Object|null, mediaDoc: Object|null}} 两者都为 null 表示无法定位
 */
function buildReplyTargetDoc(messageDoc, mediaDoc) {
    if (messageDoc) return { messageDoc, mediaDoc };
    if (!mediaDoc) return { messageDoc: null, mediaDoc: null };

    const locations = deriveReplyLocations(null, mediaDoc);
    const primary = locations.group || locations.channel;
    if (!primary) return { messageDoc: null, mediaDoc };
    return {
        messageDoc: {
            group_id: mediaDoc.group_id,
            file_unique_id: mediaDoc.file_unique_id,
            media_type: mediaDoc.media_type,
            chat_id: primary.chatId,
            message_id: primary.messageId
        },
        mediaDoc
    };
}

/**
 * 就绪状态下的"更改回复位置"按钮：仅当群组/频道双位置都存在（频道转发消息）时提供。
 * 按钮始终指向当前选择的反方向：选了群组 → "更改为发送至📢频道"，选了频道 → "更改为发送至👥群组"
 * @param {Object} locations - deriveReplyLocations 的返回值
 * @param {string} currentTarget - 当前回复位置（'group' | 'channel'）
 */
function buildReadySwitchKeyboard(locations, currentTarget) {
    if (!locations || !locations.group || !locations.channel) return undefined;
    const switchTarget = currentTarget === 'channel' ? 'group' : 'channel';
    const { icon, label } = targetDisplay(switchTarget);
    return {
        inline_keyboard: [[
            { text: `🔄 更改为发送至${icon} ${label}`, callback_data: `mreply_switch:${switchTarget}` }
        ]]
    };
}

/**
 * 解析目标聊天类型（channel/group），用于非转发消息回退时正确显示图标
 */
async function resolveChatType(chatId) {
    const { getChannelGroupById } = require('../../db/channelGroup');
    const info = await getChannelGroupById(chatId);
    return (info && info.type) || 'group';
}

// ---------- 用户隔离上下文 ----------
const userContexts = new Map();

// 打包模式（/message_reply N）：余量不再自动冲刷——满 N 个立即回复一组，
// 不足 N 的余量一直留在缓冲中等后续媒体补满下一组，只有退出（/exit 或超时）时才冲刷发出

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
            targetQueryMsgIds: new Map(),
            packBuffer: { items: [], timer: null } // 打包模式缓冲：{ items, timer }
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
        if (ctx.packBuffer) {
            clearTimeout(ctx.packBuffer.timer);
        }
        userContexts.delete(userId);
    }
}

// 供外部调用的获取上下文方法（用于超时清理）
function getMessageReplyContext(userId) {
    return userContexts.get(userId);
}

/**
 * 构造消息回复模式的退出清理函数（/exit、超时退出、自动进入等路径共用）：
 * 打包模式冲刷剩余媒体 → 删除群组/频道提示消息 → 清理用户上下文
 */
function buildReplyModeExitHandler() {
    return async (uid) => {
        // 打包模式：退出前冲刷剩余媒体
        await flushPackOnExit(uid);
        // 清理上下文和可能的群组提示消息
        const rawState = require('../../states').getRawUserState(uid);
        if (rawState && rawState.hintMsgInfo) {
            try {
                await bot.deleteMessage(rawState.hintMsgInfo.chat_id, rawState.hintMsgInfo.message_id);
            } catch (err) {
                logger.warn(`退出时删除群组提示消息失败: ${err.message}`);
            }
        }
        clearUserContext(uid);
    };
}

async function exitMessageReplyMode(userId, sendExitMessage = true) {
    const rawState = getRawUserState(userId);
    if (rawState && rawState.mode === 'message_reply') {
        // 打包模式（/message_reply N）：退出前冲刷剩余未打包的媒体
        await flushPackOnExit(userId);

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

/**
 * 收到关闭信号时：删除所有消息回复模式遗留的群组/频道提示消息
 * （"💬 正在回复该消息"），避免进程退出后残留
 */
async function cleanupHintMessagesOnShutdown() {
    const { userStates } = require('../../states');
    for (const [userId, state] of userStates.entries()) {
        if (state && state.mode === 'message_reply' && state.hintMsgInfo) {
            try {
                await bot.deleteMessage(state.hintMsgInfo.chat_id, state.hintMsgInfo.message_id);
                logger.info(`关闭清理: 删除用户 ${userId} 的回复提示消息 (chatId=${state.hintMsgInfo.chat_id})`);
            } catch (err) {
                logger.warn(`关闭清理: 删除回复提示消息失败 (用户 ${userId}): ${err.message}`);
            }
        }
    }
}

/**
 * 解析回复位置：
 * - 频道转发消息（message.channel_forward 或 media 双位置）：
 *   - replyTarget='group'   → 群组中该消息的位置
 *   - replyTarget='channel' → 频道源消息位置
 *   - replyTarget=null      → **默认回复在群组**（群组是默认回复位置；
 *     两个位置都存在时，调用方会先弹出"回复在群组/频道"按钮让用户确认，
 *     这里只作为"未询问时"的默认值，避免默认落到频道）
 * - 非转发消息：一律使用消息自身位置（chat_id/message_id）
 * @param {Object} messageDoc - message 记录
 * @param {string|null} replyTarget - 'group' | 'channel' | null
 * @param {Object} [locations] - 已解析好的 deriveReplyLocations 结果（不传则按 messageDoc 现算）
 */
function resolveReplyLocation(messageDoc, replyTarget, locations) {
    const loc = locations || deriveReplyLocations(messageDoc);
    if (loc.isForwarded || loc.group || loc.channel) {
        if (replyTarget === 'group' && loc.group) {
            return { chatId: loc.group.chatId, messageId: loc.group.messageId, isForwarded: true };
        }
        if (replyTarget === 'channel' && loc.channel) {
            return { chatId: loc.channel.chatId, messageId: loc.channel.messageId, isForwarded: true };
        }
        // 未指定回复位置：默认群组（群组位置缺失时才用频道位置）
        if (loc.group) {
            return { chatId: loc.group.chatId, messageId: loc.group.messageId, isForwarded: true };
        }
        if (loc.channel) {
            return { chatId: loc.channel.chatId, messageId: loc.channel.messageId, isForwarded: true };
        }
    }
    return { chatId: messageDoc.chat_id, messageId: messageDoc.message_id, isForwarded: false };
}

/** 发送群组提示消息并进入就绪状态（使用已解析的回复位置） */
async function finishEnterReadyState(userId, messageDoc, processingMsgId, resolved, mediaDoc = null) {
    const targetGroupId = messageDoc.group_id;
    const locations = deriveReplyLocations(messageDoc, mediaDoc);

    // 确定当前目标类型（用于显示图标）：优先按双位置匹配，非转发回退按实际聊天类型
    let target;
    if (locations.channel && resolved.chatId === locations.channel.chatId && resolved.messageId === locations.channel.messageId) {
        target = 'channel';
    } else if (locations.group && resolved.chatId === locations.group.chatId && resolved.messageId === locations.group.messageId) {
        target = 'group';
    } else {
        target = await resolveChatType(resolved.chatId);
    }
    const { icon, label } = targetDisplay(target);
    const readyText = `✅ 已选择回复在${icon} ${label}，现在可以向我发送消息了`;

    let hintMsg;
    try {
        hintMsg = await bot.sendMessage(resolved.chatId, '💬 Der包正在回复该消息', {
            reply_to_message_id: resolved.messageId
        });
    } catch (err) {
        logger.warn(`发送群组提示消息失败: ${err.message}`);
        hintMsg = null;
    }

    await bot.editMessageText(readyText, {
        chat_id: userId,
        message_id: processingMsgId,
        reply_markup: buildReadySwitchKeyboard(locations, target)
    });

    // 保留 _onExit（退出时删除群组/频道提示消息、清理上下文）
    const prevRaw = getRawUserState(userId);
    setUserState(userId, {
        mode: 'message_reply',
        step: 'ready',
        targetGroupId,
        targetChatId: resolved.chatId,
        targetMessageId: resolved.messageId,
        hintMsgInfo: hintMsg ? { chat_id: resolved.chatId, message_id: hintMsg.message_id } : null,
        replyLocations: locations,          // 供"发送至群组/频道"切换按钮使用
        readyMsgId: processingMsgId,        // 就绪确认消息（回复成功后移除切换按钮）
        readyText,                          // 就绪确认消息文本
        packSize: (prevRaw && prevRaw.packSize) || null, // 保留打包模式数量
        _onExit: (prevRaw && prevRaw._onExit) || (async () => { }),
        lastActivity: Date.now()
    });

    logger.info(`用户 ${userId} 消息回复模式已找到目标，进入就绪状态`);
}

/**
 * 目标消息定位后的统一处理：
 * - 频道转发媒体（能解析出双位置）且未指定回复位置 → 询问"回复在群组/频道"
 * - 其余情况 → 解析位置后直接进入就绪状态
 * @param {Object} messageDoc - message 记录
 * @param {string|null} replyTarget - 指令指定的回复位置（'group'/'channel'/null=询问）
 * @param {Object} [mediaDoc] - 同一媒体的 media 记录（补全位置，可省）
 */
async function enterReplyReadyState(userId, messageDoc, processingMsgId, replyTarget, mediaDoc = null) {
    const media = mediaDoc || await loadMediaForLocations(null, messageDoc && messageDoc.file_unique_id);
    const locations = deriveReplyLocations(messageDoc, media);

    // 只有**真正的频道转发媒体**才询问"回复在群组/频道"（默认群组）：
    //   - isForwarded=true：message.channel_forward 或 media 里存在两个不同位置；
    //   - 普通群组媒体（media 只有 group）不弹按钮，直接回复在消息自身位置。
    if (locations.isForwarded && !replyTarget) {
        const rows = [];
        if (locations.group) rows.push({ text: '👥 回复在群组', callback_data: 'mreply_loc:group' });
        if (locations.channel) rows.push({ text: '📢 回复在频道', callback_data: 'mreply_loc:channel' });

        if (rows.length > 0) {
            const keyboard = { inline_keyboard: [rows] };
            await bot.editMessageText('✅ 已找到该消息（频道转发）\n请选择回复位置：', {
                chat_id: userId,
                message_id: processingMsgId,
                reply_markup: keyboard
            });

            // 保留 _onExit（退出时删除群组/频道提示消息、清理上下文）
            const prevRaw = getRawUserState(userId);
            setUserState(userId, {
                mode: 'message_reply',
                step: 'waiting_reply_location',
                targetGroupId: messageDoc.group_id,
                pendingMessageDoc: messageDoc,
                pendingMediaDoc: media || null,   // 位置解析用（频道侧收录 / 空描述媒体没有 message.channel_forward）
                processingMsgId,
                packSize: (prevRaw && prevRaw.packSize) || null, // 保留打包模式数量
                _onExit: (prevRaw && prevRaw._onExit) || (async () => { }),
                lastActivity: Date.now()
            });
            logger.info(`用户 ${userId} 消息回复模式：频道转发消息，等待选择回复位置（group=${!!locations.group}, channel=${!!locations.channel}）`);
            return;
        }
    }

    const resolved = resolveReplyLocation(messageDoc, replyTarget, locations);
    await finishEnterReadyState(userId, messageDoc, processingMsgId, resolved, media);
}

/**
 * 打标签完成后"回复该消息"：完成打标签后自动进入消息回复模式，
 * 回复目标优先为"刚打标签的那条 message"（file_unique_id），无则回退为该组第一条 message
 * （跳过用户重新发送媒体的定位步骤）。
 * 频道转发消息（有双位置）直接进入"选择回复至频道/群组"界面，其余直接进入就绪状态。
 * @param {number} userId - 用户ID
 * @param {string} groupId - 打标签的媒体组 ID
 * @param {number} baseMsgId - 当前标签消息 ID（将被编辑为回复模式界面）
 * @param {string|null} [fileUniqueId] - 刚打标签的 message 的 file_unique_id
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function autoEnterReplyFromTag(userId, groupId, baseMsgId, fileUniqueId = null) {
    try {
        // 打标签的媒体必然带文本（无文本不进入打标签流程），因此一定有 message 记录
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        let messageDoc = null;
        if (fileUniqueId) {
            messageDoc = await messageCol.findOne({ file_unique_id: fileUniqueId });
        }
        if (!messageDoc) {
            messageDoc = await messageCol.findOne({ group_id: groupId }, { sort: { message_id: 1 } });
        }
        if (!messageDoc) {
            return { ok: false, error: '❌ 未找到该媒体的消息记录，无法回复' };
        }

        // 建立 message_reply 状态（复用进入回复模式的退出清理逻辑）
        setUserState(userId, {
            mode: 'message_reply',
            lastActivity: Date.now(),
            step: 'waiting_for_target',
            replyTarget: null,      // null：频道转发消息时询问回复位置
            packSize: null,
            targetGroupId: null,
            targetChatId: null,
            targetMessageId: null,
            processingMsgId: null,
            hintMsgInfo: null,
            _onExit: buildReplyModeExitHandler()
        });

        // 直接定位目标：频道转发消息进入"选择回复至频道/群组"界面，其余直接进入就绪状态
        await enterReplyReadyState(userId, messageDoc, baseMsgId, null);
        logger.info(`用户 ${userId} 打标签后自动进入回复模式: group_id=${groupId}`);
        return { ok: true };
    } catch (err) {
        logger.error(`打标签后自动进入回复模式失败: ${err.message}`);
        return { ok: false, error: '❌ 进入回复模式失败，请重试' };
    }
}

/** 处理"回复在群组/频道"选择回调（mreply_loc:group | mreply_loc:channel） */
async function handleLocationCallback(query) {
    const data = query.data;
    const userId = query.from.id;
    const rawState = getRawUserState(userId);
    if (!rawState || rawState.mode !== 'message_reply' || rawState.step !== 'waiting_reply_location' || !rawState.pendingMessageDoc) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 状态已过期，请重新发送媒体' });
        return;
    }

    const target = (data.split(':')[1] === 'channel') ? 'channel' : 'group';
    const messageDoc = rawState.pendingMessageDoc;
    // 位置解析同样要带上 media（空描述媒体 / 频道侧收录时 message.channel_forward 不全）
    const media = await loadMediaForLocations(rawState.pendingMediaDoc, messageDoc.file_unique_id);
    const locations = deriveReplyLocations(messageDoc, media);
    const resolved = resolveReplyLocation(messageDoc, target, locations);
    if (!resolved || !resolved.chatId || !resolved.messageId) {
        await bot.answerCallbackQuery(query.id, { text: `❌ 没有可用的${target === 'channel' ? '频道' : '群组'}位置` });
        return;
    }
    const { icon, label } = targetDisplay(target);
    const readyText = `✅ 已选择回复在${icon} ${label}，现在可以向我发送消息了`;

    let hintMsg;
    try {
        hintMsg = await bot.sendMessage(resolved.chatId, '💬 Der包正在回复该消息', {
            reply_to_message_id: resolved.messageId
        });
    } catch (err) {
        logger.warn(`发送群组提示消息失败: ${err.message}`);
        hintMsg = null;
    }

    await bot.editMessageText(readyText, {
        chat_id: userId,
        message_id: query.message.message_id,
        reply_markup: buildReadySwitchKeyboard(locations, target)
    });

    // 保留 _onExit（退出时删除群组/频道提示消息、清理上下文）
    const prevRaw = getRawUserState(userId);
    setUserState(userId, {
        mode: 'message_reply',
        step: 'ready',
        // 把这次按钮选择落成状态里的"当前回复位置"（replyTarget + targetChatId），
        // 后续媒体沿用本次选择，需要换位置时点就绪消息上的「🔄 更改为发送至…」一键切换。
        // 注意：这**只发生在用户亲自点过按钮之后**——之前的状态里，replyTarget 会在
        // 定位阶段被旧的指令偏好提前填成 'channel'，导致既不弹按钮询问、默认也不是群组。
        replyTarget: target,
        targetGroupId: messageDoc.group_id,
        targetChatId: resolved.chatId,
        targetMessageId: resolved.messageId,
        hintMsgInfo: hintMsg ? { chat_id: resolved.chatId, message_id: hintMsg.message_id } : null,
        replyLocations: locations,          // 供"发送至群组/频道"切换按钮使用
        readyMsgId: query.message.message_id,
        readyText,
        packSize: (prevRaw && prevRaw.packSize) || null, // 保留打包模式数量
        _onExit: (prevRaw && prevRaw._onExit) || (async () => { }),
        lastActivity: Date.now()
    });

    await bot.answerCallbackQuery(query.id, { text: `已选择回复在${icon}${label}` });
    logger.info(`用户 ${userId} 选择回复位置: ${target}`);
}

/**
 * 处理就绪状态下的"发送至群组/频道"切换回调（mreply_switch:group | mreply_switch:channel）
 * 用于选错回复位置后随时更正：删除旧聊天提示 → 新聊天发提示 → 更新状态 → 刷新确认消息
 */
async function handleSwitchLocationCallback(query) {
    const data = query.data;
    const userId = query.from.id;
    const rawState = getRawUserState(userId);
    if (!rawState || rawState.mode !== 'message_reply' || rawState.step !== 'ready') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 状态已过期，请重新发送媒体' });
        return;
    }

    const target = (data.split(':')[1] === 'channel') ? 'channel' : 'group';
    const locations = rawState.replyLocations;
    const loc = locations && locations[target];
    if (!loc) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 该位置不存在' });
        return;
    }
    if (rawState.targetChatId === loc.chatId && rawState.targetMessageId === loc.messageId) {
        await bot.answerCallbackQuery(query.id, { text: '已是当前回复位置' });
        return;
    }

    // 删除旧聊天中的提示消息（💬 Der包正在回复该消息）
    if (rawState.hintMsgInfo) {
        try {
            await bot.deleteMessage(rawState.hintMsgInfo.chat_id, rawState.hintMsgInfo.message_id);
        } catch (err) {
            logger.warn(`切换位置时删除旧提示消息失败: ${err.message}`);
        }
    }

    // 在新聊天中发送提示消息
    let hintMsg = null;
    try {
        hintMsg = await bot.sendMessage(loc.chatId, '💬 Der包正在回复该消息', {
            reply_to_message_id: loc.messageId
        });
    } catch (err) {
        logger.warn(`切换位置时发送提示消息失败: ${err.message}`);
    }

    const { icon, label } = targetDisplay(target);
    const readyText = `✅ 已选择回复在${icon} ${label}，现在可以向我发送消息了`;
    // 保留 _onExit、replyLocations、readyMsgId 等既有字段
    const prevRaw = getRawUserState(userId);
    setUserState(userId, {
        ...prevRaw,
        targetChatId: loc.chatId,
        targetMessageId: loc.messageId,
        hintMsgInfo: hintMsg ? { chat_id: loc.chatId, message_id: hintMsg.message_id } : null,
        readyText,
        lastActivity: Date.now()
    });

    await bot.editMessageText(readyText, {
        chat_id: userId,
        message_id: query.message.message_id,
        reply_markup: buildReadySwitchKeyboard(locations, target)
    }).catch(() => { });

    await bot.answerCallbackQuery(query.id, { text: `已切换为回复在${icon}${label}` });
    logger.info(`用户 ${userId} 切换回复位置: ${target} -> chat=${loc.chatId}/${loc.messageId}`);
}

/**
 * 回复成功后移除就绪确认消息上的切换按钮
 * （回复并进入打标签流程后 mode 会变为 send，切换按钮将失效，先移除避免"点了没反应"；
 *   仅当就绪消息确实带切换按钮（双位置存在）时才编辑）
 */
async function removeReadySwitchButtons(userId) {
    const st = getRawUserState(userId);
    if (st && st.readyMsgId && st.replyLocations && st.replyLocations.group && st.replyLocations.channel) {
        await bot.editMessageText(st.readyText || '✅ 已选择回复位置', {
            chat_id: userId,
            message_id: st.readyMsgId
        }).catch(() => { });
    }
}

// ---------------- 打包模式（/message_reply N） ----------------

/**
 * 冲刷打包缓冲中的一组媒体为媒体组回复（不进入打标签流程，保持打包会话）
 */
async function flushPackGroup(userId, state, items, userMsgId) {
    await processMediaGroupReply(
        userId,
        state.targetChatId,
        state.targetMessageId,
        state.targetGroupId,
        items,
        userMsgId,
        { withTagging: false }
    );
}

/**
 * 打包模式收集：所有媒体（含相册成员）进入打包缓冲，
 * 满 packSize 立即作为媒体组回复；不足 packSize 的余量留在缓冲中等待补满下一组，
 * 仅在退出（/exit 或超时）时由 flushPackOnExit 冲刷余量
 */
async function handlePackMedia(userId, msg, mediaInfo, state, userMsgId) {
    const ctx = getContext(userId);
    const packSize = state.packSize;
    const buffer = ctx.packBuffer || (ctx.packBuffer = { items: [], timer: null });

    // 缓冲内去重：同一文件不重复收集（防止相册重复投递导致条目翻倍）
    if (buffer.items.some(it => it.fileUniqueId === mediaInfo.fileUniqueId)) {
        logger.info(`文件 ${mediaInfo.fileUniqueId} 已在打包缓冲中，忽略重复`);
        return;
    }
    buffer.items.push({ ...mediaInfo, message_id: msg.message_id });
    logger.info(`用户 ${userId} 打包模式收集媒体 ${buffer.items.length}/${packSize}`);

    // 满 packSize：立即冲刷一组；余量保留在缓冲中，等后续媒体补满下一组再冲刷，
    // 直到退出（/exit 或超时）时由 flushPackOnExit 把余量一次发出
    while (buffer.items.length >= packSize) {
        const chunk = buffer.items.splice(0, packSize);
        await flushPackGroup(userId, state, chunk, userMsgId);
        logger.info(`用户 ${userId} 打包模式已冲刷一组，缓冲剩余 ${buffer.items.length} 个媒体（等待补满下一组）`);
    }
}

/**
 * 退出消息回复模式前冲刷打包缓冲的剩余媒体（/exit、超时、模式内错误退出都会走到）
 */
async function flushPackOnExit(userId) {
    try {
        const rawState = getRawUserState(userId);
        if (!rawState || rawState.mode !== 'message_reply' || !rawState.packSize || rawState.packSize < 2) return;
        if (rawState.step !== 'ready' || !rawState.targetChatId) return;
        const ctx = getContext(userId);
        const buffer = ctx.packBuffer;
        if (!buffer || buffer.items.length === 0) return;
        clearTimeout(buffer.timer);
        buffer.timer = null;
        const items = buffer.items.splice(0);
        logger.info(`用户 ${userId} 退出消息回复模式，冲刷打包缓冲 ${items.length} 个媒体`);
        await flushPackGroup(userId, rawState, items, items[0].message_id);
    } catch (err) {
        logger.error(`退出时冲刷打包缓冲失败: ${err.message}`);
    }
}

// 注：回复成功后的 message 收录与标签统一由 utils/tagSession.recordAndTag 处理
// （recordReplyMessage 旧实现已合并，避免同一 message 写两次）

async function processSingleMediaReply(userId, targetChatId, targetMessageId, targetGroupId, mediaInfo, userMsgId) {
    const ctx = getContext(userId);
    const { fileUniqueId, type, fileId, caption, has_spoiler, videoTime } = mediaInfo;

    const existing = await findMediaByFileUniqueId(fileUniqueId);
    if (existing) {
        logger.info(`用户发送的媒体已存在 media 集合，跳过收录: file_unique_id=${fileUniqueId}`);
        logOperation({
            action: 'reply_fail',
            result: 'fail',
            source: 'private',
            userId,
            target: { type: 'media_group', id: targetGroupId },
            counts: { media: 1 },
            detail: { reason: 'duplicate', mediaType: type, fileName: fileUniqueId },
            error: '媒体已存在'
        }).catch(() => { });
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
        logOperation({
            action: 'reply_fail',
            result: 'fail',
            source: 'private',
            userId,
            target: { type: 'media_group', id: targetGroupId },
            counts: { media: 1 },
            detail: { mediaType: type, fileName: fileUniqueId, targetChatId, targetMessageId },
            error: err.message
        }).catch(() => { });
        await bot.sendMessage(userId, '❌ 回复媒体失败，请重试', {
            reply_to_message_id: userMsgId
        });
        return;
    }

    // 回复目标位置写入 media（目标为频道存 channel，为群组存 group）
    const location = await buildMediaLocation(targetChatId, sentMsg.message_id, null);

    await insertMedia({
        group_id: targetGroupId,
        subgroup: newSubgroup,
        file_id: fileId,
        file_unique_id: fileUniqueId,
        media_type: type,
        video_time: videoTime,
        thumb_file_id: mediaInfo.thumbFileId,
        ...location
    });

    // 先计数，再收录 message（有描述时），最后按组内文本状态统一重算 is_delete：
    // 无描述 → 时间戳（可被 /clean 清理）；有描述 → 0
    await upsertGroupList(targetGroupId);

    const countKey = `${targetGroupId}:${fileUniqueId}`;
    if (!ctx.countedMediaSet.has(countKey)) {
        ctx.countedMediaSet.add(countKey);
        logger.info(`用户发送的媒体已计入 group_list，并加入 Set: key=${countKey}`);
    }

    // 回复成功后移除就绪消息上的切换按钮（避免进入打标签流程后按钮失效）
    await removeReadySwitchButtons(userId);

    logOperation({
        action: 'reply_media',
        source: 'private',
        userId,
        chatId: targetChatId,
        messageId: sentMsg.message_id,
        target: { type: 'media_group', id: targetGroupId },
        counts: { media: 1, groups: 1, captions: caption ? 1 : 0 },
        detail: {
            mediaType: type,
            videoTime: videoTime || undefined,
            hasCaption: !!caption,
            targetChatType: (location && location.channel) ? 'channel' : 'group',
            replyToMessageId: targetMessageId,
            subgroup: newSubgroup,
            isMediaGroup: false
        }
    }).catch(() => { });

    // 收录 message（有描述时）并自动进入打标签会话（无描述媒体则不进入打标签，只提示已回复）。
    // 打标签**不退出回复模式**：用户可继续发送媒体继续回复；纯文本视为打标签，
    // 点《✅ 完成》才结束（见 utils/tagSession.js）。
    const successText = '✅ 已回复';
    const [shownInPanel] = await recordAndTag(userId, {
        groupId: targetGroupId,
        items: [{
            sentMsg,
            caption,
            fileUniqueId,
            type,
            successText
        }]
    });
    await syncGroupDeleteByText(targetGroupId);
    if (!shownInPanel) {
        await bot.sendMessage(userId, successText, {
            reply_to_message_id: userMsgId,
            allow_sending_without_reply: true
        }).catch(() => { });
    }

    logger.info(`用户 ${userId} 已回复媒体到群组 ${targetChatId}/${targetMessageId}，新 subgroup=${newSubgroup}`);
}

/**
 * 回复媒体组并收录
 * @param {number} userId - 用户ID
 * @param {number} targetChatId - 回复目标聊天
 * @param {number} targetMessageId - 回复目标消息
 * @param {string} targetGroupId - 目标媒体组
 * @param {Array} mediaItems - 媒体项
 * @param {number} userMsgId - 用户消息ID（用于回复提示）
 * @param {Object} [options] - { withTagging: boolean }
 *   withTagging=false：打包模式/退出冲刷使用——只回复并收录，不进入打标签流程
 *   （打标签会把 mode 改成 send/tagging，会打断打包会话）
 */
async function processMediaGroupReply(userId, targetChatId, targetMessageId, targetGroupId, mediaItems, userMsgId, options = {}) {
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
        logOperation({
            action: 'reply_fail',
            result: 'fail',
            source: 'private',
            userId,
            target: { type: 'media_group', id: targetGroupId },
            counts: { media: sortedItems.length },
            detail: { reason: 'duplicate', isMediaGroup: true },
            error: '所有媒体均已存在'
        }).catch(() => { });
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
        logOperation({
            action: 'reply_fail',
            result: 'fail',
            source: 'private',
            userId,
            target: { type: 'media_group', id: targetGroupId },
            counts: { media: newItems.length },
            detail: { isMediaGroup: true, mediaTypes: [...new Set(newItems.map(i => i.type))] },
            error: err.message
        }).catch(() => { });
        await bot.sendMessage(userId, '❌ 回复媒体组失败，请重试', {
            reply_to_message_id: userMsgId
        });
        return;
    }

    // 一次解析目标聊天类型，整组复用（避免每条媒体各查一次 channel_group）
    const chatType = await resolveChatType(targetChatId);

    // 并行落库：每条媒体独立插入（media + message），相比逐条串行 await 显著减少 DB 往返
    await Promise.all(sentMessages.map(async (sentMsg, i) => {
        const originalItem = newItems[i];
        if (!originalItem) return;

        // 回复目标位置写入 media（目标为频道存 channel，为群组存 group）
        const location = await buildMediaLocation(targetChatId, sentMsg.message_id, chatType);

        await insertMedia({
            group_id: targetGroupId,
            subgroup: newSubgroup,
            file_id: originalItem.fileId,
            file_unique_id: originalItem.fileUniqueId,
            media_type: originalItem.type,
            video_time: originalItem.videoTime,
            thumb_file_id: originalItem.thumbFileId,
            ...location
        });

        const countKey = `${targetGroupId}:${originalItem.fileUniqueId}`;
        if (!ctx.countedMediaSet.has(countKey)) {
            ctx.countedMediaSet.add(countKey);
        }
    }));

    // group_list 统一计数（一次 +N）＋按组内文本状态重算 is_delete
    await upsertGroupList(targetGroupId, newItems.length);

    logOperation({
        action: 'reply_media',
        source: 'private',
        userId,
        chatId: targetChatId,
        target: { type: 'media_group', id: targetGroupId },
        counts: {
            media: newItems.length,
            groups: 1,
            captions: newItems.filter(i => i.caption).length
        },
        detail: {
            isMediaGroup: true,
            mode: options.withTagging === false ? 'pack' : 'album',
            targetChatType: chatType === 'channel' ? 'channel' : 'group',
            replyToMessageId: targetMessageId,
            subgroup: newSubgroup,
            mediaTypes: [...new Set(newItems.map(i => i.type))],
            videoSeconds: newItems.reduce((sum, i) => sum + (i.videoTime || 0), 0) || undefined
        }
    }).catch(() => { });

    if (options.withTagging === false) {
        // 打包模式/退出冲刷：仅提示，不进入打标签流程（避免打断打包会话）
        await bot.sendMessage(userId, `✅ 已回复媒体组 (${newItems.length} 个)`, {
            reply_to_message_id: userMsgId,
            allow_sending_without_reply: true
        }).catch(() => { });
    } else {
        // 回复成功后移除就绪消息上的切换按钮（避免进入打标签流程后按钮失效）
        await removeReadySwitchButtons(userId);

        // 收录 message（有描述时）+ 自动进入打标签会话（不退出回复模式，用户可继续发送媒体）。
        // 每个带描述的媒体各打各的标签；当前标签没打完时后来的进入队列，点《完成》后依次切换。
        const successText = `✅ 已回复媒体组 (${newItems.length} 个)`;
        const items = sentMessages.map((sentMsg, i) => {
            const original = newItems[i];
            if (!original) return null;
            return {
                sentMsg,
                caption: original.caption,
                fileUniqueId: original.fileUniqueId,
                type: original.type,
                successText
            };
        }).filter(Boolean);
        const flags = await recordAndTag(userId, { groupId: targetGroupId, items });
        if (!flags.some(Boolean)) {
            await bot.sendMessage(userId, successText, {
                reply_to_message_id: userMsgId,
                allow_sending_without_reply: true
            }).catch(() => { });
        }
    }

    await syncGroupDeleteByText(targetGroupId);
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
        let targetMediaDoc = null;   // 同一媒体的 media 记录（补全回复位置用）
        for (const item of mediaItems) {
            logger.info(`检查媒体 file_unique_id=${item.fileUniqueId}`);
            const msgDoc = await messageCol.findOne({ file_unique_id: item.fileUniqueId });
            if (msgDoc) {
                logger.info(`找到匹配的消息: ${msgDoc.message_id}`);
                targetMessage = msgDoc;
                targetMediaDoc = await mediaCol.findOne({ file_unique_id: item.fileUniqueId });
                break;
            }
            // 没有 message 记录（空描述媒体）：用 media 双位置合成最小 doc 也能回复
            const mediaDoc = await mediaCol.findOne({ file_unique_id: item.fileUniqueId });
            if (mediaDoc) {
                const built = buildReplyTargetDoc(null, mediaDoc);
                if (built.messageDoc) {
                    logger.info(`在 media 集合中找到（无描述），按 media 双位置定位: ${mediaDoc.group_id}`);
                    targetMessage = built.messageDoc;
                    targetMediaDoc = mediaDoc;
                    break;
                }
                logger.info(`在 media 集合中找到，但没有可用位置，跳过`);
            } else {
                logger.info(`media 集合中也未找到`);
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

        // 读取用户指定的回复位置（/message_reply_group、/message_reply_channel），
        // 未指定时若为频道转发消息则**询问回复位置（默认群组）**
        const rawState = getRawUserState(userId);
        const replyTarget = rawState && rawState.replyTarget ? rawState.replyTarget : null;
        await enterReplyReadyState(userId, targetMessage, processingMsgId, replyTarget, targetMediaDoc);
        logger.info(`用户 ${userId} 消息回复模式已找到目标（媒体组）`);
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

    // 等待选择回复位置时，普通消息一律忽略（只能通过上方按钮选择）
    if (state.step === 'waiting_reply_location') {
        await bot.sendMessage(userId, '⚠️ 请先点击上方按钮选择回复位置', {
            reply_to_message_id: userMsgId
        }).catch(() => { });
        return true;
    }

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
                    await enterReplyReadyState(userId, targetMessage, processingMsg.message_id, state.replyTarget);
                    logger.info(`用户 ${userId} 消息回复模式立即找到目标`);
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
            const targetMessageRaw = await messageCol.findOne({ file_unique_id: fileUniqueId });
            const mediaDoc = await mediaCol.findOne({ file_unique_id: fileUniqueId });
            // 没有 message 记录（空描述媒体）也能回复：用 media 双位置合成最小 doc
            const { messageDoc: targetMessage, mediaDoc: targetMediaDoc } = buildReplyTargetDoc(targetMessageRaw, mediaDoc);
            if (!targetMessage) {
                await bot.editMessageText(
                    mediaDoc ? '❌ 该媒体没有可用的回复位置，无法回复' : '❌ 数据库中找不到该媒体',
                    { chat_id: userId, message_id: processingMsg.message_id }
                );
                await exitMessageReplyMode(userId, true);
                return true;
            }

            await enterReplyReadyState(userId, targetMessage, processingMsg.message_id, state.replyTarget, targetMediaDoc);

            logger.info(`用户 ${userId} 消息回复模式已找到目标`);
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

        // 打包模式（/message_reply N，N >= 2）：所有媒体进入打包缓冲，
        // 满 N 个立即作为媒体组回复；不足 N 的余量等待补满下一组，退出（/exit 或超时）时冲刷
        if (state.packSize && state.packSize >= 2) {
            await handlePackMedia(userId, msg, mediaInfo, state, userMsgId);
            updateUserActivity(userId);
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
module.exports.buildReplyModeExitHandler = buildReplyModeExitHandler;
module.exports.autoEnterReplyFromTag = autoEnterReplyFromTag;
module.exports.resolveReplyLocation = resolveReplyLocation;
module.exports.deriveReplyLocations = deriveReplyLocations;
module.exports.handleLocationCallback = handleLocationCallback;
module.exports.handleSwitchLocationCallback = handleSwitchLocationCallback;
module.exports.flushPackOnExit = flushPackOnExit;
module.exports.cleanupHintMessagesOnShutdown = cleanupHintMessagesOnShutdown;