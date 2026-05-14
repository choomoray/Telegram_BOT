// handlers/modes/index.js
const logger = require('../../logger');
const chatMode = require('./chatMode');
const mediaCollectMode = require('./mediaCollectMode');
const messageReplyMode = require('./messageReplyMode');
const searchMode = require('./searchMode');
const deleteMode = require('./deleteMode');
const deleteGroupMode = require('./deleteGroupMode');
const cleanMode = require('./cleanMode');
const markMode = require('./markMode');
const editMode = require('./editMode');
const { handleSettingMessage } = require('./settingMode');
const { handleTransportMessage } = require('./transportMode');
const { handlePasswordMessage } = require('./passwordMode');
const { handleManageMessage } = require('./manage');

const modeHandlers = {
    chat: chatMode,
    media_group: mediaCollectMode,
    media_hide: mediaCollectMode,
    media_unhide: mediaCollectMode,
    message_reply: messageReplyMode,
    search: searchMode,
    delete: deleteMode,
    delete_group: deleteGroupMode,
    clean: cleanMode,
    mark: markMode,
    edit: editMode,
    setting: handleSettingMessage,
    transport: handleTransportMessage,
    password: handlePasswordMessage,
    manage: handleManageMessage
};

async function handleModeMessage(msg, state) {
    const mode = state.mode;
    const handler = modeHandlers[mode];
    if (!handler) {
        logger.warn(`未知模式: ${mode}，用户 ${msg.from.id}`);
        return false;
    }
    return handler(msg, state);
}

module.exports = handleModeMessage;