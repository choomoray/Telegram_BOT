// handlers/commands/randomPictures.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { getSettings } = require('../../db/settings');
const { sendMediaGroup } = require('../../utils/sendMedia');
const { insertLog } = require('../../db/log');

async function handleRandomPicturesCommand(userId, msg) {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    let pictureCount = 9;
    let source = 0;
    try {
        const settings = await getSettings();
        if (settings && settings.random_pictures_num !== undefined) {
            let num = parseInt(settings.random_pictures_num);
            if (!isNaN(num)) {
                if (num < 1) num = 1;
                if (num > 10) num = 10;
                pictureCount = num;
            }
        }
        if (settings && settings.random_pictures !== undefined) {
            source = settings.random_pictures === 1 ? 1 : 0;
        }
    } catch (err) {
        logger.warn(`获取随机图片设置失败: ${err.message}`);
    }

    let processingMsg;
    try {
        processingMsg = await bot.sendMessage(chatId, '🎲 正在搜集图片中，请稍等...', {
            reply_to_message_id: messageId,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`用户 ${userId} /random_pictures 发送处理中消息失败: ${err.message}`);
        return;
    }

    (async () => {
        try {
            let mediaItems = [];

            if (source === 0) {
                const messageCol = getCollection(COLLECTIONS.MESSAGE);
                const pipeline = [
                    { $match: { media_type: 'photo' } },
                    { $sample: { size: pictureCount * 2 } }
                ];
                const messageDocs = await messageCol.aggregate(pipeline).toArray();
                if (messageDocs.length === 0) {
                    await bot.editMessageText('❌ 没有找到任何图片数据', {
                        chat_id: chatId,
                        message_id: processingMsg.message_id
                    });
                    return;
                }

                const mediaCol = getCollection(COLLECTIONS.MEDIA);
                const fileUniqueIds = messageDocs.map(d => d.file_unique_id);
                const groupIds = messageDocs.map(d => d.group_id);

                // 一次查询所有 media 记录
                const allMediaDocs = await mediaCol.find({
                    $or: [
                        { file_unique_id: { $in: fileUniqueIds }, media_type: 'photo' },
                        { group_id: { $in: groupIds }, media_type: 'photo' }
                    ]
                }).sort({ _id: 1 }).toArray();

                const mediaByFileId = {};
                for (const doc of allMediaDocs) {
                    if (!mediaByFileId[doc.file_unique_id]) {
                        mediaByFileId[doc.file_unique_id] = doc;
                    }
                }

                // 按 group 建立索引
                const mediaByGroup = {};
                for (const doc of allMediaDocs) {
                    if (!mediaByGroup[doc.group_id]) {
                        mediaByGroup[doc.group_id] = [];
                    }
                    mediaByGroup[doc.group_id].push(doc);
                }

                const usedFileIds = new Set();
                for (const doc of messageDocs) {
                    let mediaDoc = mediaByFileId[doc.file_unique_id];
                    if (!mediaDoc) {
                        const groupMedias = mediaByGroup[doc.group_id] || [];
                        if (groupMedias.length > 0) mediaDoc = groupMedias[0];
                    }
                    if (mediaDoc && !usedFileIds.has(mediaDoc.file_id)) {
                        mediaItems.push({ file_id: mediaDoc.file_id });
                        usedFileIds.add(mediaDoc.file_id);
                        if (mediaItems.length >= pictureCount) break;
                    }
                }
            } else {
                const mediaCol = getCollection(COLLECTIONS.MEDIA);
                const pipeline = [
                    { $match: { media_type: 'photo' } },
                    { $sample: { size: pictureCount } }
                ];
                const mediaDocs = await mediaCol.aggregate(pipeline).toArray();
                mediaItems = mediaDocs.map(doc => ({ file_id: doc.file_id }));
            }

            if (mediaItems.length === 0) {
                await bot.editMessageText('❌ 无法获取图片文件', {
                    chat_id: chatId,
                    message_id: processingMsg.message_id
                });
                return;
            }

            await sendMediaGroup(chatId, mediaItems, 'photo', messageId);

            try {
                await bot.editMessageText(`✅ 已发送 ${mediaItems.length} 张图片`, {
                    chat_id: chatId,
                    message_id: processingMsg.message_id
                });
            } catch (editErr) {
                logger.warn(`编辑处理中消息失败: ${editErr.message}`);
            }

            insertLog(12, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
            logger.success(`用户 ${userId} /random_pictures 成功发送 ${mediaItems.length} 张图片`);
        } catch (err) {
            logger.error(`用户 ${userId} /random_pictures 处理失败: ${err.message}`);
            try {
                await bot.editMessageText('❌ 图片搜索失败，请稍后重试', {
                    chat_id: chatId,
                    message_id: processingMsg.message_id
                });
            } catch (editErr) {
                logger.error(`编辑错误消息失败: ${editErr.message}`);
            }
        }
    })();
}

module.exports = handleRandomPicturesCommand;