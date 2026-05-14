// handlers/callbacks/cleanCallback.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { deleteUserState, setUserState, getRawUserState } = require('../../states');
const { sendNextBatch } = require('../cleanHelpers');

/**
 * 执行实际的清理操作
 * @param {string} action - 'week', 'month', 'all'
 * @param {Object} query - 回调查询对象
 * @param {number} userId - 用户ID
 * @param {number} chatId - 聊天ID
 * @param {number} messageId - 消息ID
 */
async function executeClean(action, query, userId, chatId, messageId) {
    await bot.answerCallbackQuery(query.id, { text: '⏳ 正在清理数据...' });

    try {
        const groupListCol = getCollection(COLLECTIONS.GROUP_LIST);
        const mediaCol = getCollection(COLLECTIONS.MEDIA);
        const now = Date.now();

        let timeCondition, timeText;
        if (action === 'week') {
            timeCondition = { $lte: now - 7 * 24 * 60 * 60 * 1000 };
            timeText = '一周之前';
        } else if (action === 'month') {
            timeCondition = { $lte: now - 30 * 24 * 60 * 60 * 1000 };
            timeText = '一个月之前';
        } else if (action === 'all') {
            timeCondition = { $gt: 0 };
            timeText = '全部';
        } else {
            return;
        }

        const groupDocs = await groupListCol.find({ is_delete: timeCondition }).toArray();
        const groupIds = groupDocs.map(doc => doc.group_id);
        const count = groupDocs.length;

        if (count === 0) {
            await bot.editMessageText('✅ 没有找到符合条件的空数据', {
                chat_id: chatId,
                message_id: messageId
            });
            logger.info(`用户 ${userId} 清理空数据: 无数据，条件 ${action}`);
            deleteUserState(userId);
            return;
        }

        if (groupIds.length > 0) {
            await mediaCol.deleteMany({ group_id: { $in: groupIds } });
        }
        await groupListCol.deleteMany({ group_id: { $in: groupIds } });

        await bot.editMessageText(`✅ ${timeText}空数据删除成功`, {
            chat_id: chatId,
            message_id: messageId
        });

        deleteUserState(userId);
        logger.info(`用户 ${userId} 清理空数据成功: ${timeText}, 删除 ${count} 组`);
    } catch (err) {
        logger.error(`清理空数据失败: ${err.message}`);
        await bot.editMessageText('❌ 清理失败，请稍后重试', {
            chat_id: chatId,
            message_id: messageId
        }).catch(() => { });
        deleteUserState(userId);
    }
}

/**
 * 显示确认界面
 * @param {string} action - 'week', 'month', 'all'
 * @param {Object} query - 回调查询对象
 * @param {number} userId - 用户ID
 * @param {number} chatId - 聊天ID
 * @param {number} messageId - 消息ID
 * @param {number} count - 将要删除的数据条数
 */
async function showConfirmDialog(action, query, userId, chatId, messageId, count) {
    const actionText = action === 'week' ? '一周之前' : (action === 'month' ? '一个月之前' : '全部');
    const confirmKeyboard = {
        inline_keyboard: [
            [
                { text: '✅ 确认删除', callback_data: `clean_confirm:${action}` },
                { text: '❌ 取消', callback_data: 'clean_cancel' }
            ]
        ]
    };
    await bot.editMessageText(`⚠️ 确定要删除 ${actionText} 的空数据吗？共 ${count} 条记录。`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: confirmKeyboard
    });
    await bot.answerCallbackQuery(query.id);
}

/**
 * 处理确认后的清理
 */
async function handleCleanConfirm(action, query) {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    await executeClean(action, query, userId, chatId, messageId);
}

/**
 * 处理取消清理
 */
async function handleCleanCancel(query) {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    // 返回到清理主界面（重新显示按钮）
    const groupListCol = getCollection(COLLECTIONS.GROUP_LIST);
    const now = Date.now();
    const allDocs = await groupListCol.find({ is_delete: { $gt: 0 } }).toArray();
    const total = allDocs.length;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;
    let weekCount = 0, monthCount = 0;
    for (const doc of allDocs) {
        const deleteTime = doc.is_delete;
        if (deleteTime <= oneWeekAgo) weekCount++;
        if (deleteTime <= oneMonthAgo) monthCount++;
    }
    const keyboard = {
        inline_keyboard: [
            [{ text: `🧹 清理一周之前空数据 (${weekCount}条)`, callback_data: 'clean:week' }],
            [{ text: `🧹 清理一个月之前空数据 (${monthCount}条)`, callback_data: 'clean:month' }],
            [{ text: `🧹 清理全部空数据 (${total}条)`, callback_data: 'clean:all' }],
            [{ text: `🧹 自定义清理 (${total}组)`, callback_data: 'clean:custom' }],
            [{ text: '🚪 退出', callback_data: 'clean:exit' }]
        ]
    };
    await bot.editMessageText(`🔍 找到 ${total} 条空数据，点击按钮执行清除操作：`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard
    });
    await bot.answerCallbackQuery(query.id, { text: '已取消' });
}

