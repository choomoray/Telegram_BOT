// db/media.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

/**
 * 新增 media 记录
 * @param {Object} data - { group_id, subgroup, file_id, file_unique_id, media_type,
 *                          video_time (可选), thumb_file_id (可选，视频/文档/音频封面),
 *                          group (可选): { chat_id, message_id }, channel (可选): { chat_id, message_id } }
 *
 * 位置只写 group / channel 子文档（两者都带 chat_id + message_id，是唯一权威）；
 * **不再写顶层 message_id**——旧数据里它是"首次收录位置的消息 ID"，与子文档重复，
 * 读取时统一由 resolveMediaPosition() 兜底（见下）。
 * 调用方传进来的 data.message_id 会被忽略。
 */
async function insertMedia(data) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        const doc = {
            group_id: data.group_id,
            subgroup: data.subgroup !== undefined ? data.subgroup : 1,
            file_id: data.file_id,
            file_unique_id: data.file_unique_id,
            media_type: data.media_type
            // 不再添加 pwd 字段，只有通过 /password 设置的才有
        };
        // 双位置：group=群组位置、channel=频道位置（频道转发媒体两项都有）
        if (data.group && data.group.chat_id) {
            doc.group = { chat_id: data.group.chat_id, message_id: data.group.message_id };
        }
        if (data.channel && data.channel.chat_id) {
            doc.channel = { chat_id: data.channel.chat_id, message_id: data.channel.message_id };
        }
        if (data.media_type === 'video' && data.video_time !== undefined && data.video_time !== null) {
            doc.video_time = data.video_time;
        }
        // 视频/文档/音频的封面 file_id（Web 控制台缩略图用；图片不需要，直接用自身 file_id）
        if (data.thumb_file_id) {
            doc.thumb_file_id = data.thumb_file_id;
        }
        logger.info(`准备插入 media: ${JSON.stringify(doc)}`);
        const result = await col.insertOne(doc);
        const inserted = await col.findOne({ _id: result.insertedId });
        logger.info(`media 插入成功，存储的文档: ${JSON.stringify(inserted)}`);
        return result;
    } catch (err) {
        if (err.code === 11000) {
            logger.warn(`media 重复插入: ${data.file_unique_id}`);
            return null;
        }
        logger.error(`media 插入失败: ${err.message}`);
        throw err;
    }
}

/**
 * 根据聊天类型构建媒体位置对象：
 * 频道 → { channel: { chat_id, message_id } }；群组/未知 → { group: { chat_id, message_id } }
 * @param {number|string} chatId - 聊天 ID
 * @param {number|string} messageId - 消息 ID
 * @param {string} [chatType] - 已知聊天类型（channel/group），未知时查询 channel_group 库
 * @returns {Promise<Object>} 形如 { group: {...} } 或 { channel: {...} }
 */
async function buildMediaLocation(chatId, messageId, chatType) {
    let type = chatType;
    if (!type) {
        const { getChannelGroupById } = require('./channelGroup');
        const info = await getChannelGroupById(chatId);
        type = info && info.type ? info.type : 'group';
    }
    if (type === 'channel') {
        return { channel: { chat_id: chatId, message_id: messageId } };
    }
    return { group: { chat_id: chatId, message_id: messageId } };
}

/**
 * 解析媒体位置（chat_id + message_id）——媒体位置的统一读取入口。
 *
 * 位置的唯一权威是 `group` / `channel` 子文档（都带 chat_id + message_id）；
 * 旧数据才有顶层 `message_id`（其 chat 需由 group_id 前缀推导），因此：
 *   1) 优先「首次收录位置」= group_id 前缀对应的那个位置（与旧数据顶层 message_id 语义一致）；
 *   2) 没有子文档时退回顶层 message_id（group_id 前缀作为 chat_id）；
 *   3) 最后兜底：群组位置 → 频道位置。
 * @param {Object} mediaDoc - media 集合文档
 * @returns {{chatId:number|string, messageId:number, via:'group'|'channel'|'legacy'}|null}
 */
function resolveMediaPosition(mediaDoc) {
    if (!mediaDoc) return null;
    const prefix = String(mediaDoc.group_id || '').split('_')[0];
    const numericPrefix = Number(prefix);

    const candidates = [];
    if (mediaDoc.group && mediaDoc.group.chat_id !== undefined && mediaDoc.group.chat_id !== null) {
        candidates.push({ chatId: mediaDoc.group.chat_id, messageId: Number(mediaDoc.group.message_id), via: 'group' });
    }
    if (mediaDoc.channel && mediaDoc.channel.chat_id !== undefined && mediaDoc.channel.chat_id !== null) {
        candidates.push({ chatId: mediaDoc.channel.chat_id, messageId: Number(mediaDoc.channel.message_id), via: 'channel' });
    }

    // 1) 首次收录位置（group_id 前缀）
    const first = candidates.find(c => String(c.chatId) === prefix);
    if (first && Number.isFinite(first.messageId) && first.messageId > 0) return first;

    // 2) 旧数据：只有顶层 message_id
    const legacyId = Number(mediaDoc.message_id);
    if (Number.isFinite(legacyId) && legacyId > 0) {
        return { chatId: Number.isFinite(numericPrefix) ? numericPrefix : prefix, messageId: legacyId, via: 'legacy' };
    }

    // 3) 兜底：群组位置 → 频道位置
    return candidates.find(c => Number.isFinite(c.messageId) && c.messageId > 0) || null;
}

