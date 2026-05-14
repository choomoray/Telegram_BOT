// handlers/commands/transport.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    getUserState,
    setUserState,
    updateUserActivity
} = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');

async function handleTransportCommand(userId, msg) {
    const state = getUserState(userId);
    if (state && state.mode === 'transport') {
        updateUserActivity(userId);
        const transportMode = require('../modes/transportMode');
        await transportMode.showTransportList(userId, state.mainMsgId);
        return;
    }

    await cleanPreviousMode(userId);

    const transportMode = require('../modes/transportMode');
    const sentMsg = await transportMode.showTransportList(userId, null, msg.message_id);

    if (sentMsg) {
        setUserState(userId, {
            mode: 'transport',
            step: 'main',
            mainMsgId: sentMsg.message_id,
            lastActivity: Date.now(),
            _onExit: async () => { }
        });
        logger.info(`用户 ${userId} 进入搬运模式，主消息ID: ${sentMsg.message_id}`);
    } else {
        logger.error(`用户 ${userId} 进入搬运模式失败`);
    }
}

module.exports = handleTransportCommand;