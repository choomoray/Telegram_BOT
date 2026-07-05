// handlers/callbacks/editConfirmDbOnly.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { setGroupDelete } = require('../../db/groupList');
const { getRawUserState, deleteUserState } = require('../../states');

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
    const { isClearing, cleanText, level } = state.pendingEdit;
    const messageCol = getCollection(COLLECTIONS.MESSAGE);

    try {
        if (isClearing) {
            const existing = await messageCol.findOne({ chat_id: targetChatId, message_id: targetMessageId });
            if (existing) {
                await messageCol.deleteOne({ chat_id: targetChatId, message_id: targetMessageId });
                const otherMessages = await messageCol.countDocuments({ group_id: targetGroupId });
                if (otherMessages === 0) {
                    await setGroupDelete(targetGroupId, Date.now());
                } else {
                    await setGroupDelete(targetGroupId, 0);
                }
            }
        } else {
            const existing = await messageCol.findOne({ chat_id: targetChatId, message_id: targetMessageId });
            if (existing) {
                await messageCol.updateOne(
                    { chat_id: targetChatId, message_id: targetMessageId },
                    { $set: { text: cleanText, level } }
                );
            } else {
                await messageCol.insertOne({
                    chat_id: targetChatId,
                    message_id: targetMessageId,
                    text: cleanText,
                    file_unique_id: targetFileUniqueId,
                    media_type: targetMediaType,
                    level,
                    group_id: targetGroupId
                });
            }
            await setGroupDelete(targetGroupId, 0);
        }

        await bot.editMessageText('✅ 数据库已更新', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
        }).catch(() => {});

        await bot.answerCallbackQuery(query.id, { text: '✅ 数据库已更新' });
        logger.info(`用户 ${userId} 确认仅更新数据库: group_id=${targetGroupId}`);
    } catch (err) {
        logger.error(`更新数据库失败: ${err.message}`);
        await bot.editMessageText('❌ 更新数据库失败，请稍后重试', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
        }).catch(() => {});
        await bot.answerCallbackQuery(query.id, { text: '❌ 更新失败' });
    }

    deleteUserState(userId);
}

module.exports = handleEditConfirmDbOnly;
