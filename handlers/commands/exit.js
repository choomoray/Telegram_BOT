// handlers/commands/exit.js
const bot = require('../../bot');
const logger = require('../../logger');
const { deleteUserState, getRawUserState } = require('../../states');
const { clearMediaGroupState } = require('../../media');
const { getModeName } = require('../../utils/modeNames');

async function handleExitCommand(userId, msg) {
    const rawState = getRawUserState(userId);
    const fullCommand = msg.text.trim();
    const parts = fullCommand.split(/\s+/);
    const targetMode = parts[1];

    if (targetMode === 'chat') {
        if (rawState) {
            if (rawState._onExit) await rawState._onExit(userId, rawState);
            deleteUserState(userId);
            await bot.sendMessage(userId, '✅ 已退出聊天模式')
                .catch(err => logger.error('发送退出提醒失败:', err.message));
            logger.info(`用户 ${userId} 通过 /exit chat 手动退出聊天模式`);
        } else {
            await bot.sendMessage(userId, '当前不在聊天模式中，无需退出。')
                .catch(err => logger.error('发送消息失败:', err.message));
        }
        return;
    }

    if (!rawState) {
        await bot.sendMessage(userId, '当前没有活跃的模式，无需退出。')
            .catch(err => logger.error('发送消息失败:', err.message));
        return;
    }

    const mode = rawState.mode;

    // 媒体收集模式：先传入 rawState 发送媒体，再执行退出
    if (['media_group', 'media_hide', 'media_unhide'].includes(mode)) {
        // 提取状态副本，因为 exit 会删除状态
        const stateCopy = { ...rawState };
        const totalMedia = (stateCopy.mediaItems || []).length;
        await clearMediaGroupState(userId, true, stateCopy);
        let modeName;
        if (mode === 'media_hide') modeName = '媒体遮罩模式';
        else if (mode === 'media_unhide') modeName = '媒体去遮罩模式';
        else modeName = '媒体合并模式';

        let exitMsg = `✅ 已退出${modeName}`;
        if (mode === 'media_group' && totalMedia > 0) {
            const groupTotal = stateCopy.groupSize || 10;
            const fullGroups = Math.floor(totalMedia / groupTotal);
            const remainder = totalMedia % groupTotal;
            if (remainder > 0) {
                exitMsg += `，共合并媒体 ${fullGroups * groupTotal} (+${remainder}) 个，${fullGroups} (+1) 组`;
            } else {
                exitMsg += `，共合并媒体 ${totalMedia} 个，${fullGroups} 组`;
            }
        }

        await bot.sendMessage(userId, exitMsg)
            .catch(err => logger.error('发送退出提醒失败:', err.message));
        logger.info(`用户 ${userId} 手动退出${modeName}`);
        return;
    }

    // 其他模式通用退出
    if (rawState._onExit) {
        await rawState._onExit(userId, rawState);
    }

    deleteUserState(userId);

    const modeName = getModeName(mode);
    await bot.sendMessage(userId, `✅ 已退出${modeName}`)
        .catch(err => logger.error('发送退出提醒失败:', err.message));

    logger.info(`用户 ${userId} 手动退出${modeName}模式`);
}

module.exports = handleExitCommand;