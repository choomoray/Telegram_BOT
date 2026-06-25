// handlers/commands/mediaHide.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    getUserState,
    setUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { insertLog } = require('../../db/log');
const { repeatModeMsg } = require('../../utils/reply');

async function handleMediaHideCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'media_hide') {
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 重复发送 /media_hide，仅重置活动时间`);
        await bot.sendMessage(userId, repeatModeMsg('媒体遮罩', '继续发送媒体即可'))
            .catch(err => logger.error('发送消息失败:', err.message));
        return;
    }

    await cleanPreviousMode(userId);

    setUserState(userId, {
        mode: 'media_hide',
        lastActivity: Date.now(),
        mediaItems: [],
        spoilerAction: 'add',
        _onExit: async () => { }
    });
    logger.info(`用户 ${userId} 进入媒体遮罩模式`);
    await bot.sendMessage(userId, '✅ 已进入媒体遮罩模式\n🎭 请发送图片或视频，退出时自动添加 spoiler 遮罩。\n使用 /exit 退出或10分钟无操作自动退出，收集的媒体将分组发送给你。')
        .catch(err => logger.error('发送消息失败:', err.message));

    insertLog(15, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
}

module.exports = handleMediaHideCommand;