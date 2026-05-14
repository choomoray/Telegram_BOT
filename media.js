// media.js
const { getCollection, COLLECTIONS } = require('./db/getCollection');
const logger = require('./logger');
const bot = require('./bot');

function extractMediaFromMessage(msg) {
    const SUPPORTED_TYPES = ['photo', 'video', 'audio', 'document'];
    for (const type of SUPPORTED_TYPES) {
        if (msg[type]) {
            let fileId, fileUniqueId, videoTime = null;
            if (type === 'photo') {
                const photo = msg.photo[msg.photo.length - 1];
                fileId = photo.file_id;
                fileUniqueId = photo.file_unique_id;
            } else if (type === 'video') {
                fileId = msg.video.file_id;
                fileUniqueId = msg.video.file_unique_id;
                videoTime = msg.video.duration || null;
            } else {
                fileId = msg[type].file_id;
                fileUniqueId = msg[type].file_unique_id;
            }
            return {
                type,
                fileId,
                fileUniqueId,
                caption: msg.caption || '',
                has_spoiler: msg.has_media_spoiler || false,
                videoTime
            };
        }
    }
    return null;
}

async function sendMediaAsReply(chatId, replyToMessageId, mediaInfo) {
    const { type, fileId, caption, has_spoiler } = mediaInfo;
    const sendOptions = {
        reply_to_message_id: replyToMessageId,
        allow_sending_without_reply: true,
        caption: caption || undefined,
        parse_mode: 'HTML',
        has_spoiler: has_spoiler || false
    };

    try {
        let sentMsg;
        switch (type) {
            case 'photo':
                sentMsg = await bot.sendPhoto(chatId, fileId, sendOptions);
                break;
            case 'video':
                sentMsg = await bot.sendVideo(chatId, fileId, sendOptions);
                break;
            case 'audio':
                sentMsg = await bot.sendAudio(chatId, fileId, sendOptions);
                break;
            case 'document':
                sentMsg = await bot.sendDocument(chatId, fileId, sendOptions);
                break;
            default:
                throw new Error(`不支持的媒体类型: ${type}`);
        }
        logger.info(`已发送媒体回复: chatId=${chatId}, type=${type}, replyTo=${replyToMessageId}`);
        return sentMsg;
    } catch (err) {
        logger.error(`发送媒体回复失败: ${err.message}`);
        throw err;
    }
}

