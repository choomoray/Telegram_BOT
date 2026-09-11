// handlers/modes/markMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { findMediaByFileUniqueId } = require('../../db/media');
const { incrementMark, findGroupList } = require('../../db/groupList');
const { insertMarkRecord } = require('../../db/mark');
const { extractMediaFromMessage } = require('../../media');
const { deleteUserState } = require('../../states');
const { logOperation } = require('../../utils/opLog');

// 用于防止同一媒体组被多次处理的锁集合
const processingGroups = new Set();

async function handleMarkMode(msg, state) {
    const userId = msg.from.id;
    const mediaInfo = extractMediaFromMessage(msg);

    if (!mediaInfo) {
        // 非媒体消息忽略
        logger.info(`用户 ${userId} 在标记模式发送非媒体消息，已忽略`);
        return true;
    }

    const chatId = msg.chat.id;
    const mediaGroupId = msg.media_group_id;
    let groupLockKey = null;

    // 如果是媒体组，检查是否正在处理中
    if (mediaGroupId) {
        groupLockKey = `${chatId}_${mediaGroupId}`;
        if (processingGroups.has(groupLockKey)) {
            logger.info(`用户 ${userId} 媒体组 ${groupLockKey} 正在处理中，忽略本条媒体`);
            return true;
        }
        processingGroups.add(groupLockKey);
    }

    const fileUniqueId = mediaInfo.fileUniqueId;

    // 发送处理中消息
    let processingMsg;
    try {
        processingMsg = await bot.sendMessage(userId, '🔍 正在处理...', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送处理中消息失败: ${err.message}`);
        if (groupLockKey) processingGroups.delete(groupLockKey);
        return true;
    }

    try {
        // 在 media 数据库中查找
        const mediaDoc = await findMediaByFileUniqueId(fileUniqueId);
        if (!mediaDoc) {
            await bot.editMessageText('❌ 数据不存在', {
                chat_id: userId,
                message_id: processingMsg.message_id
            });
            logger.info(`用户 ${userId} 标记失败，媒体不存在: ${fileUniqueId}`);
            return true;
        }

        const groupId = mediaDoc.group_id;

        // 更新 group_list：mark +1，并记录最后标记时间（语义保持不变）
        const newMark = await incrementMark(groupId);

        if (newMark === null) {
            // 理论上应该存在，但以防万一
            logger.error(`group_list 未找到 group_id=${groupId}，但 media 中存在`);
            await bot.editMessageText('❌ 数据异常', {
                chat_id: userId,
                message_id: processingMsg.message_id
            });
            return true;
        }

        // 标记历史（mark 集合）：时间 + 用户 + 媒体/媒体组
        await insertMarkRecord({
            userId,
            mode: 'mark',
            groupId,
            fileUniqueId,
            mediaType: mediaInfo.type,
            isGroup: !!mediaGroupId
        });

        await bot.editMessageText(`✅ 标记成功（${newMark} 次）\n已退出标记模式`, {
            chat_id: userId,
            message_id: processingMsg.message_id
        });
        // 单选题：完成一次标记后退出标记模式（媒体组剩下的相册消息会被静默忽略）
        deleteUserState(userId);
        // 标记成功留痕（group_id 来自 media；组内媒体数与新 mark 值用于报表）
        const groupDoc = await findGroupList(groupId);
        logOperation({
            action: 'mark',
            source: 'private',
            userId,
            target: { type: 'media_group', id: groupId },
            counts: { marks: 1, media: (groupDoc && groupDoc.is_group) || undefined },
            detail: {
                markValue: newMark,
                isGroup: !!mediaGroupId,
                mediaType: mediaInfo.type,
                fileUniqueId
            }
        }).catch(() => { });
        logger.info(`用户 ${userId} 标记成功: group_id=${groupId}, mark 新值=${newMark}，已退出标记模式`);
    } catch (err) {
        logger.error(`标记模式处理失败: ${err.message}`);
        logOperation({
            action: 'mark',
            result: 'fail',
            source: 'private',
            userId,
            detail: { mediaType: mediaInfo.type, fileUniqueId },
            error: err.message
        }).catch(() => { });
        await bot.editMessageText('❌ 处理失败，请稍后重试', {
            chat_id: userId,
            message_id: processingMsg.message_id
        });
    } finally {
        // 如果是媒体组，延迟移除锁，避免后续消息快速涌入
        if (groupLockKey) {
            setTimeout(() => processingGroups.delete(groupLockKey), 1000);
        }
    }

    return true;
}

module.exports = handleMarkMode;