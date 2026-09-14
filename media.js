// media.js
const { getCollection, COLLECTIONS } = require('./db/getCollection');
const { sortMediaDocsByPosition } = require('./db/media');
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

            // 视频/文档/音频自带的封面（Telegram thumbnail）：
            // 图片走自身 file_id，其余类型只有拿到封面 file_id 才能在 Web 控制台展示缩略图
            let thumbFileId = null;
            if (type !== 'photo') {
                const media = msg[type];
                const thumb = media.thumbnail || media.thumb || null;
                thumbFileId = (thumb && thumb.file_id) || null;
            }

            // 文件 / 音乐的名称（收录进 media.media_name，供按文件名搜索）：
            //   - 文档：Telegram 的 file_name
            //   - 音频：file_name 优先；没有就用「标题 - 艺术家」（音乐没有文件名时这才是它的名字）
            //   - 图片 / 视频：不记录（用户要求：不需要存，收录时也不用传）
            // 注意：**只用来搜索，不参与描述**：绝不再自动给音频编一段描述（用户要求严格按发送的内容）
            let mediaName = null;
            if (type === 'document') {
                mediaName = String((msg.document && msg.document.file_name) || '').trim() || null;
            } else if (type === 'audio') {
                const audio = msg.audio || {};
                mediaName = String(audio.file_name || '').trim() ||
                    [audio.title, audio.performer].map(s => String(s || '').trim()).filter(Boolean).join(' - ') ||
                    null;
            }

            const caption = msg.caption || '';

            return {
                type,
                fileId,
                fileUniqueId,
                caption,
                has_spoiler: msg.has_media_spoiler || false,
                videoTime,
                thumbFileId,
                mediaName
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

/** 是不是"文本媒体"（/send、/reply 发出的纯文本，收录为 media_type='text'） */
function isTextMediaItem(item) {
    return !!item && (item.type === 'text' || item.media_type === 'text' || (!item.fileId && !item.file_id && !!item.text));
}

/**
 * 相册注释「先行带上」：算出要内联带在第一条上的注释、以及发送后要不要清掉第一条
 *
 * Telegram 机制：相册里**只有第一条**媒体带的注释会随相册一起发出去。
 * 用户把描述写在别的媒体上时，旧做法是"先不带注释发出 → 发完再 editMessageCaption 编辑到
 * 那条媒体上"；但 Telegram 的自动转发（频道帖 → 关联讨论群）是在**发送那一刻**复制消息的，
 * 编辑之后才补上的描述不会出现在转发副本里 —— 于是讨论群那份媒体被收录成"空描述"，
 * 用户看到的就是"发送时带描述，发到频道后描述没了"。
 *
 * 所以发送时先把注释内联带在第一条上（任何副本都带上描述），发送后再把注释还原到原本的
 * 媒体上（`restoreMediaGroupCaptions`），并把临时带上的第一条清空（`clearAlbumCaption`）。
 *
 * @param {Array} items - 相册条目（每项可能有 caption）
 * @returns {{ carrierCaption: string, clearFirst: boolean }}
 *   carrierCaption：要内联带在第一条上的注释（没有注释时为空字符串）
 *   clearFirst：注释原本不在第一条 → 发送后要把第一条临时带上的注释清掉
 */
function albumCaptionCarry(items) {
    const list = items || [];
    const first = list.find(it => it && it.caption && String(it.caption).trim());
    if (!first) return { carrierCaption: '', clearFirst: false };
    const onFirstItem = !!(list[0] && list[0].caption && String(list[0].caption).trim());
    return { carrierCaption: String(first.caption), clearFirst: !onFirstItem };
}

/** 清掉第一条上临时带上的注释（发送后还原位置时调用；失败只记日志） */
async function clearAlbumCaption(chatId, messageId) {
    if (!chatId || !messageId) return;
    try {
        await bot.editMessageCaption('', { chat_id: chatId, message_id: messageId });
        logger.info(`已清掉第一条临时带上的注释: chatId=${chatId}, messageId=${messageId}`);
    } catch (err) {
        logger.warn(`清掉第一条注释失败: chatId=${chatId}, messageId=${messageId}, ${err.message}`);
    }
}

/** 文本媒体的正文（存放在 media_name；也兼容调用方直接传 text） */
function textMediaContent(item) {
    if (!item) return '';
    return String(item.text || item.media_name || item.content || '');
}

/** 文本媒体的 entities（保留 Telegram 富文本格式） */
function textMediaEntities(item) {
    if (!item) return null;
    const e = item.entities || item.media_entities;
    return Array.isArray(e) && e.length ? e : null;
}

/** 把一条文本媒体作为普通文本消息发出去（保留加粗/斜体/链接等格式） */
async function sendTextMedia(chatId, item, extraOptions = {}) {
    const text = textMediaContent(item);
    if (!text) return null;
    const opts = { ...extraOptions };
    const entities = textMediaEntities(item);
    if (entities) opts.entities = entities;
    return await bot.sendMessage(chatId, text, opts);
}

async function sendMediaGroupAsReply(chatId, replyToMessageId, mediaItems, maxGroupSize = 10) {
    if (!mediaItems || mediaItems.length === 0) return [];

    // 文本媒体不能进媒体相册（相册只接受 Telegram 媒体）：拆出来，最后按普通文本消息补发
    const albumItems = mediaItems.filter(it => !isTextMediaItem(it));
    const textItems = mediaItems.filter(it => isTextMediaItem(it));

    // 记录注释原始位置（Telegram 机制：媒体组仅第一条可带注释，其余发送后二次编辑还原）
    const captionIndexes = [];
    albumItems.forEach((item, idx) => {
        if (item.caption) captionIndexes.push(idx);
    });

    // 注释先行带上：即使描述原本不在第一条，也先把第一条注释内联带上，
    // 这样"发送那一刻"产生的副本（频道帖的自动转发）也带描述；发完再还原位置并清掉第一条
    const carry = albumCaptionCarry(albumItems);

    const allSentMessages = [];

    for (let i = 0; i < albumItems.length; i += maxGroupSize) {
        const chunk = albumItems.slice(i, i + maxGroupSize);
        const mediaGroup = chunk.map((item, index) => ({
            type: item.type,
            media: item.fileId,
            // 注释本来就在第一条 → 照旧内联带上；不在第一条 → 用 carry 临时带上（发送后还原）
            caption: (i === 0 && index === 0 && carry.carrierCaption) ? carry.carrierCaption : undefined,
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
            if (i + maxGroupSize < albumItems.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        } catch (err) {
            logger.error(`发送媒体组回复失败: ${err.message}`);
            throw err;
        }
    }

    // 注释不在第一条时：发送后编辑回原始位置
    await restoreMediaGroupCaptions(chatId, allSentMessages, albumItems, captionIndexes);
    // 临时带在第一条上的注释要清掉（描述本来不在第一条时），否则相册里会同时出现两处描述
    if (carry.clearFirst && allSentMessages[0]) {
        await clearAlbumCaption(chatId, allSentMessages[0].message_id);
    }

    // 文本媒体：逐条按文本消息发出（保留原 Telegram 格式）
    for (const item of textItems) {
        await sendTextMedia(chatId, item, {
            reply_to_message_id: replyToMessageId,
            allow_sending_without_reply: true
        }).catch(err => logger.warn(`发送文本媒体失败: ${err.message}`));
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
        // 退出即真正发送收集的媒体：发送成功/失败各记一条操作日志
        // （action 按模式区分：合并 / 加遮罩 / 去遮罩）
        const { logOperation } = require('./utils/opLog');
        const modeAction = mode === 'media_group' ? 'media_merge' : (mode === 'media_hide' ? 'media_hide' : 'media_unhide');
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
            try {
                await sendMediaGroupAsReply(userId, null, processedItems, groupSize);
                logOperation({
                    action: modeAction,
                    source: 'private',
                    userId,
                    counts: {
                        media: processedItems.length,
                        groups: Math.ceil(processedItems.length / groupSize)
                    },
                    detail: {
                        groupSize,
                        spoilerAction: state.spoilerAction || undefined,
                        mode
                    }
                }).catch(() => { });
            } catch (err) {
                logger.error(`发送收集的媒体失败: ${err.message}`);
                logOperation({
                    action: modeAction,
                    result: 'fail',
                    source: 'private',
                    userId,
                    counts: { media: processedItems.length },
                    detail: { groupSize, spoilerAction: state.spoilerAction || undefined, mode },
                    error: err.message
                }).catch(() => { });
            }
        }
        deleteUserState(userId);
        logger.info(`用户 ${userId} ${mode} 状态已清理`);
    }
}

async function getMediaByGroupIdSorted(groupId) {
    const mediaCol = getCollection(COLLECTIONS.MEDIA);
    // 位置在 group / channel 子文档里（旧数据才是顶层 message_id），排序按解析出的位置来
    const mediaList = sortMediaDocsByPosition(await mediaCol.find({ group_id: groupId }).toArray());
    logger.info(`获取媒体组 group_id=${groupId}，共 ${mediaList.length} 条`);
    return mediaList;
}

/**
 * 收录一条"纯文本"（/send 或 /reply 发出的文本）到 media 集合
 *
 * 用户要求：文本此前没有进库，搜索时看不到这项数据。这里按下面的约定落库：
 *   - `media_type: 'text'`  —— 新增的类型，表明这条记录是文本；
 *   - `media_name`          —— 借用"文件/音乐名称"那个字段存放**文本内容**；
 *   - `media_entities`      —— 原消息的 Telegram entities，用来**保留文本格式**（加粗/斜体/链接等）；
 *   - `file_unique_id`      —— 文本没有 Telegram file，用 `text:<chatId>:<messageId>` 造一个唯一值
 *                              （media.file_unique_id 上有唯一索引）。
 * 不写 message 集合：message 是"描述 + 标签"的载体，这里只把文本本身记下来供搜索 / 查看。
 *
 * @param {Object} p
 *   - sentMsg: 发送成功后 Telegram 返回的消息（要它的 message_id）
 *   - chatId / targetType: 发送目标（用于写位置子文档）
 *   - groupId / subgroup: 归属的媒体组与子组
 *   - text / entities: 文本内容与富文本 entities
 * @returns {Promise<Object|null>} insertMedia 的结果
 */
async function recordTextMedia({ sentMsg, chatId, targetType, groupId, subgroup = 1, text, entities }) {
    if (!sentMsg || !sentMsg.message_id || !groupId) return null;
    const content = String(text || '');
    if (!content) return null;
    try {
        const { insertMedia, buildMediaLocation } = require('./db/media');
        const location = await buildMediaLocation(chatId, sentMsg.message_id, targetType);
        const result = await insertMedia({
            group_id: groupId,
            subgroup,
            file_id: null,
            file_unique_id: `text:${chatId}:${sentMsg.message_id}`,
            media_type: 'text',
            media_name: content,
            media_entities: Array.isArray(entities) ? entities : undefined,
            ...location
        });
        logger.info(`文本已收录: group_id=${groupId}, subgroup=${subgroup}, chat=${chatId}/${sentMsg.message_id}, 长度=${content.length}${Array.isArray(entities) && entities.length ? `, entities=${entities.length}` : ''}`);
        return result;
    } catch (err) {
        logger.error(`文本收录失败: ${err.message}`);
        return null;
    }
}

async function getMediaByGroupIdAndSubgroup(groupId, subgroup) {
    const mediaCol = getCollection(COLLECTIONS.MEDIA);
    const mediaList = sortMediaDocsByPosition(await mediaCol.find({ group_id: groupId, subgroup }).toArray());
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
    // 文本媒体（media_type='text'）不能进相册：按原始顺序遍历，
    // 遇到文本就先把攒下的相册发掉，再单独发这条文本（保留它原本在组内的位置感）
    let pending = [];
    let captionUsed = false;
    const flushAlbum = async () => {
        if (!pending.length) return;
        const mediaGroup = pending;
        pending = [];
        if (!captionUsed && caption) {
            mediaGroup[0].caption = caption;
            captionUsed = true;
        }
        await bot.sendMediaGroup(chatId, mediaGroup);
        await new Promise(resolve => setTimeout(resolve, 200));
    };

    for (const media of mediaList) {
        if (isTextMediaItem(media)) {
            await flushAlbum();
            await sendTextMedia(chatId, media).catch(err => logger.warn(`发送文本媒体失败: ${err.message}`));
            continue;
        }
        pending.push({
            type: media.media_type || 'document',
            media: media.file_id,
            caption: undefined,
            parse_mode: 'HTML'
        });
        if (pending.length >= MAX_ALBUM_SIZE) await flushAlbum();
    }
    await flushAlbum();
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
    sendMediaGroupBatched,
    // 文本媒体（media_type='text'）相关
    recordTextMedia,
    sendTextMedia,
    isTextMediaItem,
    textMediaContent,
    textMediaEntities,
    // 相册注释「先行带上」（描述要随相册一起发出去，自动转发副本才不会丢描述）
    albumCaptionCarry,
    clearAlbumCaption
};