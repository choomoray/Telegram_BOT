// handlers/modes/tagMode.js
/**
 * /tag 标签模式
 * 1. 修改消息标签：发送媒体 → 预览媒体组 → 展示现有标签 → 添加/删除模式（标签按钮直接操作，操作后刷新）
 * 2. 编辑标签：添加（发文本）/ 改名（选标签→发文本）/ 删除（选标签→确认），同步 message 集合
 */
const bot = require('../../bot');
const logger = require('../../logger');
const { findMediaByFileUniqueId } = require('../../db/media');
const { findMessageByFileUniqueId } = require('../../db/message');
const { getMediaByGroupIdSorted, sendMediaGroupAsReply } = require('../../media');
const { addTagToGroup, removeTagFromGroup, getGroupTags } = require('../../db/message');
const { getTags, addTag, removeTag, renameTag } = require('../../db/tags');
const { extractMediaFromMessage } = require('../../media');
const { setUserState, deleteUserState, updateUserActivity, getRawUserState } = require('../../states');

// ---------------- 键盘构建 ----------------

/** 按行构建标签按钮（prefix 为回调前缀，标签名 URL 编码） */
function buildTagButtons(tags, prefix, rowSize = 3) {
    const keyboard = [];
    for (let i = 0; i < tags.length; i += rowSize) {
        const row = [];
        for (let j = i; j < i + rowSize && j < tags.length; j++) {
            row.push({ text: tags[j], callback_data: `${prefix}:${encodeURIComponent(tags[j])}` });
        }
        keyboard.push(row);
    }
    return keyboard;
}

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

/** 修改消息标签：请选择操作（添加/删除 + 现有标签展示） */
async function showGroupTagSelect(userId, messageId, groupId) {
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
    await bot.editMessageText(`已找到，请选择操作：\n${tagText}`, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: keyboard
    }).catch(() => { });
}

/** 添加/删除标签模式界面 */
async function showGroupTagAction(userId, messageId, groupId, mode) {
    const tags = await getTags();
    const current = await getGroupTags(groupId);

    const title = mode === 'add' ? '➕ 正在添加标签（点击即添加）' : '🗑️ 正在删除标签（点击即删除）';
    let available = [];
    if (mode === 'add') {
        available = tags.filter(t => !current.includes(t));
    } else {
        available = current;
    }

    const keyboard = [];
    if (available.length) {
        keyboard.push(...buildTagButtons(available, 'tagmsg:tag', 2));
    }
    keyboard.push([{ text: '↩️ 返回选择', callback_data: 'tagmsg:back' }]);

    const tagText = current.length ? `📌 现有标签：${current.join('、')}` : '📌 现有标签：（无）';
    const hint = mode === 'add'
        ? (available.length ? `可添加：${available.join('、')}` : '（没有可添加的标签）')
        : (available.length ? `可删除：${available.join('、')}` : '（没有可删除的标签）');
    await bot.editMessageText(`${title}\n${tagText}\n${hint}`, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
    }).catch(() => { });
}

/** 编辑标签菜单 */
async function showEditTagMenu(userId, messageId) {
    const tags = await getTags();
    const keyboard = {
        inline_keyboard: [
            [
                { text: '➕ 添加标签', callback_data: 'tagedit:add' },
                { text: '✏️ 修改标签', callback_data: 'tagedit:rename' },
                { text: '🗑️ 删除标签', callback_data: 'tagedit:del' }
            ],
            [
                { text: '↩️ 返回', callback_data: 'tagedit:back' }
            ]
        ]
    };
    const tagText = tags.length ? `📌 当前标签：${tags.join('、')}` : '📌 当前标签：（无）';
    await bot.editMessageText(`标签管理：\n${tagText}`, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: keyboard
    }).catch(() => { });
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
            } else {
                await removeTagFromGroup(groupId, tag);
            }
            await bot.answerCallbackQuery(query.id, { text: `标签「${tag}」已${mode === 'add' ? '添加' : '移除'}` });
            logger.info(`用户 ${userId} 修改消息标签: ${mode} ${tag} -> group=${groupId}`);
            // 操作后刷新
            await showGroupTagAction(userId, messageId, groupId, mode);
            return;
        }
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
        if (action === 'rename' || action === 'del') {
            const tags = await getTags();
            if (!tags.length) {
                await bot.answerCallbackQuery(query.id, { text: '❌ 暂无标签' });
                return;
            }
            if (state) {
                setUserState(userId, { ...state, pendingEditAction: action, lastActivity: Date.now() });
            }
            const keyboard = {
                inline_keyboard: [
                    ...buildTagButtons(tags, 'tagedit:pick', 3),
                    [{ text: '↩️ 返回', callback_data: 'tagedit:back' }]
                ]
            };
            const text = action === 'rename' ? '✏️ 请选择要修改的标签：' : '🗑️ 请选择要删除的标签：';
            await bot.editMessageText(text, {
                chat_id: userId,
                message_id: messageId,
                reply_markup: keyboard
            });
            await bot.answerCallbackQuery(query.id);
            return;
        }
        if (action === 'pick') {
            const tag = decodeURIComponent(parts[2]);
            const step = state ? state.step : 'menu';
            // 需要知道是 rename 还是 del：从消息文本判断不可靠，用 step 记录
            // rename/del 选择时，把 pending 操作记录到 state
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
}

// ---------------- 模式消息处理 ----------------

async function handleTagMode(msg, state) {
    const userId = msg.from.id;
    updateUserActivity(userId);
    const userMsgId = msg.message_id;

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

            // 回复选择操作
            await showGroupTagSelect(userId, processingMsg.message_id, groupId);
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
