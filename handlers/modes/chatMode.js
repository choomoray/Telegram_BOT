// handlers/modes/chatMode.js
const handleChatMessage = require('./chatMode/index');

async function handleChatMode(msg, state) {
    if (!msg.text) return false;
    return handleChatMessage(msg, state);
}

module.exports = handleChatMode;
