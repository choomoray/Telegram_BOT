// handlers/modes/sendMode.js
/**
 * /send 发送模式
 * 1. 用户选择目标群组/频道（channel_group 列表，分页按钮）
 * 2. 用户发送消息/媒体/媒体组 → 发送到目标群组
 * 3. 发送成功后收录（media + message + group_list）并**自动进入打标签会话**：
 *    打标签不切换、不退出本模式（见 utils/tagSession.js），用户可继续发送媒体，
 *    纯文本视为打标签，点《✅ 完成》才结束
 */
const bot = require('../../bot');
const logger = require('../../logger');
const { getAllChannelGroups } = require('../../db/channelGroup');
const { logOperation } = require('../../utils/opLog');
const { findMediaByFileUniqueId, insertMedia, buildMediaLocation } = require('../../db/media');
const { upsertGroupList, syncGroupDeleteByText } = require('../../db/groupList');
const { recordAndTag, isTagging } = require('../../utils/tagSession');
const { extractMediaFromMessage, restoreMediaGroupCaptions, recordTextMedia, albumCaptionCarry, clearAlbumCaption } = require('../../media');
const { markInFlight, clearInFlight, isInFlight, sweepInFlight } = require('../../utils/inflight');
const { setUserState, updateUserActivity, getRawUserState } = require('../../states');

const PAGE_SIZE = 6;        // 每页群组按钮数
const GROUP_FLUSH_DELAY = 3000; // 媒体组收集窗口(ms)：最后一条消息后等待这么久才发送
                                // （Telegram 相册消息可能分多批投递，间隔可达 2 秒以上，窗口太短会丢媒体）

// 媒体组暂存：key=userId_mediaGroupId -> { items, timer, processingMsgId }
const pendingGroups = new Map();
// 同一用户的 flush 串行化：userId -> Promise，上一轮 flush 完全落库后下一轮才执行，
// 保证并发 flush 的去重查询能读到已提交数据
const userFlushChains = new Map();

// 定期清理 in-flight 登记的兜底 TTL（正常路径在 flush 结束时立即解除，见 utils/inflight.js）
setInterval(() => {
    sweepInFlight();
}, 60 * 1000);

// ---------------- 群组列表（分页） ----------------

async function showGroupList(userId, replyToMessageId, page) {
    const groups = await getAllChannelGroups();
    const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
    const current = Math.min(Math.max(1, page), totalPages);
    const slice = groups.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

    const keyboard = [];
    for (const g of slice) {
        const icon = g.type === 'channel' ? '📢' : '👥';
        keyboard.push([{
            text: `${icon} ${g.name || `Chat${g.id}`}`,
            callback_data: `sendg:${g.id}`
        }]);
    }
    // 翻页按钮
    if (totalPages > 1) {
        const navRow = [];
        if (current > 1) navRow.push({ text: '◀ 上一页', callback_data: `sendpage:${current - 1}` });
        navRow.push({ text: `${current} / ${totalPages}`, callback_data: `sendpage:${current}` });
        if (current < totalPages) navRow.push({ text: '下一页 ▶', callback_data: `sendpage:${current + 1}` });
        keyboard.push(navRow);
    }
    if (!groups.length) {
        keyboard.push([{ text: '❌ 暂无可用群组', callback_data: 'sendpage:1' }]);
    }

    const text = `📤 请选择要发送到的群组/频道（共 ${groups.length} 个）：`;
    if (replyToMessageId && replyToMessageId !== -1) {
        await bot.editMessageText(text, {
            chat_id: userId,
            message_id: replyToMessageId,
            reply_markup: { inline_keyboard: keyboard }
        }).catch(async () => {
            await bot.sendMessage(userId, text, { reply_markup: { inline_keyboard: keyboard } });
        });
    } else {
        await bot.sendMessage(userId, text, { reply_markup: { inline_keyboard: keyboard } });
    }
}

// ---------------- 回调处理 ----------------

