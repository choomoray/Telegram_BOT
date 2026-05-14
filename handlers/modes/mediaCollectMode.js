// handlers/modes/mediaCollectMode.js
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

    logger.info(`用户 ${userId} 收集媒体 [${mediaInfo.type}]，当前总数: ${newMediaItems.length}`);
    return true;
}

module.exports = handleMediaCollectMode;