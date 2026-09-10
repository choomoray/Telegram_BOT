// handlers/commands/search.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    getUserState,
    setUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { repeatModeMsg } = require('../../utils/reply');
const { logOperation } = require('../../utils/opLog');

async function handleSearchCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'search') {
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 重复发送 /search，仅重置活动时间`);
        await bot.sendMessage(userId, repeatModeMsg('查找', '请发送需要查找的媒体'))
            .catch(err => logger.error('发送消息失败:', err.message));
        return;
    }

    await cleanPreviousMode(userId);

    setUserState(userId, {
        mode: 'search',
        lastActivity: Date.now(),
        _onExit: async () => { }
    });

    logger.info(`用户 ${userId} 进入查找模式`);

    await bot.sendMessage(userId, '✅ 已进入查找模式，请发送需要查找的媒体', {
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
    }).catch(err => logger.error('发送查找模式提示失败:', err.message));

    // /search 本身只是进入查找模式（真正的查找媒体操作在 searchMode 内完成）
    logOperation({
        action: 'search',
        source: 'private',
        userId,
        detail: { mode: 'enter_search_mode' }
    }).catch(() => { });
}

module.exports = handleSearchCommand;