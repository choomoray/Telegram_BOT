// handlers/modes/mediaCollectMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { extractMediaFromMessage } = require('../../media');
const { setUserState, updateUserActivity } = require('../../states');

/**
 * 统一的媒体收集模式处理器
 * @param {Object} msg - Telegram 消息对象
 * @param {Object} state - 用户状态，包含 mode、mediaItems、spoilerAction 等
 * @returns {boolean}
 */
async function handleMediaCollectMode(msg, state) {
    const userId = msg.from.id;
    const mediaInfo = extractMediaFromMessage(msg);

    if (!mediaInfo) {
        logger.info(`用户 ${userId} 在 ${state.mode} 模式发送非媒体消息，已忽略`);
        return true;
    }

    const newMediaItems = [
        ...(state.mediaItems || []),
        {
            type: mediaInfo.type,
            fileId: mediaInfo.fileId,
            caption: mediaInfo.caption,
            has_spoiler: mediaInfo.has_spoiler,
            timestamp: Date.now()
        }
    ];

    setUserState(userId, {
        ...state,
        mediaItems: newMediaItems,
        lastActivity: Date.now()
    });

    const total = newMediaItems.length;
    logger.info(`用户 ${userId} 收集媒体 [${mediaInfo.type}]，当前总数: ${total}`);

    // 合并媒体组模式：达到每组个数倍数时发送进度提示
    const groupSize = state.groupSize;
    if (groupSize && groupSize > 0 && total % groupSize === 0) {
        const groupCount = Math.floor(total / groupSize);
        try {
            await bot.sendMessage(
                msg.chat.id,
                `💾 当前已接收 ${total} 个媒体，共 ${groupCount} 组`
            );
            logger.info(`用户 ${userId} 收集进度: ${total} 个媒体，${groupCount} 组`);
        } catch (err) {
            logger.error(`发送收集进度失败: ${err.message}`);
        }
    }

    return true;
}

module.exports = handleMediaCollectMode;