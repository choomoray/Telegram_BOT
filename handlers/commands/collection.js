// handlers/commands/collections.js
const bot = require('../../bot');
const logger = require('../../logger');
const { setUserState, getRawUserState } = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { showMainMenu } = require('../modes/collectionMode');

async function handleCollectionCommand(userId, msg) {
    const rawState = getRawUserState(userId);
    if (rawState && rawState.mode === 'collection') {
        const { updateUserActivity } = require('../../states');
        updateUserActivity(userId);
        return;
    }

    await cleanPreviousMode(userId);

    const sentMsg = await bot.sendMessage(userId, '📚 合集管理', {
        reply_to_message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] }
    }).catch(err => {
        logger.error(`发送合集模式消息失败: ${err.message}`);
        return null;
    });

    if (sentMsg) {
        setUserState(userId, {
            mode: 'collection',
            step: 'main',
            mainMsgId: sentMsg.message_id,
            lastActivity: Date.now()
        });
        logger.info(`用户 ${userId} 进入合集模式，主消息ID: ${sentMsg.message_id}`);
        await showMainMenu(userId, sentMsg.message_id);
    }
}

module.exports = handleCollectionCommand;