async function handleCallback(query) {
    const data = query.data;
    const userId = query.from.id;
    const parts = data.split(':');
    const prefix = parts[0];

    if (prefix === 'sendpage') {
        const page = parseInt(parts[1], 10) || 1;
        await bot.answerCallbackQuery(query.id);
        await showGroupList(userId, query.message.message_id, page);
        return;
    }

    if (prefix === 'sendg') {
        const chatId = Number(parts[1]);
        const groups = await getAllChannelGroups();
        const group = groups.find(g => g.id === chatId);
        const name = group ? (group.name || `Chat${chatId}`) : `Chat${chatId}`;

        const rawState = getRawUserState(userId);
        const targetType = group ? (group.type === 'channel' ? 'channel' : 'group') : 'group';
        if (!rawState || rawState.mode !== 'send') {
            setUserState(userId, {
                mode: 'send',
                step: 'ready',
                targetChatId: chatId,
                targetName: name,
                targetType,
                pendingMediaGroup: null,
                lastActivity: Date.now(),
                _onExit: async () => { }
            });
        } else {
            setUserState(userId, {
                ...rawState,
                step: 'ready',
                targetChatId: chatId,
                targetName: name,
                targetType,
                lastActivity: Date.now()
            });
        }

        const icon = group ? (group.type === 'channel' ? '📢' : '👥') : '👥';
        await bot.editMessageText(`✅ 已选择：${icon} ${name}\n请发送要发送的消息（支持单个媒体或媒体组）：`, {
            chat_id: userId,
            message_id: query.message.message_id
        });
        await bot.answerCallbackQuery(query.id, { text: `已选择 ${name}` });
        logger.info(`用户 ${userId} 选择发送目标: ${chatId} (${name})`);
        return;
    }
}

// ---------------- 打标签（发送成功后的标签操作，实现在 utils/tagSession.js） ----------------
// 打标签会话与模式解耦：发送成功后自动进入，面板由 tagSession 维护，
// 用户可继续发送媒体（模式仍为 send），纯文本视为打标签，点《✅ 完成》才结束。

// ---------------- 发送与收录 ----------------

async function sendSingleMediaToChat(chatId, mediaInfo) {
    const { type, fileId, caption, has_spoiler } = mediaInfo;
    const opts = { caption: caption || undefined, parse_mode: 'HTML', has_spoiler: has_spoiler || false };
    switch (type) {
        case 'photo': return await bot.sendPhoto(chatId, fileId, opts);
        case 'video': return await bot.sendVideo(chatId, fileId, opts);
        case 'audio': return await bot.sendAudio(chatId, fileId, opts);
        case 'document': return await bot.sendDocument(chatId, fileId, opts);
        default: throw new Error(`不支持的媒体类型: ${type}`);
    }
}

/**
 * 收录发送的媒体（只写 media 位置；message 与标签由 utils/tagSession.recordAndTag 统一处理）
 * 注意：group_list 的计数/删除标记由调用方统一更新（每组一次），
 * 避免媒体组内各条媒体并发 upsert 同一 group_id 触发唯一索引冲突
 */
async function recordSentMedia(sentMsg, targetChatId, groupId, mediaInfo, targetType) {
    const { fileUniqueId, type, videoTime, thumbFileId } = mediaInfo;

    // 写入媒体位置：目标为频道存 channel，目标为群组存 group
    const location = await buildMediaLocation(targetChatId, sentMsg.message_id, targetType);

    await insertMedia({
        group_id: groupId,
        subgroup: 1,
        file_id: sentMsg.photo ? sentMsg.photo[sentMsg.photo.length - 1].file_id : (sentMsg.video ? sentMsg.video.file_id : (sentMsg.audio ? sentMsg.audio.file_id : sentMsg.document.file_id)),
        file_unique_id: fileUniqueId,
        media_type: type,
        video_time: videoTime,
        thumb_file_id: thumbFileId,
        media_name: mediaInfo.mediaName,   // 文件/音乐的名称（图片、视频为 null，不会写入）
        ...location
    });
}

/**
 * 发送媒体组到目标群组（注释位置还原）
 * Telegram 机制：媒体组仅第一条可带注释。注释不在第一条时不放置临时注释
 * （不再清空重编辑，少一次 API 调用、无错误文本闪现），发完直接编辑回原始位置；
 * 同时修复"注释同时在第一条和其他位置时其余注释丢失"的问题。
 * 按 /send 原有行为不使用 HTML 解析，避免注释中含 & < > 等字符时发送失败。
 */