/**
 * 原有的清理逻辑（week/month/all）- 现在改为显示确认对话框
 */
async function handleRegularClean(action, query) {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    // 获取将要删除的数据数量用于确认提示
    const groupListCol = getCollection(COLLECTIONS.GROUP_LIST);
    const now = Date.now();
    let timeCondition;
    if (action === 'week') {
        timeCondition = { $lte: now - 7 * 24 * 60 * 60 * 1000 };
    } else if (action === 'month') {
        timeCondition = { $lte: now - 30 * 24 * 60 * 60 * 1000 };
    } else if (action === 'all') {
        timeCondition = { $gt: 0 };
    } else {
        return;
    }
    const count = await groupListCol.countDocuments({ is_delete: timeCondition });
    if (count === 0) {
        await bot.answerCallbackQuery(query.id, { text: '没有需要清理的数据' });
        await bot.editMessageText('✅ 没有找到符合条件的空数据', {
            chat_id: chatId,
            message_id: messageId
        });
        deleteUserState(userId);
        return;
    }
    await showConfirmDialog(action, query, userId, chatId, messageId, count);
}

/**
 * 处理自定义清理按钮
 */
async function handleCustomClean(query) {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    await bot.answerCallbackQuery(query.id, { text: '⏳ 正在准备待清理数据...' });

    try {
        const groupListCol = getCollection(COLLECTIONS.GROUP_LIST);
        const mediaCol = getCollection(COLLECTIONS.MEDIA);

        const groupDocs = await groupListCol.find({ is_delete: { $gt: 0 } }).toArray();
        if (groupDocs.length === 0) {
            await bot.editMessageText('✅ 没有待清理的数据', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }

        const groupIds = groupDocs.map(doc => doc.group_id);
        const mediaDocs = await mediaCol.find({ group_id: { $in: groupIds } }).toArray();
        if (mediaDocs.length === 0) {
            await bot.editMessageText('✅ 没有待清理的媒体文件', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }

        const allMedia = mediaDocs.map(doc => ({
            fileUniqueId: doc.file_unique_id,
            fileId: doc.file_id,
            type: doc.media_type,
            groupId: doc.group_id,
            sent: false,
            deleted: false
        }));

        await bot.editMessageText(`🔄 开始发送待清理媒体，共 ${allMedia.length} 个文件，将分批发送...`, {
            chat_id: chatId,
            message_id: messageId
        });

        setUserState(userId, {
            mode: 'clean',
            step: 'custom',
            allMedia: allMedia,
            sentCount: 0,
            awaitingContinue: false,
            continueMsgId: null
        });

        await sendNextBatch(userId, chatId);
    } catch (err) {
        logger.error(`自定义清理准备失败: ${err.message}`);
        await bot.editMessageText('❌ 准备失败，请稍后重试', {
            chat_id: chatId,
            message_id: messageId
        });
    }
}

/**
 * 主处理函数
 */
async function handleCleanCallback(query) {
    const data = query.data;
    const parts = data.split(':');
    if (parts[0] !== 'clean') {
        await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        return;
    }

    const action = parts[1];
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    switch (action) {
        case 'week':
        case 'month':
        case 'all':
            await handleRegularClean(action, query);
            break;
        case 'custom':
            await handleCustomClean(query);
            break;
        case 'exit':
            try {
                await bot.editMessageText('✅ 已退出数据库清理模式', {
                    chat_id: chatId,
                    message_id: messageId
                });
                await bot.answerCallbackQuery(query.id, { text: '已退出' });
                deleteUserState(userId);
                logger.info(`用户 ${userId} 通过按钮退出数据库清理模式`);
            } catch (err) {
                logger.error(`编辑退出消息失败: ${err.message}`);
            }
            break;
        default:
            await bot.answerCallbackQuery(query.id, { text: '❌ 未知操作' });
    }
}

// 导出确认和取消处理函数供外部使用（如果需要）
module.exports = handleCleanCallback;
module.exports.handleCleanConfirm = handleCleanConfirm;
module.exports.handleCleanCancel = handleCleanCancel;