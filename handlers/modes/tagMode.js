// handlers/modes/tagMode.js
/**
 * /tag 标签模式
 * 1. 修改消息标签：发送媒体 → 预览媒体组 → 展示现有标签 → 添加/删除模式
 *    （标签按钮直接操作或手动输入，操作后刷新；标签按钮翻页 10 行/页）
 * 2. 编辑标签：添加（发文本）/ 改名（选标签→发文本）/ 删除（选标签）/ 固定置顶，
 *    修改与删除同步 message 集合
 */
const bot = require('../../bot');
const logger = require('../../logger');
const { findMediaByFileUniqueId } = require('../../db/media');
const { findMessageByFileUniqueId } = require('../../db/message');
const { getMediaByGroupIdSorted, sendMediaGroupAsReply } = require('../../media');
const { addTagToGroup, removeTagFromGroup, getGroupTags } = require('../../db/message');
const { getTags, sortTags, addTag, removeTag, renameTag, setTagImportant, tagUsed } = require('../../db/tags');
const { buildTagKeyboard, splitTagInput } = require('../../utils/tagUi');
const { extractMediaFromMessage } = require('../../media');
const { setUserState, deleteUserState, updateUserActivity, getRawUserState } = require('../../states');

// ---------------- 菜单 ----------------

async function showTagMenu(userId, messageId) {
    const keyboard = {
        inline_keyboard: [
            [
                { text: '1️⃣ 修改消息标签', callback_data: 'tagm:editmsg' },
                { text: '2️⃣ 编辑标签', callback_data: 'tagm:edittag' }
            ],
            [
                { text: '🚪 退出', callback_data: 'tagm:exit' }
            ]
        ]
    };
    const text = '📌 已进入标签模式\n请选择操作：';
    if (messageId && messageId !== -1) {
        await bot.editMessageText(text, {
            chat_id: userId,
            message_id: messageId,
            reply_markup: keyboard
        }).catch(async () => {
            await bot.sendMessage(userId, text, { reply_markup: keyboard });
        });
    } else {
        await bot.sendMessage(userId, text, { reply_markup: keyboard });
    }
}

/** 修改消息标签：请选择操作（添加/删除 + 现有标签展示），并记录按钮消息 ID */
async function showGroupTagSelect(userId, messageId, groupId, asNew = false) {
    const current = await getGroupTags(groupId);
    const keyboard = {
        inline_keyboard: [
            [
                { text: '🏷️ 添加标签', callback_data: 'tagmsg:add' },
                { text: '🗑️ 删除标签', callback_data: 'tagmsg:del' }
            ]
        ]
    };
    const tagText = current.length ? `📌 现有标签：${current.join('、')}` : '📌 现有标签：（无）';
    const text = `已找到，请选择操作：\n${tagText}`;
    let tagMsgId = messageId;
    if (asNew) {
        // 在预览媒体组之后发送一条新消息来放置操作按钮
        const sent = await bot.sendMessage(userId, text, { reply_markup: keyboard });
        tagMsgId = sent.message_id;
    } else {
        await bot.editMessageText(text, {
            chat_id: userId,
            message_id: messageId,
            reply_markup: keyboard
        }).catch(() => { });
    }
    const st = getRawUserState(userId);
    if (st && st.mode === 'tag') {
        setUserState(userId, { ...st, tagMsgId, lastActivity: Date.now() });
    }
}