/** 媒体位置的消息 ID（排序/展示用；取不到时返回 0） */
function mediaPositionMessageId(mediaDoc) {
    const pos = resolveMediaPosition(mediaDoc);
    return pos ? pos.messageId : 0;
}

/** 媒体按 Telegram 顺序排序：subgroup 升序 → 位置消息 ID 升序（位置可能在 group/channel/顶层，故在内存里排） */
function sortMediaDocsByPosition(mediaDocs) {
    return [...(mediaDocs || [])].sort((a, b) => {
        const sa = Number(a.subgroup) || 1;
        const sb = Number(b.subgroup) || 1;
        if (sa !== sb) return sa - sb;
        return mediaPositionMessageId(a) - mediaPositionMessageId(b);
    });
}

/**
 * 一次性清理历史数据：顶层 `message_id` 与 group / channel 位置完全重复时删掉该字段，
 * 让 media 只有一份位置（子文档）。没有子文档的旧数据**保留**顶层字段（它是唯一位置来源）。
 * 幂等：清理完再跑匹配 0 条。
 * @returns {Promise<number>} 清理的文档数
 */
async function cleanupDuplicateMediaMessageId() {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        // 只取判断需要的字段（大库时避免把整个文档读进内存）
        const docs = await col.find(
            { message_id: { $exists: true } },
            { projection: { message_id: 1, group: 1, channel: 1 } }
        ).toArray();
        const ids = [];
        for (const doc of docs) {
            const sameAsGroup = doc.group && doc.group.message_id !== undefined && doc.group.message_id === doc.message_id;
            const sameAsChannel = doc.channel && doc.channel.message_id !== undefined && doc.channel.message_id === doc.message_id;
            if (sameAsGroup || sameAsChannel) ids.push(doc._id);
        }
        let cleaned = 0;
        const CHUNK = 500;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const res = await col.updateMany(
                { _id: { $in: ids.slice(i, i + CHUNK) } },
                { $unset: { message_id: '' } }
            );
            cleaned += res.modifiedCount || 0;
        }
        if (cleaned > 0) logger.success(`media 清理与位置重复的顶层 message_id: ${cleaned} 条`);
        return cleaned;
    } catch (err) {
        logger.error(`清理 media 顶层 message_id 失败: ${err.message}`);
        return 0;
    }
}

/**
 * 根据 file_unique_id 查询 media
 */
async function findMediaByFileUniqueId(fileUniqueId) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        return await col.findOne({ file_unique_id: fileUniqueId });
    } catch (err) {
        logger.error(`查询 media 失败: ${err.message}`);
        return null;
    }
}

/**
 * 根据 group_id 查询 media 列表，按 subgroup、位置消息 ID 升序排序
 * （位置在 group / channel 子文档里，旧数据才是顶层 message_id，因此排序在内存里按解析结果做）
 */
async function findMediaByGroupId(groupId) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        return sortMediaDocsByPosition(await col.find({ group_id: groupId }).toArray());
    } catch (err) {
        logger.error(`查询 group_id media 失败: ${err.message}`);
        return [];
    }
}

/**
 * 根据 group_id 和 subgroup 查询 media 列表，按位置消息 ID 升序排序
 */
async function findMediaByGroupIdAndSubgroup(groupId, subgroup) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        return sortMediaDocsByPosition(await col.find({ group_id: groupId, subgroup }).toArray());
    } catch (err) {
        logger.error(`查询 group_id 和 subgroup media 失败: ${err.message}`);
        return [];
    }
}

/**
 * 获取指定 group_id 的最大 subgroup 值
 */
async function getMaxSubgroup(groupId) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        const result = await col.find({ group_id: groupId }).sort({ subgroup: -1 }).limit(1).toArray();
        return result.length > 0 ? result[0].subgroup : 0;
    } catch (err) {
        logger.error(`获取最大 subgroup 失败: ${err.message}`);
        return 0;
    }
}

/**
 * 根据 file_unique_id 删除 media 记录
 */
async function deleteMediaByFileUniqueId(fileUniqueId) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        const result = await col.deleteOne({ file_unique_id: fileUniqueId });
        logger.info(`media 删除: file_unique_id=${fileUniqueId}, deleted=${result.deletedCount}`);
        return result;
    } catch (err) {
        logger.error(`删除 media 失败: ${err.message}`);
        throw err;
    }
}

/**
 * 更新媒体的密码
 * @param {string} fileUniqueId - 文件的唯一ID
 * @param {string} password - 新密码（如果为空字符串或 null，则删除 pwd 字段）
 * @returns {Promise<boolean>} 是否更新成功
 */
async function updateMediaPassword(fileUniqueId, password) {
    try {
        const col = getCollection(COLLECTIONS.MEDIA);
        let updateDoc;
        if (!password || password === '') {
            // 清除密码字段
            updateDoc = { $unset: { pwd: "" } };
        } else {
            updateDoc = { $set: { pwd: password } };
        }
        const result = await col.updateOne(
            { file_unique_id: fileUniqueId },
            updateDoc
        );
        return result.matchedCount > 0;
    } catch (err) {
        logger.error(`更新媒体密码失败: ${err.message}`);
        return false;
    }
}

module.exports = {
    insertMedia,
    findMediaByFileUniqueId,
    findMediaByGroupId,
    findMediaByGroupIdAndSubgroup,
    getMaxSubgroup,
    deleteMediaByFileUniqueId,
    updateMediaPassword,
    buildMediaLocation,
    resolveMediaPosition,
    mediaPositionMessageId,
    sortMediaDocsByPosition,
    cleanupDuplicateMediaMessageId
};