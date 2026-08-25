// handlers/commands/mediaUnhide.js
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
const { getClampedNumberArg } = require('../../utils/commandArgs');

async function handleMediaUnhideCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'media_unhide') {
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 重复发送 /media_unhide，仅重置活动时间`);
        await bot.sendMessage(userId, repeatModeMsg('媒体去遮罩', '继续发送媒体即可'))
            .catch(err => logger.error('发送消息失败:', err.message));
        return;
    }

    await cleanPreviousMode(userId);

    // 参数：/media_unhide N → 退出时按 N 个一组打包发回（1~10）
    const groupSize = getClampedNumberArg(msg, 1, 10);
    if (groupSize !== null) {
        logger.info(`用户 ${userId} /media_unhide 参数 ${groupSize} → 每组 ${groupSize} 个媒体`);
    }

    setUserState(userId, {
        mode: 'media_unhide',
        lastActivity: Date.now(),
        mediaItems: [],
        spoilerAction: 'remove',
        ...(groupSize !== null ? { groupSize } : {}),
        _onExit: async () => { }
    });
    logger.info(`用户 ${userId} 进入媒体去遮罩模式`);
    const sizeHint = groupSize !== null ? `\n📦 退出时按 ${groupSize} 个为一组打包发送` : '';
    await bot.sendMessage(userId, `✅ 已进入媒体去遮罩模式\n🎭 请发送图片或视频，退出时自动移除 spoiler 遮罩。${sizeHint}\n使用 /exit 退出或10分钟无操作自动退出，收集的媒体将分组发送给你。`)
        .catch(err => logger.error('发送消息失败:', err.message));

    insertLog(21, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
}

module.exports = handleMediaUnhideCommand;