/** 添加/删除标签模式界面（标签按钮翻页 10 行/页，手动输入同样可用） */
async function showGroupTagAction(userId, messageId, groupId, mode, page = 1) {
    const tags = sortTags(await getTags());
    const current = await getGroupTags(groupId);

    const title = mode === 'add'
        ? '➕ 正在添加标签（点击按钮或发送文本，空格/、分隔）'
        : '🗑️ 正在删除标签（点击按钮或发送文本，空格/、分隔）';

    let available = [];
    if (mode === 'add') {
        available = tags.filter(t => !current.includes(t.name));
    } else {
        available = current.map(n => ({ name: n, important: false, count: 0 }));
    }

    const result = buildTagKeyboard(available, {
        prefix: 'tagmsg:tag',
        pagePrefix: 'tagmsg_page',
        page,
        extraRows: [[{ text: '↩️ 返回选择', callback_data: 'tagmsg:back' }]]
    });

    const tagText = current.length ? `📌 现有标签：${current.join('、')}` : '📌 现有标签：（无）';
    const hint = mode === 'add'
        ? (available.length ? `共 ${available.length} 个可添加标签` : '（没有可添加的标签）')
        : (available.length ? `共 ${available.length} 个可删除标签` : '（没有可删除的标签）');
    await bot.editMessageText(`${title}\n${tagText}\n${hint}`, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: result
    }).catch(() => { });

    const st = getRawUserState(userId);
    if (st && st.mode === 'tag') {
        setUserState(userId, { ...st, tagMsgId: messageId, lastActivity: Date.now() });
    }
}

/** 编辑标签菜单 */
async function showEditTagMenu(userId, messageId) {
    const tags = sortTags(await getTags());
    const keyboard = {
        inline_keyboard: [
            [
                { text: '➕ 添加标签', callback_data: 'tagedit:add' },
                { text: '✏️ 修改标签', callback_data: 'tagedit:rename' },
                { text: '🗑️ 删除标签', callback_data: 'tagedit:del' }
            ],
            [
                { text: '⭐ 固定置顶', callback_data: 'tagedit:pin' },
                { text: '↩️ 返回', callback_data: 'tagedit:back' }
            ]
        ]
    };
    const tagText = tags.length
        ? `📌 当前标签：\n${tags.map(t => `${t.important ? '⭐' : '·'} ${t.name}（${t.count}次）`).join('\n')}`
        : '📌 当前标签：（无）';
    await bot.editMessageText(`标签管理：\n${tagText}`, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: keyboard
    }).catch(() => { });

    const st = getRawUserState(userId);
    if (st && st.mode === 'tag') {
        setUserState(userId, { ...st, tagMsgId: messageId, lastActivity: Date.now() });
    }
}

/** 标签选择列表（改名/删除/固定共用，翻页） */
async function showTagPickList(userId, messageId, action, page = 1) {
    const tags = sortTags(await getTags());
    if (!tags.length) {
        await bot.answerCallbackQuery(undefined, { text: '❌ 暂无标签' });
        return;
    }
    const titles = {
        rename: '✏️ 请选择要修改的标签：',
        del: '🗑️ 请选择要删除的标签：',
        pin: '⭐ 请选择要固定/取消固定的标签：'
    };
    const result = buildTagKeyboard(tags, {
        prefix: 'tagedit:pick',
        pagePrefix: 'tagedit_page',
        page,
        extraRows: [[{ text: '↩️ 返回', callback_data: 'tagedit:back' }]]
    });
    await bot.editMessageText(titles[action] || '请选择标签：', {
        chat_id: userId,
        message_id: messageId,
        reply_markup: result
    }).catch(() => { });

    const st = getRawUserState(userId);
    if (st && st.mode === 'tag') {
        setUserState(userId, { ...st, tagMsgId: messageId, lastActivity: Date.now() });
    }
}

// ---------------- 回调处理 ----------------

