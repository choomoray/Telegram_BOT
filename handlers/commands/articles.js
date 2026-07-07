// handlers/commands/article.js
const bot = require('../../bot');
const logger = require('../../logger');
const { setUserState, getRawUserState } = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { showMainMenu } = require('../modes/articleMode');

async function handleArticleCommand(userId, msg) {
    const rawState = getRawUserState(userId);
    if (rawState && rawState.mode === 'article') {
        logger.info(`用户 ${userId} 重复发送 /article，仅重置活动时间`);
        const { updateUserActivity } = require('../../states');
        updateUserActivity(userId);
        return;
    }

    await cleanPreviousMode(userId);

    const sentMsg = await bot.sendMessage(userId, '📄 文章管理', {
        reply_to_message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] }
    }).catch(err => {
        logger.error(`发送文章模式消息失败: ${err.message}`);
        return null;
    });

    if (sentMsg) {
        setUserState(userId, {
            mode: 'article',
            step: 'main',
            mainMsgId: sentMsg.message_id,
            lastActivity: Date.now()
        });
        logger.info(`用户 ${userId} 进入文章模式，主消息ID: ${sentMsg.message_id}`);
        await showMainMenu(userId, sentMsg.message_id);
    }
}

module.exports = handleArticleCommand;
