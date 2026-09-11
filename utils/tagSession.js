// utils/tagSession.js
/**
 * 通用「打标签会话」（/send、消息回复、编辑描述等写库成功后共用）
 *
 * 设计目标（与模式解耦）：
 *   1. 发送 / 回复成功后自动进入打标签会话，但**不切换、不退出**用户原有模式
 *      （send 仍是 send、message_reply 仍是 message_reply），因此用户可继续发送媒体；
 *   2. 打标签期间用户输入的**纯文本**视为标签操作（空格 / 、 分隔，`-标签` 表示移除），
 *      只有点击《✅ 完成》才结束本次打标签；
 *   3. 队列：当前标签还没打完又来一个需要打标签的媒体 → 先入队，
 *      用户点《完成》后才把面板切到队列中的下一个（默认行为）；
 *   4. 标签按 message 独立（file_unique_id），group_list.tags 记录整组标签（见 db/groupList）。
 *
 * 会话只存在于内存（与其它模式状态一致），不随模式状态清理而消失。
 */
const bot = require('../bot');
const logger = require('../logger');
const { getRawUserState, updateUserActivity } = require('../states');
const { upsertMessage, getMessageTags, addTagToMessage, removeTagFromMessage } = require('../db/message');
const { applyTagChangeToGroupTags, syncGroupTags } = require('../db/groupList');
const { getTags, sortTags, addTag, tagUsed } = require('../db/tags');
const { buildTagRegionKeyboard, parseTagInput, matchTagsInText } = require('./tagUi');
const { removeLevelSuffix } = require('./levelExtractor');
const { logOperation } = require('../utils/opLog');

// userId -> { active: {groupId, fileUniqueId, baseText} | null, queue: [], panelMsgId: number|null }
const tagSessions = new Map();

// 会话空闲上限：超过该时间没有任何标签操作视为已放弃（避免长期驻留内存）
const SESSION_TTL = 2 * 60 * 60 * 1000;

setInterval(() => {
    cleanupIdleSessions();
}, 30 * 60 * 1000).unref();

function getSession(userId, create = false) {
    let s = tagSessions.get(userId);
    if (!s && create) {
        s = { active: null, queue: [], panelMsgId: null, updatedAt: Date.now() };
        tagSessions.set(userId, s);
    }
    return s || null;
}

/** 当前是否处于打标签会话（有正在打标签的目标） */
function isTagging(userId) {
    const s = tagSessions.get(userId);
    return !!(s && s.active);
}

/** 取当前会话（可能为 null） */
function getTagSession(userId) {
    return tagSessions.get(userId) || null;
}

/** 清空用户打标签会话（退出模式 / 切换模式时调用） */
function clearTagSession(userId) {
    const s = tagSessions.get(userId);
    if (!s) return;
    if (s.active || (s.queue && s.queue.length)) {
        logger.info(`清理用户 ${userId} 的打标签会话（剩余队列 ${s.queue ? s.queue.length : 0}）`);
    }
    tagSessions.delete(userId);
}

// ---------------- 面板渲染 ----------------

async function currentTagsOf(target) {
    if (!target) return [];
    return target.fileUniqueId
        ? await getMessageTags(target.fileUniqueId)
        : (await syncGroupTags(target.groupId)) || [];
}

/**
 * 标签按钮键盘：上区=已有标签（点击移除），下区=标签库（点击添加），
 * 底部 = 《✅ 完成》 + 《🔁 回复该消息》
 */
async function renderTagKeyboard(target, page = 1) {
    const tags = sortTags(await getTags());
    const current = await currentTagsOf(target);
    return buildTagRegionKeyboard(current, tags, {
        prefix: 'sendtag',
        pagePrefix: 'sendtag_page',
        page,
        extraRows: [
            [{ text: '✅ 完成', callback_data: 'sendtag_done' }],
            [{ text: '🔁 回复该消息', callback_data: 'sendtag_reply' }]
        ]
    });
}

/** 面板文本：提示语 + 已选标签 + 排队提示 */
async function buildPanelText(session) {
    const target = session.active;
    const current = await currentTagsOf(target);
    const tagLine = current.length ? `\n\n📌 已选标签：${current.join('、')}` : '\n\n📌 已选标签：（无）';
    const queueLine = session.queue && session.queue.length
        ? `\n\n⏳ 还有 ${session.queue.length} 个媒体等待打标签（点《✅ 完成》后自动切换）`
        : '';
    return `${(target && target.baseText) || '✅ 已发送'}${tagLine}${queueLine}`;
}