async function handleCallback(query) {
    const data = query.data;
    const userId = query.from.id;
    const messageId = query.message.message_id;
    const parts = data.split(':');
    const prefix = parts[0];
    const rawState = getRawUserState(userId);
    const state = rawState && rawState.mode === 'tag' ? rawState : null;

    // ---- 主菜单 ----
    if (prefix === 'tagm') {
        const action = parts[1];
        if (action === 'exit') {
            deleteUserState(userId);
            await bot.editMessageText('🚪 已退出标签模式', { chat_id: userId, message_id: messageId });
            await bot.answerCallbackQuery(query.id, { text: '已退出' });
            logger.info(`用户 ${userId} 退出标签模式`);
            return;
        }
        if (action === 'editmsg') {
            if (state) setUserState(userId, { ...state, step: 'waiting_media', groupId: null, groupTagMode: null, lastActivity: Date.now() });
            await bot.editMessageText('📤 请发送媒体消息（用于定位要打标签的媒体组）：', {
                chat_id: userId,
                message_id: messageId
            });
            await bot.answerCallbackQuery(query.id);
            return;
        }
        if (action === 'edittag') {
            if (state) setUserState(userId, { ...state, step: 'menu', pendingEditAction: null, lastActivity: Date.now() });
            await bot.answerCallbackQuery(query.id);
            await showEditTagMenu(userId, messageId);
            return;
        }
        await bot.answerCallbackQuery(query.id);
        return;
    }

    // ---- 修改消息标签操作 ----
    if (prefix === 'tagmsg') {
        const action = parts[1];
        const groupId = state ? state.groupId : null;
        if (!groupId) {
            await bot.answerCallbackQuery(query.id, { text: '❌ 请先发送媒体消息' });
            return;
        }

        if (action === 'add') {
            if (state) setUserState(userId, { ...state, groupTagMode: 'add', lastActivity: Date.now() });
            await bot.answerCallbackQuery(query.id);
            await showGroupTagAction(userId, messageId, groupId, 'add');
            return;
        }
        if (action === 'del') {
            if (state) setUserState(userId, { ...state, groupTagMode: 'del', lastActivity: Date.now() });
            await bot.answerCallbackQuery(query.id);
            await showGroupTagAction(userId, messageId, groupId, 'del');
            return;
        }
        if (action === 'back') {
            if (state) setUserState(userId, { ...state, groupTagMode: null, lastActivity: Date.now() });
            await bot.answerCallbackQuery(query.id);
            await showGroupTagSelect(userId, messageId, groupId);
            return;
        }
        if (action === 'tag') {
            const tag = decodeURIComponent(parts[2]);
            const mode = state && state.groupTagMode ? state.groupTagMode : 'add';
            if (mode === 'add') {
                await addTagToGroup(groupId, tag);
                await tagUsed(tag, 1);
            } else {
                await removeTagFromGroup(groupId, tag);
                await tagUsed(tag, -1);
            }
            await bot.answerCallbackQuery(query.id, { text: `标签「${tag}」已${mode === 'add' ? '添加' : '移除'}` });
            logger.info(`用户 ${userId} 修改消息标签: ${mode} ${tag} -> group=${groupId}`);
            // 操作后刷新
            await showGroupTagAction(userId, messageId, groupId, mode);
            return;
        }
    }

    // ---- 修改消息标签：翻页 ----
    if (prefix === 'tagmsg_page') {
        const page = parseInt(parts[1], 10) || 1;
        const groupId = state ? state.groupId : null;
        const mode = state ? state.groupTagMode : 'add';
        if (!groupId) {
            await bot.answerCallbackQuery(query.id, { text: '❌ 请先发送媒体消息' });
            return;
        }
        await bot.answerCallbackQuery(query.id);
        await showGroupTagAction(userId, messageId, groupId, mode || 'add', page);
        return;
    }

    // ---- 编辑标签 ----
    if (prefix === 'tagedit') {
        const action = parts[1];
        if (action === 'add') {
            if (state) setUserState(userId, { ...state, step: 'add_tag', lastActivity: Date.now() });
            await bot.editMessageText('➕ 请发送新标签名称：', { chat_id: userId, message_id: messageId });
            await bot.answerCallbackQuery(query.id);
            return;
        }
        if (action === 'rename' || action === 'del' || action === 'pin') {
            if (state) {
                setUserState(userId, { ...state, pendingEditAction: action, lastActivity: Date.now() });
            }
            await bot.answerCallbackQuery(query.id);
            await showTagPickList(userId, messageId, action);
            return;
        }
        if (action === 'pick') {
            const tag = decodeURIComponent(parts[2]);
            const pendingAction = state && state.pendingEditAction;
            if (pendingAction === 'rename') {
                if (state) setUserState(userId, { ...state, step: 'rename_tag', pendingRenameTag: tag, lastActivity: Date.now() });
                await bot.editMessageText(`✏️ 请发送「${tag}」的新名称：`, { chat_id: userId, message_id: messageId });
                await bot.answerCallbackQuery(query.id);
            } else if (pendingAction === 'del') {
                const result = await removeTag(tag);
                if (result.ok) {
                    await bot.editMessageText(`✅ 已删除标签「${tag}」\n并同步清理了 ${result.synced || 0} 条消息中的该标签`, {
                        chat_id: userId,
                        message_id: messageId
                    });
                    await bot.answerCallbackQuery(query.id, { text: '已删除' });
                    logger.info(`用户 ${userId} 删除标签: ${tag}`);
                } else {
                    await bot.answerCallbackQuery(query.id, { text: result.error || '删除失败' });
                }
            } else if (pendingAction === 'pin') {
                const current = await getTags();
                const t = current.find(x => x.name.toLowerCase() === tag.toLowerCase());
                const nextImportant = t ? !t.important : false;
                const result = await setTagImportant(tag, nextImportant);
                if (result.ok) {
                    await bot.editMessageText(`✅ 标签「${tag}」已${nextImportant ? '设为重要（固定置顶）' : '取消固定'}`, {
                        chat_id: userId,
                        message_id: messageId
                    });
                    await bot.answerCallbackQuery(query.id, { text: nextImportant ? '已固定' : '已取消固定' });
                    logger.info(`用户 ${userId} 设置标签固定: ${tag} -> ${nextImportant}`);
                } else {
                    await bot.answerCallbackQuery(query.id, { text: result.error || '操作失败' });
                }
            } else {
                await bot.answerCallbackQuery(query.id, { text: '❌ 请先选择操作' });
            }
            return;
        }
        if (action === 'back') {
            if (state) setUserState(userId, { ...state, step: 'menu', pendingEditAction: null, lastActivity: Date.now() });
            await bot.answerCallbackQuery(query.id);
            await showEditTagMenu(userId, messageId);
            return;
        }
        await bot.answerCallbackQuery(query.id);
        return;
    }

    // ---- 编辑标签：翻页 ----
    if (prefix === 'tagedit_page') {
        const page = parseInt(parts[1], 10) || 1;
        const action = state ? state.pendingEditAction : 'rename';
        await bot.answerCallbackQuery(query.id);
        await showTagPickList(userId, messageId, action || 'rename', page);
        return;
    }
}