async function sendMediaGroupToChat(chatId, items) {
    const captionIndexes = [];
    items.forEach((item, idx) => {
        if (item.caption) captionIndexes.push(idx);
    });

    const BATCH = 10;
    // 注释先行带上：描述原本不在第一条时，也先把第一条注释内联带上 ——
    // Telegram 的自动转发（频道帖 → 关联讨论群）是在发送那一刻复制消息的，
    // 靠"发完再编辑"补上的描述不会出现在转发副本里（讨论群那份就变成空描述）。
    const carry = albumCaptionCarry(items);
    const sentMessages = [];
    for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH);
        const media = batch.map((item, idx) => {
            const base = {
                type: item.type,
                media: item.fileId
            };
            // 第一条带上注释（原本就在第一条 → 照旧；不在 → 临时带上，发送后还原并清掉）
            if (i === 0 && idx === 0 && carry.carrierCaption) {
                base.caption = carry.carrierCaption;
            }
            return base;
        });
        const results = await bot.sendMediaGroup(chatId, media);
        sentMessages.push(...results);
    }

    // 注释不在第一条时：发送后编辑回原始位置
    await restoreMediaGroupCaptions(chatId, sentMessages, items, captionIndexes);
    // 临时带在第一条上的注释要清掉（描述本来不在第一条时），否则相册里会同时出现两处描述
    if (carry.clearFirst && sentMessages[0]) {
        await clearAlbumCaption(chatId, sentMessages[0].message_id);
    }
    return sentMessages;
}

// ---------------- 媒体组收集 ----------------

async function collectMediaGroup(userId, msg, mediaInfo) {
    const key = `${userId}_${msg.media_group_id}`;
    // 文件级守卫：该文件**正在这一轮 flush 里发送**（含落库）时，忽略重复投递
    // （同一批文件可能以不同的 media_group_id 再次到达，或相册被重复投递）。
    // 守卫只覆盖 in-flight 窗口；"已发送过"一律由 flush 里的数据库查询判定。
    if (isInFlight(mediaInfo.fileUniqueId)) {
        logger.info(`文件 ${mediaInfo.fileUniqueId} 正在发送中，忽略重复投递 (key=${key})`);
        return;
    }

    let entry = pendingGroups.get(key);
    const isNewEntry = !entry;
    if (entry) {
        // 组内去重：同一文件不重复收集（防止同组重复投递导致条目翻倍）
        if (entry.items.some(it => it.fileUniqueId === mediaInfo.fileUniqueId)) {
            logger.info(`文件 ${mediaInfo.fileUniqueId} 已在收集队列中，忽略重复 (key=${key})`);
            return;
        }
        entry.items.push({ ...mediaInfo, message_id: msg.message_id });
    } else {
        entry = { items: [{ ...mediaInfo, message_id: msg.message_id }], timer: null, processingMsgId: null };
        pendingGroups.set(key, entry);
    }

    // 定时器在同步代码中统一设置（await 之前）：任何时刻该 entry 只有一个活定时器。
    // 每条消息都会重置窗口（clearTimeout + 重设），保证最后一条消息后等待完整窗口才发送。
    // （旧实现把定时器放在 await 之后，并发消息会互相覆盖而不清除旧定时器，
    //   导致同一 entry 存在两个定时器 → 触发两次 flush → 重复发送 / 覆盖标签界面）
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
        pendingGroups.delete(key);
        // 同一用户串行化：上一轮 flush 完全完成（含入库）后本轮的 flush 才执行，
        // 使去重查询能读到已提交数据，避免并发 flush 互相竞争导致重复发送
        const prev = userFlushChains.get(userId) || Promise.resolve();
        const next = prev.catch(() => { }).then(() =>
            flushMediaGroup(userId, msg.media_group_id, entry.items, entry.processingMsgId)
        );
        userFlushChains.set(userId, next.catch(() => { }));
    }, GROUP_FLUSH_DELAY);

    if (isNewEntry) {
        // 第一条消息：回复"正在发送中"，随后由 flushMediaGroup 刷新为最终结果
        try {
            const sent = await bot.sendMessage(userId, '♻️ 正在发送中，请耐心等待...', {
                reply_to_message_id: msg.message_id,
                allow_sending_without_reply: true
            });
            const cur = pendingGroups.get(key);
            if (cur) {
                cur.processingMsgId = sent.message_id;
                pendingGroups.set(key, cur);
            }
        } catch (err) {
            logger.error(`发送处理中消息失败: ${err.message}`);
        }
    }
    logger.info(`媒体组收集: key=${key}, media_group_id=${msg.media_group_id}, 当前 ${entry.items.length} 条`);
}

