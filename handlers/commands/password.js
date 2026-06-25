// handlers/commands/password.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    getUserState,
    setUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { repeatModeMsg, entryMsg } = require('../../utils/reply');

async function handlePasswordCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'password') {
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 重复发送 /password，仅重置活动时间`);
        await bot.sendMessage(userId, repeatModeMsg('密码', '请使用按钮操作'))
            .catch(err => logger.error('发送消息失败:', err.message));
        return;
    }

    await cleanPreviousMode(userId);

    const keyboard = {
        inline_keyboard: [
            [{ text: '🔐 更新密码', callback_data: 'password:update' }],
            [{ text: '👁️ 查看密码', callback_data: 'password:view' }]
        ]
    };
    await bot.sendMessage(userId, entryMsg('密码模式', '请选择操作：'), {
        reply_to_message_id: msg.message_id,
        reply_markup: keyboard
    });

    setUserState(userId, {
        mode: 'password',
        step: 'main',
        lastActivity: Date.now(),
        _onExit: async () => { }
    });

    logger.info(`用户 ${userId} 进入密码模式`);
}

module.exports = handlePasswordCommand;