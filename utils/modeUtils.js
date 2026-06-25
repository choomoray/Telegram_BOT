// utils/modeUtils.js
const { getRawUserState, getUserState, deleteUserState } = require('../states');
const { clearMediaGroupState } = require('../media');
const logger = require('../logger');
const { repeatModeMsg } = require('./reply');

/**
 * 安全进入新模式（处理冲突和清理）
 * @param {number} userId - 用户ID
 * @param {string} targetMode - 目标模式名称
 * @param {Object} newState - 要设置的新状态（不含 mode 字段，会自动合并）
 * @param {Object} bot - bot 实例，用于发送提醒
 * @returns {boolean} 是否成功设置（若重复进入则返回 false 表示仅重置）
 */
async function enterMode(userId, targetMode, newState, bot) {
    const rawState = getRawUserState(userId);

    // 检查是否已在相同模式中
    if (rawState && rawState.mode === targetMode) {
        // 已经在目标模式，仅重置活动时间
        const { updateUserActivity } = require('../states');
        updateUserActivity(userId);
        logger.info(`用户 ${userId} 已在 ${targetMode} 模式中，仅重置活动时间`);
        if (bot) {
            const modeName = targetMode === 'chat' ? '聊天' : (targetMode || '该');
            await bot.sendMessage(userId, repeatModeMsg(modeName, '继续操作即可'))
                .catch(err => logger.error('发送重复进入提示失败:', err.message));
        }
        return false;
    }

    // 清理可能冲突的媒体收集状态（特殊处理，因为它们有收集数据）
    if (rawState && ['media_group', 'media_hide', 'media_unhide'].includes(rawState.mode)) {
        await clearMediaGroupState(userId, true);
    } else if (rawState && rawState.mode !== targetMode) {
        // 其他普通模式直接清除
        deleteUserState(userId);
    }

    // 设置新模式状态
    const { setUserState } = require('../states');
    setUserState(userId, {
        mode: targetMode,
        lastActivity: Date.now(),
        ...newState
    });

    logger.info(`用户 ${userId} 进入 ${targetMode} 模式`);
    return true;
}

module.exports = { enterMode };