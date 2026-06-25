// handlers/commands/setting.js
const bot = require('../../bot');
const logger = require('../../logger');
const { setUserState, deleteUserState, getUserState, updateUserActivity } = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');

async function handleSettingCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'setting') {
        updateUserActivity(userId);
        const settingMode = require('../modes/settingMode');
        if (settingMode && settingMode.refreshSettings) {
            await settingMode.refreshSettings(userId, state);
        }
        return;
    }

    await cleanPreviousMode(userId);

    let loadingMsg;
    try {
        loadingMsg = await bot.sendMessage(userId, '♻️ 正在拉取云端设置...', {
            reply_to_message_id: msg.message_id,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`发送拉取设置消息失败: ${err.message}`);
        return;
    }

    setUserState(userId, {
        mode: 'setting',
        step: 'main',
        page: 1,
        lastActivity: Date.now(),
        processingMsgId: loadingMsg.message_id,
        _onExit: async () => { }
    });

    logger.info(`用户 ${userId} 进入设置模式`);

    const settingMode = require('../modes/settingMode');
    try {
        await settingMode.showSettings(userId, 1, loadingMsg.message_id);
    } catch (err) {
        logger.error(`加载设置失败: ${err.message}`);
        try {
            await bot.editMessageText('❌ 加载设置失败，请稍后重试', {
                chat_id: userId,
                message_id: loadingMsg.message_id
            });
        } catch (editErr) {
            logger.error(`编辑错误消息失败: ${editErr.message}`);
        }
        deleteUserState(userId);
    }
}

module.exports = handleSettingCommand;