/** 刷新当前打标签面板（每次标签操作后调用） */
async function refreshPanel(userId, page = 1) {
    const session = getSession(userId);
    if (!session || !session.active) return;
    if (!session.panelMsgId) {
        await sendPanel(userId, page);
        return;
    }
    const text = await buildPanelText(session);
    const keyboard = await renderTagKeyboard(session.active, page);
    await bot.editMessageText(text, {
        chat_id: userId,
        message_id: session.panelMsgId,
        reply_markup: keyboard
    }).catch(async (err) => {
        // 面板被删除 / 过旧无法编辑时补发一条
        logger.warn(`刷新打标签面板失败，改为新发一条: ${err.message}`);
        await sendPanel(userId, page);
    });
}

/** 发送一条新的打标签面板（并把面板消息 ID 记入会话） */
async function sendPanel(userId, page = 1) {
    const session = getSession(userId);
    if (!session || !session.active) return null;
    const text = await buildPanelText(session);
    const keyboard = await renderTagKeyboard(session.active, page);
    try {
        const sent = await bot.sendMessage(userId, text, { reply_markup: keyboard });
        session.panelMsgId = sent.message_id;
        session.updatedAt = Date.now();
        return sent;
    } catch (err) {
        logger.error(`发送打标签面板失败: ${err.message}`);
        return null;
    }
}

/**
 * 用新的提示语刷新面板（发送/回复成功时调用；无活动目标时退化为普通提示消息）
 * @returns {Promise<{shownAsPanel: boolean}>}
 */
async function showActivePanel(userId, text) {
    const session = getSession(userId);
    if (!session || !session.active) {
        await bot.sendMessage(userId, text).catch(() => { });
        return { shownAsPanel: false };
    }
    session.active.baseText = text;
    if (session.panelMsgId) {
        await refreshPanel(userId);
    } else {
        await sendPanel(userId);
    }
    return { shownAsPanel: true };
}

// ---------------- 队列 ----------------

function sameTarget(a, b) {
    return !!a && !!b && a.groupId === b.groupId && a.fileUniqueId === b.fileUniqueId;
}

/**
 * 入队一个打标签目标；队列为空时立即激活并弹出面板
 * @param {number} userId
 * @param {Object} target - { groupId, fileUniqueId, baseText }
 * @returns {Promise<{active: boolean, queued: boolean, position: number}>}
 */
async function enqueueTagTarget(userId, target) {
    const session = getSession(userId, true);

    // 同一目标已在打标签 / 已在队列中：不重复入队
    if (sameTarget(session.active, target) || session.queue.some(t => sameTarget(t, target))) {
        return { active: false, queued: false, position: 0 };
    }

    if (!session.active) {
        session.active = { ...target };
        session.panelMsgId = null;
        session.updatedAt = Date.now();
        await sendPanel(userId);
        logger.info(`用户 ${userId} 进入打标签会话: group=${target.groupId}, file=${target.fileUniqueId || '-'}`);
        return { active: true, queued: false, position: 0 };
    }

    session.queue.push({ ...target });
    session.updatedAt = Date.now();
    logger.info(`用户 ${userId} 打标签队列 +1（当前 ${session.queue.length}）: group=${target.groupId}, file=${target.fileUniqueId || '-'}`);
    return { active: false, queued: true, position: session.queue.length };
}

/**
 * 切换到队列中的下一个目标；队列为空则结束本次打标签会话
 * @returns {Promise<{advanced: boolean, remaining: number}>}
 */
async function advanceToNext(userId) {
    const session = getSession(userId);
    if (!session || !session.active) return { advanced: false, remaining: 0 };

    if (!session.queue.length) {
        await finishSession(userId, session);
        return { advanced: false, remaining: 0 };
    }

    session.active = session.queue.shift();
    session.updatedAt = Date.now();
    await refreshPanel(userId);

    const next = session.active;
    const remaining = session.queue.length;
    await bot.sendMessage(userId, `🏷️ 开始为下一个媒体打标签（剩余 ${remaining} 个）`).catch(() => { });
    logger.info(`用户 ${userId} 打标签切换到下一个: group=${next.groupId}, file=${next.fileUniqueId || '-'}, 剩余 ${remaining}`);
    return { advanced: true, remaining };
}

