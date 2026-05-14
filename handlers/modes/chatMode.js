// handlers/modes/chatMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { handleChatMessage } = require('../commands/chat');

async function handleChatMode(msg, state) {
    if (!msg.text) return false;
    return handleChatMessage(msg.from.id, msg);
}

module.exports = handleChatMode;
