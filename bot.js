// bot.js
const TelegramBot = require('node-telegram-bot-api');
const { TELEGRAM_BOT_TOKEN } = require('./config');
const logger = require('./logger');

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

let lastPollingError = null;

bot.on('polling_error', (error) => {
    const errorKey = `${error.code}:${error.message}`;
    if (lastPollingError !== errorKey) {
        lastPollingError = errorKey;
        logger.error(`[polling_error] ${JSON.stringify({
            code: error.code,
            message: error.message
        })}`);
    }
});

function startBotPolling() {
    bot.startPolling({
        params: {
            allowed_updates: [
                'message',
                'edited_message',
                'callback_query',
                'chat_member',
                'my_chat_member',
                'chat_join_request'
            ]
        }
    });
}

module.exports = bot;
module.exports.startBotPolling = startBotPolling;