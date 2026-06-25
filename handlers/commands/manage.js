// handlers/commands/manage.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getUserState, setUserState, updateUserActivity } = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { repeatModeMsg } = require('../../utils/reply');

async function handleManageCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'manage') {
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 重复发送 /manage，仅重置活动时间`);
        await bot.sendMessage(userId, repeatModeMsg('管理', '请使用按钮操作或输入 /exit 退出'))
            .catch(err => logger.error('发送消息失败:', err.message));
        return;
    }

    await cleanPreviousMode(userId);

    const keyboard = {
        inline_keyboard: [
            [{ text: '👥 群组管理', callback_data: 'manage:groups' }],
            [{ text: '👤 用户管理', callback_data: 'manage:users' }],
            [{ text: '📊 系统概览', callback_data: 'manage:dashboard' }]
        ]
    };

    const sentMsg = await bot.sendMessage(userId, '✅ 已进入管理模式', {
        reply_to_message_id: msg.message_id,
        reply_markup: keyboard
    }).catch(err => {
        logger.error(`发送管理模式消息失败: ${err.message}`);
        return null;
    });

    if (sentMsg) {
        setUserState(userId, {
            mode: 'manage',
            step: 'main',
            mainMsgId: sentMsg.message_id,
            lastActivity: Date.now(),
            _onExit: async () => { }
        });
        logger.info(`用户 ${userId} 进入管理模式，主消息ID: ${sentMsg.message_id}`);
    }
}

module.exports = handleManageCommand;