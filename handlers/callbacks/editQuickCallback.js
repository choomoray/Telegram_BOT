// handlers/callbacks/editQuickCallback.js
/**
 * 私聊 /edit 流程里「找到了」消息下的两个快捷按钮：
 *   edit_clear —— 清空描述（等价于发送 /null）：清 Telegram caption + 删 message 记录 + 清空该 message 标签
 *   edit_exit  —— 退出编辑模式
 *
 * 位置不可编辑（超 48 小时 / 不是机器人发送的转发副本）时，清空同样走统一的
 * 「是否只更改数据库中的描述」确认流程（editConfirmDbOnly），与手动输入文本的路径一致。
 */
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { getRawUserState, setUserState, deleteUserState } = require('../../states');
const { logOperation } = require('../../utils/opLog');
const { getModeName } = require('../../utils/modeNames');
const { editCaptionWithFallback, isEditTargetError } = require('../../utils/editTarget');
const { clearMessageTags } = require('../../utils/tagSync');

/** 当前是否处于可快捷操作的编辑状态（等待文本 / 等待确认仅改库） */
function getEditableState(userId) {
    const state = getRawUserState(userId);
    if (!state || state.mode !== 'edit') return null;
    if (state.step !== 'waiting_for_text' && state.step !== 'confirm_db_only') return null;
    return state;
}

/** 状态里的候选编辑位置（旧状态只有单个目标位置时兜底） */
function resolveTargets(state) {
    if (Array.isArray(state.editTargets) && state.editTargets.length) return state.editTargets;
    return [{ chatId: state.targetChatId, messageId: state.targetMessageId, via: 'legacy' }];
}

/** 清空描述 */
async function handleEditClear(query) {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const state = getEditableState(userId);

    if (!state || !state.targetFileUniqueId) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 操作已过期，请重新 /edit' });
        return;
    }

    const editTargets = resolveTargets(state);
    const messageCol = getCollection(COLLECTIONS.MESSAGE);
    const { updateMessageDb } = require('../modes/editMode');

    // 1) Telegram 侧清空 caption（频道源位置优先，位置不可用则换下一处）
    let edited = null;
    try {
        edited = await editCaptionWithFallback(editTargets, (t) =>
            bot.editMessageCaption('', { chat_id: t.chatId, message_id: t.messageId })
        );
    } catch (err) {
        if (isEditTargetError(err)) {
            // 位置改不了（超 48 小时 / 不是机器人发送的）：交给统一的「仅更新数据库」确认流程
            setUserState(userId, {
                ...state,
                step: 'confirm_db_only',
                pendingEdit: { isClearing: true, cleanText: '' },
                lastActivity: Date.now()
            });
            await bot.editMessageText(
                `⚠️ 消息已超过编辑时效（48小时），无法修改 Telegram 上的描述。\n是否只更改数据库中的描述？`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ 仅更新数据库', callback_data: `edit_dbonly:${state.targetGroupId}` },
                            { text: '❌ 取消', callback_data: 'edit_dbonly_cancel' }
                        ]]
                    }
                }
            ).catch(() => { });
            await bot.answerCallbackQuery(query.id, { text: '⚠️ 消息无法编辑' });
            logger.info(`用户 ${userId} 快捷清空描述失败（位置不可用），已询问是否仅更新数据库`);
            return;
        }
        logger.error(`快捷清空描述失败: ${err.message}`);
        await bot.editMessageText('❌ 清空失败，请稍后重试', {
            chat_id: chatId,
            message_id: messageId
        }).catch(() => { });
        await bot.answerCallbackQuery(query.id, { text: '❌ 清空失败' });
        return;
    }

    // 2) 清空描述 = 移除该 message 的标签：必须先清标签（此时 message 记录还在，才能递减标签使用次数），
    //    再删 message 记录；编辑描述则保留标签
    const target = edited || editTargets[0];
    if (state.targetFileUniqueId) {
        await clearMessageTags(state.targetFileUniqueId);
    }

    // 3) 数据库：删除该条 message 记录 + 重算 group_list.is_delete（updateMessageDb 内统一处理）
    try {
        await updateMessageDb(messageCol, {
            isClearing: true,
            targetChatId: target.chatId,
            targetMessageId: target.messageId,
            targetGroupId: state.targetGroupId,
            targetFileUniqueId: state.targetFileUniqueId,
            targetMediaType: state.targetMediaType,
            cleanText: ''
        });
    } catch (err) {
        logger.error(`快捷清空描述更新数据库失败: ${err.message}`);
        await bot.editMessageText('❌ 更新数据库失败，请稍后重试', {
            chat_id: chatId,
            message_id: messageId
        }).catch(() => { });
        await bot.answerCallbackQuery(query.id, { text: '❌ 更新失败' });
        return;
    }

    await bot.editMessageText('✅ 已清空描述', {
        chat_id: chatId,
        message_id: messageId
    }).catch(() => { });
    await bot.answerCallbackQuery(query.id, { text: '✅ 已清空描述' });
    logOperation({
        action: 'media_edit',
        source: 'private',
        userId,
        chatId,
        messageId,
        target: { type: 'media', id: state.targetFileUniqueId },
        counts: { edits: 1 },
        detail: {
            via: 'private_clear_button',
            clearing: true,
            groupId: state.targetGroupId,
            targetChatId: target.chatId,
            targetMessageId: target.messageId,
            editVia: target.via
        }
    }).catch(() => { });
    deleteUserState(userId);
    logger.info(`用户 ${userId} 通过快捷按钮清空描述: ${target.chatId}/${target.messageId} (via=${target.via})`);
}

/** 退出编辑模式 */
async function handleEditExit(query) {
    const userId = query.from.id;
    const state = getEditableState(userId) || getRawUserState(userId);
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (state && typeof state._onExit === 'function') {
        try {
            await state._onExit(userId, state);
        } catch (err) {
            logger.warn(`退出编辑模式清理失败: ${err.message}`);
        }
    }
    const modeName = getModeName(state && state.mode ? state.mode : 'edit');
    deleteUserState(userId);

    await bot.editMessageText(`🚪 已退出${modeName}`, {
        chat_id: chatId,
        message_id: messageId
    }).catch(() => { });
    await bot.answerCallbackQuery(query.id, { text: '已退出' });
    logger.info(`用户 ${userId} 通过快捷按钮退出编辑模式`);
}

module.exports = { handleEditClear, handleEditExit };
