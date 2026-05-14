// states.js
const { INACTIVE_TIMEOUT } = require('./config');
const logger = require('./logger');

const userStates = new Map();

/**
 * 获取用户状态，同时进行惰性超时检查
 * 修复：仅当状态存在且超时时间已过，才返回 null，同时发出超时警告
 * 但绝不在这里删除状态！状态删除统一由超时分支处理。
 */
function getUserState(userId) {
    const state = userStates.get(userId);
    if (!state) return null;

    // 检查是否超时
    if (Date.now() - state.lastActivity > INACTIVE_TIMEOUT) {
        // 仅返回 null，不删除状态，状态保留供超时分支清理
        logger.info(`用户 ${userId} 状态超时 (mode=${state.mode})，由调用者处理`);
        return null;
    }
    return state;
}

/**
 * 更新用户最后活动时间
 */
function updateUserActivity(userId) {
    const state = userStates.get(userId);
    if (state) {
        state.lastActivity = Date.now();
        userStates.set(userId, state);
    }
}

/**
 * 设置用户状态（直接覆盖）
 */
function setUserState(userId, state) {
    userStates.set(userId, state);
}

/**
 * 删除用户状态
 */
function deleteUserState(userId) {
    userStates.delete(userId);
}

/**
 * 检查用户是否存在状态
 */
function hasUserState(userId) {
    return userStates.has(userId);
}

/**
 * 获取原始状态（不检查超时）
 */
function getRawUserState(userId) {
    return userStates.get(userId);
}

module.exports = {
    userStates,
    getUserState,
    updateUserActivity,
    setUserState,
    deleteUserState,
    hasUserState,
    getRawUserState
};