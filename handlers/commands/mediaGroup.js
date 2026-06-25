// handlers/commands/mediaGroup.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getSettings } = require('../../db/settings');
const { insertLog } = require('../../db/log');
const {
    getUserState,
    setUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { repeatModeMsg } = require('../../utils/reply');

async function handleMediaGroupCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'media_group') {
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 重复发送 /media_group，仅重置活动时间`);
        await bot.sendMessage(userId, repeatModeMsg('媒体合并', '继续发送媒体即可'))
            .catch(err => logger.error('发送消息失败:', err.message));
        return;
    }

    await cleanPreviousMode(userId);

    let groupSize = 10;
    try {
        const settings = await getSettings();
        if (settings && settings.media_group_num !== undefined) {
            let num = parseInt(settings.media_group_num);
            if (!isNaN(num)) {
                if (num < 1) num = 1;
                if (num > 10) num = 10;
                groupSize = num;
            }
        }
    } catch (err) {
        logger.warn(`获取 media_group_num 失败: ${err.message}`);
    }

    let processingMsg;
    try {
        processingMsg = await bot.sendMessage(userId, '♻️ 正在进入合并媒体组模式...', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送进入提示失败: ${err.message}`);
        return;
    }

    await bot.editMessageText(
        `✅ 已进入媒体合并模式\n📎 请发送图片、视频、音频或文件，我会自动收集。\n每组最多 ${groupSize} 个媒体，退出时自动分组发送。\n使用 /exit 退出或10分钟无操作自动退出。`,
        {
            chat_id: userId,
            message_id: processingMsg.message_id
        }
    );

    setUserState(userId, {
        mode: 'media_group',
        lastActivity: Date.now(),
        mediaItems: [],
        spoilerAction: 'none',
        groupSize: groupSize,
        _onExit: async () => { }
    });
    logger.info(`用户 ${userId} 进入媒体合并模式，每组最多 ${groupSize} 个媒体`);

    insertLog(14, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
}

module.exports = handleMediaGroupCommand;