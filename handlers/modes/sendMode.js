// handlers/modes/sendMode.js
/**
 * /send 发送模式
 * 1. 用户选择目标群组/频道（channel_group 列表，分页按钮）
 * 2. 用户发送消息/媒体/媒体组 → 发送到目标群组
 * 3. 发送成功后收录（media + message + group_list），并附标签按钮供打标签
 */
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { getAllChannelGroups } = require('../../db/channelGroup');
const { findMediaByFileUniqueId, insertMedia } = require('../../db/media');
const { upsertMessage } = require('../../db/message');
const { upsertGroupList, setGroupDelete } = require('../../db/groupList');
const { addTagToGroup, removeTagFromGroup, getGroupTags } = require('../../db/message');
const { getTags, sortTags, tagUsed, addTag } = require('../../db/tags');
const { buildTagKeyboard, splitTagInput, matchTagsInText } = require('../../utils/tagUi');
const { extractMediaFromMessage } = require('../../media');
const { removeLevelSuffix } = require('../../utils/levelExtractor');
const { setUserState, deleteUserState, updateUserActivity, getRawUserState } = require('../../states');

const PAGE_SIZE = 6;        // 每页群组按钮数
const GROUP_FLUSH_DELAY = 1500; // 媒体组收集延迟(ms)

// 媒体组暂存：key=userId_mediaGroupId -> { items, timer }
const pendingGroups = new Map();

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
        if (!rawState || rawState.mode !== 'send') {
            setUserState(userId, {
                mode: 'send',
                step: 'ready',
                targetChatId: chatId,
                targetName: name,
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
                lastActivity: Date.now()
            });
        }

        await bot.editMessageText(`✅ 已选择：${name}\n请发送要发送的消息（支持单个媒体或媒体组）：`, {
            chat_id: userId,
            message_id: query.message.message_id
        });
        await bot.answerCallbackQuery(query.id, { text: `已选择 ${name}` });
        logger.info(`用户 ${userId} 选择发送目标: ${chatId} (${name})`);
        return;
    }
}

// ---------------- 标签按钮（发送成功后的打标签操作） ----------------

async function renderTagKeyboard(userId, messageId, groupId, page = 1) {
    const tags = sortTags(await getTags());
    const current = await getGroupTags(groupId);
    const currentSet = new Set(current);
    const result = buildTagKeyboard(tags, {
        prefix: 'sendtag',
        pagePrefix: 'sendtag_page',
        page,
        marker: { names: currentSet, on: '✅', off: '+' },
        extraRows: [[{ text: '✅ 完成', callback_data: 'sendtag_done' }]]
    });
    return result;
}

async function handleTagCallback(query) {
    const data = query.data;
    const userId = query.from.id;
    const rawState = getRawUserState(userId);

    if (data === 'sendtag_done') {
        await bot.editMessageText('✅ 已完成标签操作', {
            chat_id: userId,
            message_id: query.message.message_id
        }).catch(() => { });
        await bot.answerCallbackQuery(query.id, { text: '完成' });
        if (rawState && rawState.mode === 'send') {
            deleteUserState(userId);
        }
        logger.info(`用户 ${userId} 完成发送模式标签操作，退出发送模式`);
        return;
    }

    // 翻页
    if (data.startsWith('sendtag_page:')) {
        const page = parseInt(data.split(':')[1], 10) || 1;
        const groupId = rawState ? rawState.lastGroupId : null;
        if (!groupId) {
            await bot.answerCallbackQuery(query.id, { text: '❌ 缺少媒体组信息' });
            return;
        }
        await bot.answerCallbackQuery(query.id);
        await renderTagMessage(userId, query.message.message_id, groupId, page);
        return;
    }

    if (data.startsWith('sendtag:')) {
        const tag = decodeURIComponent(data.split(':')[1]);
        const groupId = rawState ? rawState.lastGroupId : null;
        if (!groupId) {
            await bot.answerCallbackQuery(query.id, { text: '❌ 缺少媒体组信息' });
            return;
        }
        const current = await getGroupTags(groupId);
        if (current.includes(tag)) {
            await removeTagFromGroup(groupId, tag);
            await tagUsed(tag, -1);
        } else {
            await addTagToGroup(groupId, tag);
            await tagUsed(tag, 1);
        }
        await bot.answerCallbackQuery(query.id, { text: `标签「${tag}」已更新` });
        // 刷新：文本中的已选标签 + 按钮状态
        await renderTagMessage(userId, query.message.message_id, groupId);
        logger.info(`用户 ${userId} 发送模式切换标签: ${tag} -> group=${groupId}`);
        return;
    }
}

/**
 * 手动输入标签（空格/、分隔）：不存在则自动创建后打上
 */