async function flushMediaGroup(userId, mediaGroupId, items, processingMsgId) {
    const rawState = getRawUserState(userId);
    if (!rawState || rawState.mode !== 'send' || !rawState.targetChatId) return;
    const targetChatId = rawState.targetChatId;
    const targetName = rawState.targetName || '目标群组';
    const targetType = rawState.targetType || 'group';
    const groupId = `${targetChatId}_${mediaGroupId}`;

    const sorted = [...items].sort((a, b) => a.message_id - b.message_id);
    const newItems = [];
    for (const item of sorted) {
        const existing = await findMediaByFileUniqueId(item.fileUniqueId);
        if (!existing && !isInFlight(item.fileUniqueId)) {
            newItems.push(item);
        } else if (isInFlight(item.fileUniqueId)) {
            logger.info(`文件 ${item.fileUniqueId} 正在发送中，去重跳过`);
        }
    }
    if (!newItems.length) {
        const text = '❌ 所有媒体均已存在，无法发送';
        if (processingMsgId) {
            await bot.editMessageText(text, { chat_id: userId, message_id: processingMsgId }).catch(() => { });
        } else {
            await bot.sendMessage(userId, text);
        }
        return;
    }

    // 登记 in-flight（发送 + 落库窗口）：既用于吞掉"发送过程中被重复投递"的同一批文件，
    // 也让频道帖被 Telegram 自动转发到讨论群时，转发兜底能知道"这个文件正在被 /send 收录"
    // （见 utils/inflight.js 与 handlers/groupMessageHandlers.js: transferRecordToGroup）
    const guardedFiles = newItems.map(item => item.fileUniqueId);
    for (const fileUniqueId of guardedFiles) {
        markInFlight(fileUniqueId);
    }

    try {
        let sentMessages;
        try {
            sentMessages = await sendMediaGroupToChat(targetChatId, newItems);
        } catch (err) {
            logger.error(`发送媒体组失败: ${err.message}`);
            logOperation({
                action: 'send_fail',
                result: 'fail',
                source: 'private',
                userId,
                target: { type: 'chat', id: targetChatId },
                counts: { media: newItems.length },
                detail: { targetName, targetType, isMediaGroup: true, mediaTypes: [...new Set(newItems.map(i => i.type))] },
                error: err.message
            }).catch(() => { });
            const text = '❌ 发送媒体组失败，请重试';
            if (processingMsgId) {
                await bot.editMessageText(text, { chat_id: userId, message_id: processingMsgId }).catch(() => { });
            } else {
                await bot.sendMessage(userId, text);
            }
            return;
        }

        // 并行落库：每条媒体独立插入（media + message），全部完成后统一更新 group_list（一次 +N）
        // 相比逐条串行 await（每条 3~4 次 DB 往返），媒体组越大提速越明显
        try {
            await Promise.all(sentMessages.map((sent, i) => {
                const original = newItems[i];
                if (!original) return null;
                return recordSentMedia(sent, targetChatId, groupId, original, targetType);
            }));
            await upsertGroupList(groupId, newItems.length);
            // 发送成功日志：一次媒体组 = 一条日志（counts 带媒体数量，便于月表统计产出量）
            logOperation({
                action: 'send_media',
                source: 'private',
                userId,
                target: { type: 'chat', id: targetChatId },
                counts: {
                    media: newItems.length,
                    groups: 1,
                    captions: newItems.filter(i => i.caption && String(i.caption).trim()).length
                },
                detail: {
                    targetName,
                    targetType,
                    isMediaGroup: true,
                    mediaGroupId: mediaGroupId || undefined,
                    mediaTypes: [...new Set(newItems.map(i => i.type))],
                    videoSeconds: newItems.reduce((sum, i) => sum + (i.videoTime || 0), 0) || undefined,
                    groupId
                }
            }).catch(() => { });
        } catch (err) {
            // 落库失败必须让用户看到（否则媒体已发到群里却没入库，用户以为已收录）
            logger.error(`发送媒体组落库失败: group_id=${groupId}, ${err.message}`);
            const failText = `⚠️ 已发送到 ${targetName}（媒体组 ${newItems.length} 个），但入库失败：${err.message}`;
            if (processingMsgId) {
                await bot.editMessageText(failText, { chat_id: userId, message_id: processingMsgId }).catch(() => { });
            } else {
                await bot.sendMessage(userId, failText).catch(() => { });
            }
            return;
        }

        // 发送完成并已把注释还原到正确位置后，收录 message 并进入打标签会话：
        // 标签作用对象为"正确注释位置"（组内第一条带注释的媒体）对应的 message（file_unique_id）
        const captionIndex = newItems.findIndex(item => item.caption && String(item.caption).trim());
        const successText = `✅ 已发送到 ${targetName}（媒体组 ${newItems.length} 个）`;
        const tagItems = sentMessages.map((sent, i) => {
            const original = newItems[i];
            if (!original) return null;
            return {
                sentMsg: sent,
                caption: original.caption,
                fileUniqueId: original.fileUniqueId,
                type: original.type,
                successText
            };
        }).filter(Boolean);
        await recordAndTag(userId, { groupId, items: tagItems });
        // 与群组自动收录一致：收录 message 之后按组内文本状态统一重算 is_delete
        // （有文本 → 0；整组都无描述 → 时间戳，表示可被 /clean 清理）
        const isDelete = await syncGroupDeleteByText(groupId);
        logger.info(`发送媒体组 group_list 文本状态重算: group_id=${groupId}, is_delete=${isDelete}`);

        // 非"立即弹出打标签面板"的情况（如整组无描述）由普通提示承载结果
        if (captionIndex < 0) {
            if (processingMsgId) {
                await bot.editMessageText(successText, { chat_id: userId, message_id: processingMsgId }).catch(() => { });
            } else {
                await bot.sendMessage(userId, successText).catch(() => { });
            }
        }
    } finally {
        // 守卫只覆盖"这一轮正在发送（含落库）"的窗口，结束即解除：
        // 否则用户用 delete_group 删掉媒体组、想重新发送同一批文件时，
        // 会被守卫当成"正在发送/已发送"而静默忽略（终端只打一行"忽略重复消息"），
        // 重新发送实际没有发生 → 再删除就报"数据不存在"。
        for (const fileUniqueId of guardedFiles) clearInFlight(fileUniqueId);
    }
}

