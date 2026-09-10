// handlers/callbacks/editConfirmDbOnly.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { syncGroupDeleteByText } = require('../../db/groupList');
const { getRawUserState, deleteUserState } = require('../../states');
const { logOperation } = require('../../utils/opLog');

async function handleEditConfirmDbOnly(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts.length !== 2 || parts[0] !== 'edit_dbonly') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const userId = query.from.id;
    const state = getRawUserState(userId);
    if (!state || state.mode !== 'edit' || state.step !== 'confirm_db_only' || !state.pendingEdit) {
        await bot.answerCallbackQuery(query.id, { text: '❌ 操作已过期，请重新编辑' });
        return;
    }

    const { targetChatId, targetMessageId, targetGroupId, targetFileUniqueId, targetMediaType } = state;
    const { isClearing, cleanText } = state.pendingEdit;
    const messageCol = getCollection(COLLECTIONS.MESSAGE);

    try {
        if (isClearing) {
            const existing = await messageCol.findOne({ chat_id: targetChatId, message_id: targetMessageId });
            if (existing) {
                await messageCol.deleteOne({ chat_id: targetChatId, message_id: targetMessageId });
                // 描述清空后按组内剩余文本统一重算（还有文本 → 0；已无文本 → 时间戳可清理）
                await syncGroupDeleteByText(targetGroupId);
            }
            // 标签跟随文本：清空该 message 的标签
            if (targetFileUniqueId) {
                const { clearMessageTags } = require('../../utils/tagSync');
                await clearMessageTags(targetFileUniqueId);
            }
        } else {
            const existing = await messageCol.findOne({ chat_id: targetChatId, message_id: targetMessageId });
            if (existing) {
                await messageCol.updateOne(
                    { chat_id: targetChatId, message_id: targetMessageId },
                    { $set: { text: cleanText, updated_at: Date.now() } }
                );
            } else {
                await messageCol.insertOne({
                    chat_id: targetChatId,
                    message_id: targetMessageId,
                    text: cleanText,
                    file_unique_id: targetFileUniqueId,
                    media_type: targetMediaType,
                    group_id: targetGroupId,
                    updated_at: Date.now()
                });
            }
            await syncGroupDeleteByText(targetGroupId);
            // 标签跟随文本：按新文本重算该 message 的标签
            if (targetFileUniqueId) {
                const { reMatchMessageTags } = require('../../utils/tagSync');
                await reMatchMessageTags(targetFileUniqueId, cleanText);
            }
        }

        await bot.editMessageText('✅ 数据库已更新', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
        }).catch(() => {});

        await bot.answerCallbackQuery(query.id, { text: '✅ 数据库已更新' });
        // 超过 48 小时降级为「仅更新数据库」：同样是一次成功的编辑操作，单独留痕
        logOperation({
            action: 'media_edit',
            source: 'private',
            userId,
            chatId: query.message.chat.id,
            messageId: query.message.message_id,
            target: { type: 'media', id: targetFileUniqueId },
            counts: { edits: 1 },
            detail: {
                via: 'db_only',
                over48h: true,
                mediaType: targetMediaType,
                groupId: targetGroupId,
                targetChatId,
                targetMessageId,
                after: cleanText,
                textLength: cleanText ? cleanText.length : 0
            }
        }).catch(() => { });
        logger.info(`用户 ${userId} 确认仅更新数据库: group_id=${targetGroupId}`);
    } catch (err) {
        logger.error(`更新数据库失败: ${err.message}`);
        logOperation({
            action: 'media_edit',
            result: 'fail',
            source: 'private',
            userId,
            chatId: query.message.chat.id,
            messageId: query.message.message_id,
            target: { type: 'media', id: targetFileUniqueId },
            detail: { via: 'db_only', over48h: true, mediaType: targetMediaType },
            error: err.message
        }).catch(() => { });
        await bot.editMessageText('❌ 更新数据库失败，请稍后重试', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
        }).catch(() => {});
        await bot.answerCallbackQuery(query.id, { text: '❌ 更新失败' });
    }

    deleteUserState(userId);
}

module.exports = handleEditConfirmDbOnly;