async function applyManualTags(userId, text, groupId, mode, tagMsgId) {
    const names = splitTagInput(text);
    if (!names.length) {
        await bot.sendMessage(userId, '❌ 未识别到标签');
        return;
    }
    const allTags = await getTags();
    for (const name of names) {
        const exists = allTags.some(t => t.name.toLowerCase() === name.toLowerCase());
        if (!exists) {
            await addTag(name);
        }
        if (mode === 'add') {
            await addTagToGroup(groupId, name);
            await tagUsed(name, 1);
        } else {
            await removeTagFromGroup(groupId, name);
            await tagUsed(name, -1);
        }
    }
    // 刷新标签消息（文本已选列表 + 键盘）
    if (tagMsgId) {
        await renderTagMessage(userId, tagMsgId, groupId, 1);
    }
    await bot.sendMessage(userId, `✅ 已${mode === 'add' ? '添加' : '移除'}标签：${names.join('、')}`);
    logger.info(`用户 ${userId} 手动${mode === 'add' ? '添加' : '移除'}标签: ${names.join('、')}`);
}

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
 * 收录发送的媒体（media + message + group_list），group_id 按目标群组新建
 */
async function recordSentMedia(sentMsg, targetChatId, groupId, mediaInfo) {
    const { fileUniqueId, type, caption, videoTime } = mediaInfo;

    await insertMedia({
        group_id: groupId,
        subgroup: 1,
        file_id: sentMsg.photo ? sentMsg.photo[sentMsg.photo.length - 1].file_id : (sentMsg.video ? sentMsg.video.file_id : (sentMsg.audio ? sentMsg.audio.file_id : sentMsg.document.file_id)),
        file_unique_id: fileUniqueId,
        media_type: type,
        message_id: sentMsg.message_id,
        video_time: videoTime
    });

    await upsertGroupList(groupId);
    await setGroupDelete(groupId, 0);

    // 只有带文本（caption）的媒体才收录至 message
    if (caption) {
        const cleanText = removeLevelSuffix(caption);
        await upsertMessage({
            message_id: sentMsg.message_id,
            chat_id: targetChatId,
            text: cleanText,
            file_unique_id: fileUniqueId,
            media_type: type,
            group_id: groupId
        });
        logger.info(`发送模式收录 message: group_id=${groupId}, file_unique_id=${fileUniqueId}`);
    }
}

/**
 * 发送媒体组到目标群组（分批，Telegram 每批最多 10 条）
 */
async function sendMediaGroupToChat(chatId, items) {
    const BATCH = 10;
    const sentMessages = [];
    for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH);
        const media = batch.map((item, idx) => {
            const base = {
                type: item.type,
                media: item.fileId
            };
            // 仅第一条可带 caption
            if (idx === 0 && item.caption) base.caption = item.caption;
            return base;
        });
        const results = await bot.sendMediaGroup(chatId, media);
        sentMessages.push(...results);
    }
    return sentMessages;
}

// ---------------- 媒体组收集 ----------------

function collectMediaGroup(userId, msg, mediaInfo) {
    const key = `${userId}_${msg.media_group_id}`;
    let entry = pendingGroups.get(key);
    if (entry) {
        entry.items.push({ ...mediaInfo, message_id: msg.message_id });
        clearTimeout(entry.timer);
    } else {
        entry = { items: [{ ...mediaInfo, message_id: msg.message_id }], timer: null };
        pendingGroups.set(key, entry);
    }
    entry.timer = setTimeout(() => {
        pendingGroups.delete(key);
        flushMediaGroup(userId, msg.media_group_id, entry.items);
    }, GROUP_FLUSH_DELAY);
}

async function flushMediaGroup(userId, mediaGroupId, items) {
    const rawState = getRawUserState(userId);
    if (!rawState || rawState.mode !== 'send' || !rawState.targetChatId) return;
    const targetChatId = rawState.targetChatId;
    const targetName = rawState.targetName || '目标群组';
    const groupId = `${targetChatId}_${mediaGroupId}`;

    const sorted = [...items].sort((a, b) => a.message_id - b.message_id);
    const newItems = [];
    for (const item of sorted) {
        const existing = await findMediaByFileUniqueId(item.fileUniqueId);
        if (!existing) newItems.push(item);
    }
    if (!newItems.length) {
        await bot.sendMessage(userId, '❌ 所有媒体均已存在，无法发送');
        return;
    }

    let sentMessages;
    try {
        sentMessages = await sendMediaGroupToChat(targetChatId, newItems);
    } catch (err) {
        logger.error(`发送媒体组失败: ${err.message}`);
        await bot.sendMessage(userId, '❌ 发送媒体组失败，请重试');
        return;
    }

    for (let i = 0; i < sentMessages.length; i++) {
        const sent = sentMessages[i];
        const original = newItems[i];
        if (!original) continue;
        await recordSentMedia(sent, targetChatId, groupId, original);
    }

    const firstCaption = newItems.length ? (newItems[0].caption || '') : '';
    await sendSuccessWithTags(userId, `✅ 已发送到 ${targetName}（媒体组 ${newItems.length} 个）`, groupId, firstCaption);
}