// ---------------- 模式消息处理 ----------------

async function handleSendMode(msg, state) {
    const userId = msg.from.id;
    updateUserActivity(userId);
    const userMsgId = msg.message_id;

    // 注：打标签会话中的纯文本已由 handlers/messageHandlers 提前拦截
    // （见 utils/tagSession.handleTagText），不会走到这里

    if (!state.targetChatId) {
        // 打标签会话进行中又发媒体：先把目标群组步骤重置为选择中，提示选择后重发
        if (isTagging(userId)) {
            setUserState(userId, { ...state, step: 'selecting', lastActivity: Date.now() });
            await bot.sendMessage(userId, '❌ 请先选择目标群组/频道，再发送要发送的媒体', {
                reply_to_message_id: userMsgId
            });
            return true;
        }
        await bot.sendMessage(userId, '❌ 请先选择目标群组/频道', {
            reply_to_message_id: userMsgId
        });
        return true;
    }

    const targetChatId = state.targetChatId;
    const targetName = state.targetName || '目标群组';

    // 文本消息：直接发送，并**收录到 media**（media_type='text'）——保留 Telegram 消息格式
    if (msg.text && !msg.photo && !msg.video && !msg.audio && !msg.document) {
        try {
            // 带上 entities 即保留富文本；不用 parse_mode（见 utils/forwardText.js 注释）
            const { buildForwardTextOptions, countEntities } = require('../../utils/forwardText');
            const sendOpts = buildForwardTextOptions(msg);
            const sent = await bot.sendMessage(targetChatId, msg.text, sendOpts);
            // 收录这条文本：media_type='text'，内容存 media_name，entities 保留格式（见 media.recordTextMedia）
            const groupId = `${targetChatId}_${msg.message_id}`;
            await recordTextMedia({
                sentMsg: sent,
                chatId: targetChatId,
                targetType: state.targetType || 'group',
                groupId,
                subgroup: 1,
                text: msg.text,
                entities: msg.entities
            });
            await upsertGroupList(groupId);
            await syncGroupDeleteByText(groupId);
            logger.info(`用户 ${userId} 发送文本到 ${targetChatId}: msg=${sent.message_id}, group_id=${groupId}`);
            logOperation({
                action: 'send_text',
                source: 'private',
                userId,
                chatId: targetChatId,
                messageId: sent.message_id,
                target: { type: 'chat', id: targetChatId },
                counts: { texts: 1, textLength: msg.text.length },
                detail: {
                    targetName,
                    targetType: state.targetType || 'group',
                    entityCount: countEntities(msg),
                    groupId
                }
            }).catch(() => { });
            await bot.sendMessage(userId, `✅ 已发送到 ${targetName}`, {
                reply_to_message_id: userMsgId
            });
        } catch (err) {
            logger.error(`发送文本失败: ${err.message}`);
            logOperation({
                action: 'send_fail',
                result: 'fail',
                source: 'private',
                userId,
                target: { type: 'chat', id: targetChatId },
                counts: { texts: 1 },
                detail: { targetName, textLength: msg.text.length },
                error: err.message
            }).catch(() => { });
            await bot.sendMessage(userId, '❌ 发送失败，请检查机器人是否为该群组管理员', {
                reply_to_message_id: userMsgId
            });
        }
        return true;
    }

    const mediaInfo = extractMediaFromMessage(msg);
    if (!mediaInfo) {
        await bot.sendMessage(userId, '❌ 仅支持发送文本、图片、视频、音频、文档', {
            reply_to_message_id: userMsgId
        });
        return true;
    }

    // 媒体组：收集后统一发送
    if (msg.media_group_id) {
        await collectMediaGroup(userId, msg, mediaInfo);
        return true;
    }

    // 单个媒体
    const existing = await findMediaByFileUniqueId(mediaInfo.fileUniqueId);
    if (existing) {
        await bot.sendMessage(userId, '❌ 该媒体已存在，无法再次发送', {
            reply_to_message_id: userMsgId
        });
        return true;
    }

    // 先回复"正在发送中"，随后刷新为最终结果
    let processingMsg = null;
    try {
        processingMsg = await bot.sendMessage(userId, '♻️ 正在发送中，请耐心等待...', {
            reply_to_message_id: userMsgId,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送处理中消息失败: ${err.message}`);
    }
    const processingMsgId = processingMsg ? processingMsg.message_id : null;

    const groupId = `${targetChatId}_${msg.message_id}`;
    let sentMsg;
    try {
        sentMsg = await sendSingleMediaToChat(targetChatId, mediaInfo);
    } catch (err) {
        logger.error(`发送单个媒体失败: ${err.message}`);
        logOperation({
            action: 'send_fail',
            result: 'fail',
            source: 'private',
            userId,
            target: { type: 'chat', id: targetChatId },
            counts: { media: 1 },
            detail: { targetName, targetType: state.targetType || 'group', mediaType: mediaInfo.type },
            error: err.message
        }).catch(() => { });
        const text = '❌ 发送失败，请检查机器人是否为该群组管理员';
        if (processingMsgId) {
            await bot.editMessageText(text, { chat_id: userId, message_id: processingMsgId }).catch(() => { });
        } else {
            await bot.sendMessage(userId, text, { reply_to_message_id: userMsgId });
        }
        return true;
    }

    await recordSentMedia(sentMsg, targetChatId, groupId, mediaInfo, state.targetType || 'group');
    // group_list 计数（单条媒体，每组一次）；is_delete 在 recordAndTag 写 message 之后再重算
    await upsertGroupList(groupId);
    logOperation({
        action: 'send_media',
        source: 'private',
        userId,
        chatId: targetChatId,
        messageId: sentMsg.message_id,
        target: { type: 'chat', id: targetChatId },
        counts: { media: 1, groups: 1, captions: mediaInfo.caption ? 1 : 0 },
        detail: {
            targetName,
            targetType: state.targetType || 'group',
            isMediaGroup: false,
            mediaType: mediaInfo.type,
            videoTime: mediaInfo.videoTime || undefined,
            hasCaption: !!mediaInfo.caption,
            groupId
        }
    }).catch(() => { });
    // 收录 message（有描述时）并自动进入打标签会话；无描述只提示
    // 注意：syncGroupDeleteByText 在 recordAndTag 写 message 之后重算才准确，故此处再算一次
    const successText = `✅ 已发送到 ${targetName}`;
    const [shownInPanel] = await recordAndTag(userId, {
        groupId,
        items: [{
            sentMsg,
            caption: mediaInfo.caption,
            fileUniqueId: mediaInfo.fileUniqueId,
            type: mediaInfo.type,
            successText
        }]
    });
    await syncGroupDeleteByText(groupId);
    if (!shownInPanel) {
        if (processingMsgId) {
            await bot.editMessageText(successText, { chat_id: userId, message_id: processingMsgId }).catch(() => { });
        } else {
            await bot.sendMessage(userId, successText, { reply_to_message_id: userMsgId }).catch(() => { });
        }
    }
    logger.info(`用户 ${userId} 发送单个媒体到 ${targetChatId}，group_id=${groupId}`);
    return true;
}

module.exports = {
    handleSendMode,
    handleCallback,
    showGroupList
};