/** 结束本次打标签会话：去掉面板按钮并提示完成 */
async function finishSession(userId, session) {
    const panelMsgId = session.panelMsgId;
    const target = session.active;
    session.active = null;
    session.queue = [];
    session.panelMsgId = null;
    tagSessions.delete(userId);
    if (panelMsgId && target) {
        const current = await currentTagsOf(target);
        const baseText = String(target.baseText || '✅ 已发送').split('\n\n📌 已选标签：')[0];
        const text = current.length
            ? `${baseText}\n\n✅ 标签已完成：${current.join('、')}`
            : `${baseText}\n\n✅ 标签已完成（未打标签）`;
        await bot.editMessageText(text, { chat_id: userId, message_id: panelMsgId }).catch(() => { });
    }
    logger.info(`用户 ${userId} 完成本次打标签`);
}

// ---------------- 写库 + 自动打标签（发送 / 回复共用） ----------------

/**
 * 收录一条"发送/回复成功"的消息，并自动匹配文本中已存在的标签
 *
 * 只有**带描述**的媒体才写 message 记录（与全项目 is_delete 语义一致：
 * 组内没有任何 message 记录 = 空描述媒体组，可被 /clean 清理）；
 * 无描述媒体的标签操作没有作用对象，也不进入打标签队列。
 *
 * @param {Object} item - { sentMsg, caption, fileUniqueId, type, groupId, userId, via }
 * @returns {Promise<{captioned: boolean, matched: string[], added: string[]}>}
 */
async function recordMessageWithAutoTags({ sentMsg, caption, fileUniqueId, type, groupId }) {
    const hasText = !!(caption && String(caption).trim());
    if (!hasText) return { captioned: false, matched: [], added: [] };

    const cleanText = removeLevelSuffix(caption);
    await upsertMessage({
        message_id: sentMsg.message_id,
        chat_id: sentMsg.chat ? sentMsg.chat.id : undefined,
        text: cleanText,
        file_unique_id: fileUniqueId,
        media_type: type,
        group_id: groupId
    });
    logger.info(`打标签会话收录 message: group_id=${groupId}, file_unique_id=${fileUniqueId}`);

    // 自动识别文本中出现的标签：标签按 message 独立，保留已有标签，只补充新匹配到的
    const matched = matchTagsInText(cleanText, await getTags());
    const added = [];
    if (fileUniqueId) {
        const prev = await getMessageTags(fileUniqueId);
        for (const tag of matched) {
            if (prev.includes(tag)) continue;
            await addTagToMessage(fileUniqueId, tag);
            await tagUsed(tag, 1);
            added.push(tag);
        }
    }
    return { captioned: true, matched, added };
}

/**
 * 批量收录 + 自动打标签，并把带描述的条目依次送入打标签队列
 *
 * 行为：
 *   - 每条成功发送/回复的**带描述**媒体 → 收录 message + 自动匹配标签 → 进入打标签队列；
 *   - 队列中第一条立即弹出打标签面板（提示语用对应条目的 successText）；
 *   - 已有正在打标签的目标时，新条目只入队并提示"已加入队列"，
 *     等用户点《✅ 完成》后才切换到下一个；
 *   - 无描述的媒体只发普通成功提示，不进入打标签。
 *
 * @param {number} userId
 * @param {Object} params
 *   - groupId: 媒体组 ID
 *   - items: [{ sentMsg, caption, fileUniqueId, type, successText }]
 * @returns {Promise<boolean[]>} 与 items 等长；true 表示该条的提示语由打标签面板承载
 */
async function recordAndTag(userId, { groupId, items }) {
    const list = items || [];
    let changedCount = 0;
    const captionedFlags = [];
    for (const item of list) {
        const { captioned, added } = await recordMessageWithAutoTags({ ...item, groupId });
        if (added && added.length) changedCount += added.length;
        captionedFlags.push(captioned);
    }
    // group_list.tags = 组内所有 message 标签的并集（只在实际有新增标签时重算）
    if (changedCount > 0) await syncGroupTags(groupId);

    // 带描述的条目 → 打标签队列（先到先打；用户点《完成》后才切下一个）
    let firstActive = -1;
    for (let i = 0; i < list.length; i++) {
        if (!captionedFlags[i]) continue;
        const item = list[i];
        const res = await enqueueTagTarget(userId, {
            groupId,
            fileUniqueId: item.fileUniqueId,
            baseText: item.successText || '✅ 已发送'
        });
        if (res.active) {
            firstActive = i;
        } else if (res.queued) {
            await bot.sendMessage(userId, `${item.successText || '✅ 已发送'}\n🏷️ 已加入打标签队列（第 ${res.position} 个）`).catch(() => { });
        }
    }

    // 只有"立即激活"的那条把提示语交给面板；其余（含无描述的）由调用方发普通提示
    return captionedFlags.map((captioned, i) => captioned && i === firstActive);
}

