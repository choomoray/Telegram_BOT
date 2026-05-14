// utils/enterMode.js
const { getRawUserState, deleteUserState } = require('../states');
const { clearMediaGroupState } = require('../media');

/**
 * 清理用户上一个非当前目标模式的状态
 * 在模式切换前调用，避免多个模式冲突
 */
async function cleanPreviousMode(userId) {
    const state = getRawUserState(userId);
    if (!state) return;

    const mode = state.mode;
    if (['media_group', 'media_hide', 'media_unhide'].includes(mode)) {
        await clearMediaGroupState(userId, true);
    } else {
        deleteUserState(userId);
    }
}

module.exports = { cleanPreviousMode };