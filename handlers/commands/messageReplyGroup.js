// handlers/commands/messageReplyGroup.js
/**
 * /message_reply_group 指令：消息回复（直接回复在群组中）
 * 定位到目标消息后，不询问回复位置，直接在群组中回复。
 * 非频道转发消息（只有群组位置）同样回复在群组。
 */
const { enterMessageReplyMode } = require('./messageReply');

module.exports = (userId, msg) => enterMessageReplyMode(userId, msg, 'group');