// ---------------- 发送成功回复 + 标签按钮 ----------------

async function sendSuccessWithTags(userId, text, groupId, caption) {
    // 自动识别媒体文本中出现的标签，并自动打上（勾选）
    const allTags = await getTags();
    const matched = matchTagsInText(caption, allTags);
    for (const tag of matched) {
        await addTagToGroup(groupId, tag);
        await tagUsed(tag, 1);
    }

    // 已选标签展示在消息文本中
    const current = await getGroupTags(groupId);
    const finalText = text + (current.length ? `\n\n📌 已选标签：${current.join('、')}` : '');

    const keyboard = await renderTagKeyboard(userId, null, groupId);
    // 更新用户状态：记录 lastGroupId / 标签消息 ID / 基础文本
    const rawState = getRawUserState(userId);
    if (rawState && rawState.mode === 'send') {
        setUserState(userId, {
            ...rawState,
            lastGroupId: groupId,
            step: 'tagging',
            tagBaseText: text,
            lastActivity: Date.now()
        });
    }
    const sent = await bot.sendMessage(userId, finalText, { reply_markup: keyboard });
    const st = getRawUserState(userId);
    if (st && st.mode === 'send') {
        setUserState(userId, { ...st, tagMsgId: sent.message_id });
    }
}

/**
 * 刷新标签消息（文本中展示已选标签 + 键盘），每次标签操作后调用
 */
async function renderTagMessage(userId, messageId, groupId, page = 1) {
    const st = getRawUserState(userId);
    const baseText = (st && st.tagBaseText) || '✅ 发送成功';
    const current = await getGroupTags(groupId);
    const keyboard = await renderTagKeyboard(userId, messageId, groupId, page);
    const text = baseText + (current.length ? `\n\n📌 已选标签：${current.join('、')}` : '');
    await bot.editMessageText(text, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: keyboard
    }).catch(() => { });
}

// ---------------- 模式消息处理 ----------------

async function handleSendMode(msg, state) {
    const userId = msg.from.id;
    updateUserActivity(userId);
    const userMsgId = msg.message_id;

    // 标签阶段（发送成功后）：文本消息作为手动标签输入（空格/、分隔），不发送到群组
    if (state.lastGroupId && msg.text && !msg.photo && !msg.video && !msg.audio && !msg.document) {
        await applyManualTags(userId, msg.text, state.lastGroupId, 'add', state.tagMsgId);
        return true;
    }

    if (!state.targetChatId) {
        await bot.sendMessage(userId, '❌ 请先选择目标群组/频道', {
            reply_to_message_id: userMsgId
        });
        return true;
    }

    const targetChatId = state.targetChatId;
    const targetName = state.targetName || '目标群组';

    // 文本消息：直接发送，不收录
    if (msg.text && !msg.photo && !msg.video && !msg.audio && !msg.document) {
        try {
            const sent = await bot.sendMessage(targetChatId, msg.text);
            logger.info(`用户 ${userId} 发送文本到 ${targetChatId}: msg=${sent.message_id}`);
            await bot.sendMessage(userId, `✅ 已发送到 ${targetName}`, {
                reply_to_message_id: userMsgId
            });
        } catch (err) {
            logger.error(`发送文本失败: ${err.message}`);
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
        collectMediaGroup(userId, msg, mediaInfo);
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

    const groupId = `${targetChatId}_${msg.message_id}`;
    let sentMsg;
    try {
        sentMsg = await sendSingleMediaToChat(targetChatId, mediaInfo);
    } catch (err) {
        logger.error(`发送单个媒体失败: ${err.message}`);
        await bot.sendMessage(userId, '❌ 发送失败，请检查机器人是否为该群组管理员', {
            reply_to_message_id: userMsgId
        });
        return true;
    }

    await recordSentMedia(sentMsg, targetChatId, groupId, mediaInfo);
    await sendSuccessWithTags(userId, `✅ 已发送到 ${targetName}`, groupId, mediaInfo.caption);
    logger.info(`用户 ${userId} 发送单个媒体到 ${targetChatId}，group_id=${groupId}`);
    return true;
}

module.exports = {
    handleSendMode,
    handleCallback,
    handleTagCallback,
    showGroupList
};
