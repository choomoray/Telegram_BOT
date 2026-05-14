// utils/sendMedia.js
const bot = require('../bot');

async function sendMediaGroup(chatId, mediaItems, type, replyToMessageId) {
    if (!mediaItems || mediaItems.length === 0) return;
    const chunks = [];
    for (let i = 0; i < mediaItems.length; i += 10) {
        chunks.push(mediaItems.slice(i, i + 10));
    }
    for (const chunk of chunks) {
        const mediaGroup = chunk.map(item => ({
            type: type,
            media: item.file_id,
            caption: undefined
        }));
        await bot.sendMediaGroup(chatId, mediaGroup, {
            reply_to_message_id: replyToMessageId,
            allow_sending_without_reply: true
        });
        if (chunks.length > 1) await new Promise(resolve => setTimeout(resolve, 200));
    }
}

module.exports = { sendMediaGroup };