async function sendMediaGroupAsReply(chatId, replyToMessageId, mediaItems, maxGroupSize = 10) {
    if (!mediaItems || mediaItems.length === 0) return [];

    const allSentMessages = [];

    for (let i = 0; i < mediaItems.length; i += maxGroupSize) {
        const chunk = mediaItems.slice(i, i + maxGroupSize);
        const mediaGroup = chunk.map((item, index) => ({
            type: item.type,
            media: item.fileId,
            caption: index === 0 ? (item.caption || undefined) : undefined,
            parse_mode: 'HTML',
            has_spoiler: item.has_spoiler || false
        }));

        try {
            const sentMessages = await bot.sendMediaGroup(chatId, mediaGroup, {
                reply_to_message_id: replyToMessageId,
                allow_sending_without_reply: true
            });
            allSentMessages.push(...sentMessages);
            logger.info(`已发送媒体组回复: chatId=${chatId}, 数量=${chunk.length}, replyTo=${replyToMessageId}`);
            if (i + maxGroupSize < mediaItems.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        } catch (err) {
            logger.error(`发送媒体组回复失败: ${err.message}`);
            throw err;
        }
    }

    return allSentMessages;
}

/**
 * 清理媒体收集模式的状态
 * @param {number} userId - 用户ID
 * @param {boolean} sendCollected - 是否发送已收集的媒体
 * @param {object|null} rawState - 可选，直接传入状态对象（避免从 getRawUserState 获取时状态已变更）
 */
async function clearMediaGroupState(userId, sendCollected = true, rawState = null) {
    const { getRawUserState, deleteUserState } = require('./states');
    const state = rawState || getRawUserState(userId);
    if (!state) {
        logger.warn(`用户 ${userId} 状态为空，无法清理媒体收集模式`);
        return;
    }

    const mode = state.mode;
    if (['media_group', 'media_hide', 'media_unhide'].includes(mode)) {
        if (sendCollected && state.mediaItems && state.mediaItems.length > 0) {
            let processedItems = [...state.mediaItems];
            if (state.spoilerAction === 'add') {
                processedItems = processedItems.map(item => ({ ...item, has_spoiler: true }));
            } else if (state.spoilerAction === 'remove') {
                processedItems = processedItems.map(item => ({ ...item, has_spoiler: false }));
            }

            let groupSize = 10;
            if (state.groupSize && mode === 'media_group') {
                groupSize = state.groupSize;
            }
            await sendMediaGroupAsReply(userId, null, processedItems, groupSize).catch(err => {
                logger.error(`发送收集的媒体失败: ${err.message}`);
            });
        }
        deleteUserState(userId);
        logger.info(`用户 ${userId} ${mode} 状态已清理`);
    }
}

async function getMediaByGroupIdSorted(groupId) {
    const mediaCol = getCollection(COLLECTIONS.MEDIA);
    const mediaList = await mediaCol.find({ group_id: groupId }).sort({ subgroup: 1, message_id: 1 }).toArray();
    logger.info(`获取媒体组 group_id=${groupId}，共 ${mediaList.length} 条`);
    return mediaList;
}

async function getMediaByGroupIdAndSubgroup(groupId, subgroup) {
    const mediaCol = getCollection(COLLECTIONS.MEDIA);
    const mediaList = await mediaCol.find({ group_id: groupId, subgroup: subgroup }).sort({ message_id: 1 }).toArray();
    logger.info(`获取媒体组 group_id=${groupId}, subgroup=${subgroup}，共 ${mediaList.length} 条`);
    return mediaList;
}

async function sendMediaSubgroup(chatId, groupId, subgroup) {
    const mediaList = await getMediaByGroupIdAndSubgroup(groupId, subgroup);
    if (mediaList.length === 0) throw new Error('没有找到媒体文件');

    const fileUniqueIds = mediaList.map(m => m.file_unique_id);
    const messageCol = getCollection(COLLECTIONS.MESSAGE);
    const msgDocs = await messageCol.find({ file_unique_id: { $in: fileUniqueIds } }).sort({ message_id: 1 }).toArray();
    let caption = '';
    for (const doc of msgDocs) {
        if (doc.text) {
            caption = doc.text;
            break;
        }
    }

    const MAX_ALBUM_SIZE = 10;
    for (let i = 0; i < mediaList.length; i += MAX_ALBUM_SIZE) {
        const chunk = mediaList.slice(i, i + MAX_ALBUM_SIZE);
        const mediaGroup = chunk.map(media => ({
            type: media.media_type || 'document',
            media: media.file_id,
            caption: undefined,
            parse_mode: 'HTML'
        }));
        if (i === 0 && mediaGroup.length > 0 && caption) {
            mediaGroup[0].caption = caption;
        }
        await bot.sendMediaGroup(chatId, mediaGroup);
        if (i + MAX_ALBUM_SIZE < mediaList.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
}

async function sendMediaGroup(chatId, groupId) {
    const mediaCol = getCollection(COLLECTIONS.MEDIA);
    const subgroups = await mediaCol.distinct('subgroup', { group_id: groupId });
    subgroups.sort((a, b) => a - b);

    for (const subgroup of subgroups) {
        try {
            await sendMediaSubgroup(chatId, groupId, subgroup);
        } catch (err) {
            logger.error(`subgroup=${subgroup} 发送失败: ${err.message}`);
        }
    }
}

module.exports = {
    extractMediaFromMessage,
    sendMediaAsReply,
    sendMediaGroupAsReply,
    clearMediaGroupState,
    getMediaByGroupIdSorted,
    getMediaByGroupIdAndSubgroup,
    sendMediaSubgroup,
    sendMediaGroup
};