// ---------------- 模式消息处理 ----------------

async function handleTagMode(msg, state) {
    const userId = msg.from.id;
    updateUserActivity(userId);
    const userMsgId = msg.message_id;

    // 修改消息标签的添加/删除模式：手动输入标签（空格/、分隔）
    if (state.groupId && state.groupTagMode && msg.text &&
        !msg.photo && !msg.video && !msg.audio && !msg.document) {
        const names = splitTagInput(msg.text);
        if (names.length) {
            const allTags = await getTags();
            for (const name of names) {
                const exists = allTags.some(t => t.name.toLowerCase() === name.toLowerCase());
                if (!exists) await addTag(name);
                if (state.groupTagMode === 'add') {
                    await addTagToGroup(state.groupId, name);
                    await tagUsed(name, 1);
                } else {
                    await removeTagFromGroup(state.groupId, name);
                    await tagUsed(name, -1);
                }
            }
            // 刷新当前模式界面
            if (state.tagMsgId) {
                await showGroupTagAction(userId, state.tagMsgId, state.groupId, state.groupTagMode);
            }
            await bot.sendMessage(userId, `✅ 已${state.groupTagMode === 'add' ? '添加' : '移除'}标签：${names.join('、')}`, {
                reply_to_message_id: userMsgId
            });
        } else {
            await bot.sendMessage(userId, '❌ 未识别到标签', { reply_to_message_id: userMsgId });
        }
        return true;
    }

    // 编辑标签：等待输入新标签名 / 新名字
    if (state.step === 'add_tag') {
        const name = (msg.text || '').trim();
        if (!name) {
            await bot.sendMessage(userId, '❌ 请发送文本作为标签名称', { reply_to_message_id: userMsgId });
            return true;
        }
        const result = await addTag(name);
        await bot.sendMessage(userId, result.ok ? `✅ 标签「${name}」已添加` : `❌ ${result.error}`, {
            reply_to_message_id: userMsgId
        });
        if (result.ok) logger.info(`用户 ${userId} 添加标签: ${name}`);
        if (state) setUserState(userId, { ...state, step: 'menu', lastActivity: Date.now() });
        return true;
    }

    if (state.step === 'rename_tag') {
        const newName = (msg.text || '').trim();
        if (!newName) {
            await bot.sendMessage(userId, '❌ 请发送文本作为新名称', { reply_to_message_id: userMsgId });
            return true;
        }
        const oldName = state.pendingRenameTag;
        const result = await renameTag(oldName, newName);
        await bot.sendMessage(userId, result.ok
            ? `✅ 标签「${oldName}」已改名为「${newName}」\n并同步修改了 ${result.synced || 0} 条消息中的标签`
            : `❌ ${result.error}`, {
            reply_to_message_id: userMsgId
        });
        if (result.ok) logger.info(`用户 ${userId} 重命名标签: ${oldName} -> ${newName}`);
        if (state) setUserState(userId, { ...state, step: 'menu', pendingRenameTag: null, lastActivity: Date.now() });
        return true;
    }

    // 修改消息标签：等待媒体
    if (state.step === 'waiting_media') {
        const mediaInfo = extractMediaFromMessage(msg);
        if (!mediaInfo) {
            await bot.sendMessage(userId, '❌ 请发送媒体消息（图片/视频/音频/文档）', {
                reply_to_message_id: userMsgId
            });
            return true;
        }

        let processingMsg;
        try {
            processingMsg = await bot.sendMessage(userId, '🔍 正在查找媒体组...', {
                reply_to_message_id: userMsgId,
                allow_sending_without_reply: true
            });
        } catch (err) {
            logger.error(`发送查找中消息失败: ${err.message}`);
            return true;
        }

        try {
            // 查找媒体所在组
            let groupId = null;
            const mediaDoc = await findMediaByFileUniqueId(mediaInfo.fileUniqueId);
            if (mediaDoc) {
                groupId = mediaDoc.group_id;
            } else {
                const msgDoc = await findMessageByFileUniqueId(mediaInfo.fileUniqueId);
                if (msgDoc) groupId = msgDoc.group_id;
            }

            if (!groupId) {
                await bot.editMessageText('❌ 未找到该媒体，请确认已收录', {
                    chat_id: userId,
                    message_id: processingMsg.message_id
                });
                return true;
            }

            // 预览媒体组
            const mediaList = await getMediaByGroupIdSorted(groupId);
            if (mediaList.length) {
                const previewItems = mediaList.map(m => ({
                    type: m.media_type,
                    fileId: m.file_id,
                    caption: m.caption || undefined,
                    has_spoiler: false
                }));
                await sendMediaGroupAsReply(userId, null, previewItems, 10).catch(err => {
                    logger.warn(`预览媒体组失败: ${err.message}`);
                });
            }

            if (state) {
                setUserState(userId, { ...state, groupId, groupTagMode: null, lastActivity: Date.now() });
            }

            await bot.editMessageText('✅ 已找到媒体组', {
                chat_id: userId,
                message_id: processingMsg.message_id
            }).catch(() => { });

            // 在预览媒体组下方发送一条新消息来放置操作按钮
            await showGroupTagSelect(userId, null, groupId, true);
            logger.info(`用户 ${userId} 定位媒体组: ${groupId}`);
        } catch (err) {
            logger.error(`定位媒体组失败: ${err.message}`);
            await bot.editMessageText('❌ 处理失败，请稍后重试', {
                chat_id: userId,
                message_id: processingMsg.message_id
            });
        }
        return true;
    }

    // 其他情况忽略
    return true;
}

module.exports = {
    handleTagMode,
    handleCallback,
    showTagMenu
};
