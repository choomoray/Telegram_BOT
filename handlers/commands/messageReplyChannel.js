// handlers/commands/messageReplyChannel.js
/**
 * /message_reply_channel 指令：消息回复（直接回复在频道中）
 * 定位到目标消息后，不询问回复位置，直接在频道中回复。
 * 非频道转发消息（没有频道位置）回退为回复在消息自身所在位置。
 */
const { enterMessageReplyMode } = require('./messageReply');

module.exports = (userId, msg) => enterMessageReplyMode(userId, msg, 'channel');
