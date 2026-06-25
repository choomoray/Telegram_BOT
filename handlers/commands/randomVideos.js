// handlers/commands/randomVideos.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { getSettings } = require('../../db/settings');
const { createSession } = require('../../utils/queryCache');
const { formatResultLine } = require('../../utils/queryFormatter');
const { sendMediaGroup } = require('../../utils/sendMedia');
const { insertLog } = require('../../db/log');

const TIME_FILTERS = {
    'all': null,
    '<1min': { $lt: 60 },
    '<3min': { $lt: 180 },
    '1-5min': { $gte: 60, $lte: 300 },
    '3-10min': { $gte: 180, $lte: 600 },
    '5-30min': { $gte: 300, $lte: 1800 },
    '>30min': { $gt: 1800 },
    '>1h': { $gt: 3600 }
};

async function handleRandomVideosCommand(userId, msg) {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    let videoMode = 0;
    let textCount = 15;
    let videoCount = 10;
    let timeFilter = null;

    try {
        const settings = await getSettings();
        videoMode = settings.random_videos === 1 ? 1 : 0;

        let tNum = parseInt(settings.random_videos_num_text);
        if (!isNaN(tNum)) {
            if (tNum < 10) tNum = 10;
            if (tNum > 50) tNum = 50;
            textCount = tNum;
        }
        let vNum = parseInt(settings.random_videos_num_video);
        if (!isNaN(vNum)) {
            if (vNum < 1) vNum = 1;
            if (vNum > 10) vNum = 10;
            videoCount = vNum;
        }

        if (videoMode === 1 && settings.random_videos_time) {
            const timeKey = settings.random_videos_time;
            const filter = TIME_FILTERS[timeKey];
            if (filter) {
                timeFilter = filter;
            }
        }
    } catch (err) {
        logger.warn(`获取随机视频设置失败: ${err.message}`);
    }

    let processingMsg;
    try {
        processingMsg = await bot.sendMessage(chatId, '🎲 正在搜集视频中，请稍等...', {
            reply_to_message_id: messageId,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`用户 ${userId} /random_videos 发送处理中消息失败: ${err.message}`);
        return;
    }

    (async () => {
        try {
            if (videoMode === 1) {
                const mediaCol = getCollection(COLLECTIONS.MEDIA);
                const matchStage = { media_type: 'video' };
                if (timeFilter) {
                    matchStage.video_time = timeFilter;
                }
                const pipeline = [
                    { $match: matchStage },
                    { $sample: { size: videoCount } }
                ];
                const mediaDocs = await mediaCol.aggregate(pipeline).toArray();
                if (mediaDocs.length === 0) {
                    await bot.editMessageText('❌ 没有找到符合条件的视频', {
                        chat_id: chatId,
                        message_id: processingMsg.message_id
                    });
                    return;
                }
                const mediaItems = mediaDocs.map(doc => ({ file_id: doc.file_id }));
                await sendMediaGroup(chatId, mediaItems, 'video', messageId);
                await bot.editMessageText(`✅ 已发送 ${mediaItems.length} 个视频`, {
                    chat_id: chatId,
                    message_id: processingMsg.message_id
                });
                insertLog(11, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
                logger.success(`用户 ${userId} /random_videos (视频模式) 成功发送 ${mediaItems.length} 个视频`);
            } else {
                const messageCol = getCollection(COLLECTIONS.MESSAGE);
                const pipeline = [
                    { $match: { media_type: 'video' } },
                    { $sample: { size: textCount } },
                    {
                        $project: {
                            message_id: 1,
                            chat_id: 1,
                            media_type: 1,
                            text: 1,
                            level: 1,
                            file_unique_id: 1
                        }
                    }
                ];
                const results = await messageCol.aggregate(pipeline).toArray();
                const total = results.length;
                if (total === 0) {
                    await bot.editMessageText('❌ 没有找到任何视频数据', {
                        chat_id: chatId,
                        message_id: processingMsg.message_id
                    });
                    return;
                }
                const sessionId = createSession(
                    userId,
                    '/random_videos',
                    results,
                    total,
                    '',
                    { source: 'random_videos', pageSize: textCount }
                );
                const title = `🔍 找到 ${total} 条视频数据：\n`;
                const lines = [title];
                results.forEach((item, idx) => {
                    const globalIndex = idx + 1;
                    lines.push(formatResultLine(item, globalIndex, total));
                });
                const formattedText = lines.join('\n');
                const keyboard = {
                    inline_keyboard: [[
                        { text: '查看', callback_data: `rshow:${sessionId}` }
                    ]]
                };
                await bot.editMessageText(formattedText, {
                    chat_id: chatId,
                    message_id: processingMsg.message_id,
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
                insertLog(11, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
                logger.success(`用户 ${userId} /random_videos (文字模式) 结果已发送，会话ID: ${sessionId}`);
            }
        } catch (err) {
            logger.error(`用户 ${userId} /random_videos 处理失败: ${err.message}`);
            try {
                await bot.editMessageText('❌ 视频搜索失败，请稍后重试', {
                    chat_id: chatId,
                    message_id: processingMsg.message_id
                });
            } catch (editErr) {
                logger.error(`编辑错误消息失败: ${editErr.message}`);
            }
        }
    })();
}

module.exports = handleRandomVideosCommand;