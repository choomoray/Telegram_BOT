// media.js
const { getCollection, COLLECTIONS } = require('./db/getCollection');
const { escapeHTML } = require('./utils/sanitize');
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

            // 音频文件无注释时，自动用标题和艺术家生成搜索用文本
            let caption = msg.caption || '';
            if (!caption && type === 'audio') {
                const audio = msg.audio;
                const title = audio.title || '';
                const performer = audio.performer || '';
                if (title || performer) {
                    caption = [title, performer].filter(Boolean).join(' - ');
                }
            }

            return {
                type,
                fileId,
                fileUniqueId,
                caption,
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

/**
 * 恢复媒体组注释到原始位置（与用户发送一致）
 * Telegram 机制：媒体组仅第一条可带注释。发送时不放置临时注释（仅当注释
 * 原本就在第一条时才直接带上），其余位置的注释通过发送后二次编辑还原，
 * 比"先放临时文本再清空重编辑"少一次 API 调用，也避免错误文本闪现。
 * @param {number} chatId - 目标聊天 ID
 * @param {Array} sentMessages - 发送成功的消息数组（与 items 顺序对应）
 * @param {Array} items - 原始媒体项（含 caption）
 * @param {number[]} captionIndexes - 注释所在的原始下标
 */
async function restoreMediaGroupCaptions(chatId, sentMessages, items, captionIndexes) {
    try {
        // 需要二次编辑的位置：不在第 0 条的所有注释位置（第 0 条发送时已带上）
        const toEdit = captionIndexes.filter(idx => idx > 0);
        if (toEdit.length === 0) return;

        for (const idx of toEdit) {
            const sent = sentMessages[idx];
            const item = items[idx];
            if (sent && item.caption) {
                // 纯文本编辑（不启用 HTML 解析），保证任何字符的注释都能还原
                await bot.editMessageCaption(item.caption, {
                    chat_id: chatId,
                    message_id: sent.message_id
                }).catch((err) => {
                    logger.warn(`为媒体 ${idx + 1} 添加注释失败: ${err.message}`);
                });
            }
        }
        logger.info(`媒体组注释位置恢复完成: chatId=${chatId}, 注释位于第 ${toEdit.map(i => i + 1).join('、')} 条`);
    } catch (err) {
        logger.warn(`媒体组注释位置恢复失败: ${err.message}`);
    }
}

async function sendMediaGroupAsReply(chatId, replyToMessageId, mediaItems, maxGroupSize = 10) {
    if (!mediaItems || mediaItems.length === 0) return [];

    // 记录注释原始位置（Telegram 机制：媒体组仅第一条可带注释，其余发送后二次编辑还原）
    const captionIndexes = [];
    mediaItems.forEach((item, idx) => {
        if (item.caption) captionIndexes.push(idx);
    });

    const allSentMessages = [];

    for (let i = 0; i < mediaItems.length; i += maxGroupSize) {
        const chunk = mediaItems.slice(i, i + maxGroupSize);
        const mediaGroup = chunk.map((item, index) => ({
            type: item.type,
            media: item.fileId,
            // 注释原本在整组第一条时直接带上；否则不放置临时注释（发送后编辑还原）
            caption: (i === 0 && index === 0 && captionIndexes.includes(0)) ? item.caption : undefined,
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

    // 注释不在第一条时：发送后编辑回原始位置
    await restoreMediaGroupCaptions(chatId, allSentMessages, mediaItems, captionIndexes);

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
            if (state.groupSize) {
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
    let captionDoc = null;
    for (const doc of msgDocs) {
        if (doc.text) {
            caption = doc.text;
            captionDoc = doc;
            break;
        }
    }

    // 标签按 message 独立：底部"📌 标签"与显示的文本配对（显示哪条文本就配哪条的标签）
    if (caption && captionDoc) {
        const tags = (Array.isArray(captionDoc.tags) && captionDoc.tags.length) ? captionDoc.tags : [];
        if (tags.length > 0) {
            caption += `\n\n📌 标签：${escapeHTML(tags.join('、'))}`;
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

/**
 * 分批发送媒体组，每批最多 5 个 subgroup
 * @param {number} chatId - 目标用户/群组 ID
 * @param {string} groupId - 媒体组 ID
 * @param {number} startSubgroupIdx - 从第几个 subgroup 开始（0-based）
 * @param {number} [batchSize=5] - 每批最多发送多少个 subgroup
 * @returns {Promise<{done: boolean, nextSubgroupIdx: number, sentInBatch: number, totalSent: number, totalMedia: number, totalSubgroups: number}>}
 */
async function sendMediaGroupBatched(chatId, groupId, startSubgroupIdx = 0, batchSize = 5) {
    const mediaCol = getCollection(COLLECTIONS.MEDIA);
    const subgroups = await mediaCol.distinct('subgroup', { group_id: groupId });
    subgroups.sort((a, b) => a - b);

    const totalSubgroups = subgroups.length;
    const totalMedia = await mediaCol.countDocuments({ group_id: groupId });
    const endSubgroupIdx = Math.min(startSubgroupIdx + batchSize, totalSubgroups);
    const batchSubgroups = subgroups.slice(startSubgroupIdx, endSubgroupIdx);

    let sentInBatch = 0;
    for (const subgroup of batchSubgroups) {
        try {
            const subgroupMedia = await getMediaByGroupIdAndSubgroup(groupId, subgroup);
            await sendMediaSubgroup(chatId, groupId, subgroup);
            sentInBatch += subgroupMedia.length;
        } catch (err) {
            logger.error(`分批发送 subgroup=${subgroup} 失败: ${err.message}`);
        }
    }

    const isDone = endSubgroupIdx >= totalSubgroups;
    return {
        done: isDone,
        nextSubgroupIdx: endSubgroupIdx,
        sentInBatch,
        totalSent: 0, // 由调用方维护累加值
        totalMedia,
        totalSubgroups
    };
}

module.exports = {
    extractMediaFromMessage,
    sendMediaAsReply,
    sendMediaGroupAsReply,
    restoreMediaGroupCaptions,
    clearMediaGroupState,
    getMediaByGroupIdSorted,
    getMediaByGroupIdAndSubgroup,
    sendMediaSubgroup,
    sendMediaGroup,
    sendMediaGroupBatched
};