// ---------------- 文本即标签 ----------------

/** 手动输入标签：不存在则自动创建；`-标签` 表示移除；空格 / 、 可一次多个 */
async function handleTagText(msg, session) {
    const userId = msg.from.id;
    const text = (msg.text || '').trim();
    const target = session.active;
    if (!target) return false;

    const { add, remove } = parseTagInput(text);
    if (!add.length && !remove.length) {
        await bot.sendMessage(userId, '❌ 未识别到标签（发送文本即为打标签，空格分隔可一次多个；-标签 表示移除）', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        }).catch(() => { });
        return true;
    }

    const allTags = await getTags();
    for (const rawName of add) {
        const name = rawName.toUpperCase(); // 标签名统一大写
        if (!allTags.some(t => t.name.toLowerCase() === name.toLowerCase())) {
            await addTag(name);
        }
        if (target.fileUniqueId) {
            await addTagToMessage(target.fileUniqueId, name);
        }
        await tagUsed(name, 1);
        await applyTagChangeToGroupTags(target.groupId, name, 1);
    }
    for (const rawName of remove) {
        const name = rawName.toUpperCase();
        if (target.fileUniqueId) {
            await removeTagFromMessage(target.fileUniqueId, name);
        }
        await tagUsed(name, -1);
        await applyTagChangeToGroupTags(target.groupId, name, -1);
    }
    // group_list.tags = 组内所有 message 标签的并集（与 message 集合保持一致）
    await syncGroupTags(target.groupId);

    const parts = [];
    if (add.length) parts.push(`已添加：${add.join('、')}`);
    if (remove.length) parts.push(`已移除：${remove.join('、')}`);
    logOperation({
        action: add.length ? 'tag_add' : 'tag_remove',
        source: 'private',
        userId,
        target: { type: target.fileUniqueId ? 'media' : 'media_group', id: target.fileUniqueId || target.groupId },
        counts: { tags: (add.length || remove.length), messages: target.fileUniqueId ? 1 : undefined },
        detail: { tags: add.length ? add : remove, mode: 'manual', via: 'send_reply_session' }
    }).catch(() => { });

    updateUserActivity(userId);
    await refreshPanel(userId);
    const currentTags = await currentTagsOf(target);
    const currentText = currentTags.length ? `\n📌 当前标签：${currentTags.join('、')}` : '\n📌 当前标签：（无）';
    await bot.sendMessage(userId, `✅ ${parts.join('；')}${currentText}`, {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
    }).catch(() => { });
    logger.info(`用户 ${userId} 打标签（文本输入）: ${parts.join('；')} -> group=${target.groupId}`);
    return true;
}

// ---------------- 回调处理（sendtag / sendtag_page / sendtag_done / sendtag_reply） ----------------

async function handleTagCallback(query) {
    const data = query.data;
    const userId = query.from.id;
    const messageId = query.message ? query.message.message_id : null;
    const session = getSession(userId);

    if (!session || !session.active) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 打标签已结束' }).catch(() => { });
        if (messageId) {
            await bot.editMessageText('✅ 标签已完成', { chat_id: userId, message_id: messageId }).catch(() => { });
        }
        return;
    }

    const target = session.active;
    // 面板消息 ID 以会话记录为准（回调可能来自旧面板）
    if (messageId && !session.panelMsgId) session.panelMsgId = messageId;

    // ---- 完成：队列还有则切到下一个，否则结束打标签（模式保持不退出） ----
    if (data === 'sendtag_done') {
        await bot.answerCallbackQuery(query.id, {
            text: session.queue.length ? `已切换到下一个（剩余 ${session.queue.length} 个）` : '完成'
        }).catch(() => { });
        const result = await advanceToNext(userId);
        logger.info(`用户 ${userId} 点击完成打标签: advanced=${result.advanced}, remaining=${result.remaining}`);
        return;
    }

    // ---- 回复该消息：结束当前打标签并进入消息回复模式 ----
    if (data === 'sendtag_reply') {
        if (!target.groupId) {
            await bot.answerCallbackQuery(query.id, { text: '❌ 缺少媒体组信息' }).catch(() => { });
            return;
        }
        const groupId = target.groupId;
        const fileUniqueId = target.fileUniqueId;
        const panelMsgId = session.panelMsgId || messageId;
        await bot.answerCallbackQuery(query.id, { text: '🔁 正在进入回复模式...' }).catch(() => { });
        clearTagSession(userId);
        if (panelMsgId) {
            await bot.editMessageText('🔁 已完成标签操作，正在进入回复模式...', {
                chat_id: userId,
                message_id: panelMsgId
            }).catch(() => { });
        }
        // 退出当前模式（send / edit 的 _onExit 与状态清理），再进入回复模式
        const rawState = getRawUserState(userId);
        if (rawState && rawState.mode !== 'message_reply') {
            if (rawState._onExit) await rawState._onExit(userId, rawState).catch(() => { });
            require('../states').deleteUserState(userId);
        }
        const { autoEnterReplyFromTag } = require('../modes/messageReplyMode');
        const result = await autoEnterReplyFromTag(userId, groupId, panelMsgId || -1, fileUniqueId);
        if (!result.ok) {
            await bot.sendMessage(userId, result.error).catch(() => { });
        }
        logger.info(`用户 ${userId} 打标签后点击回复该消息: group_id=${groupId}${fileUniqueId ? `, file=${fileUniqueId}` : ''}`);
        return;
    }

    // ---- 翻页 ----
    if (data.startsWith('sendtag_page:')) {
        const page = parseInt(data.split(':')[1], 10) || 1;
        await bot.answerCallbackQuery(query.id).catch(() => { });
        await refreshPanel(userId, page);
        return;
    }

    // ---- 标签按钮：已打上→移除，未打上→添加 ----
    if (data.startsWith('sendtag:')) {
        const tag = decodeURIComponent(data.split(':')[1]);
        const current = await currentTagsOf(target);
        const applied = current.includes(tag);
        if (applied) {
            if (target.fileUniqueId) {
                await removeTagFromMessage(target.fileUniqueId, tag);
            }
            await tagUsed(tag, -1);
            await applyTagChangeToGroupTags(target.groupId, tag, -1);
        } else {
            if (target.fileUniqueId) {
                await addTagToMessage(target.fileUniqueId, tag);
            }
            await tagUsed(tag, 1);
            await applyTagChangeToGroupTags(target.groupId, tag, 1);
        }
        await syncGroupTags(target.groupId);
        await bot.answerCallbackQuery(query.id, { text: `标签「${tag}」已${applied ? '移除' : '添加'}` }).catch(() => { });
        logOperation({
            action: applied ? 'tag_remove' : 'tag_add',
            source: 'private',
            userId,
            target: { type: target.fileUniqueId ? 'media' : 'media_group', id: target.fileUniqueId || target.groupId },
            counts: { tags: 1, messages: target.fileUniqueId ? 1 : undefined },
            detail: { tags: [tag], mode: 'button', via: 'send_reply_session' }
        }).catch(() => { });
        await refreshPanel(userId);
        logger.info(`用户 ${userId} 打标签（按钮）: ${applied ? '移除' : '添加'} ${tag} -> group=${target.groupId}${target.fileUniqueId ? `, file=${target.fileUniqueId}` : ''}`);
        return;
    }
}

/** 会话定时清理：只清理已无活动目标的空会话（有队列/有活动目标的会话保留） */
function cleanupIdleSessions(now = Date.now()) {
    for (const [userId, s] of tagSessions.entries()) {
        if (!s.active && (!s.queue || !s.queue.length)) {
            tagSessions.delete(userId);
            continue;
        }
        if (!s.active && s.updatedAt && now - s.updatedAt > SESSION_TTL) {
            tagSessions.delete(userId);
        }
    }
}

module.exports = {
    isTagging,
    getTagSession,
    clearTagSession,
    enqueueTagTarget,
    advanceToNext,
    showActivePanel,
    recordAndTag,
    recordMessageWithAutoTags,
    handleTagText,
    handleTagCallback,
    refreshPanel,
    cleanupIdleSessions
};
