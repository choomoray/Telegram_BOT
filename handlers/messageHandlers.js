// handlers/messageHandlers.js
const logger = require('../logger');
const bot = require('../bot');
const { getUserDisplayName } = require('../utils/helpers');
const {
    getUserState,
    updateUserActivity,
    setUserState,
    getRawUserState,
    deleteUserState
} = require('../states');
const { executeCommand } = require('./commands');
const { handleQuery, isAdmin } = require('./queryHandler');
const handleModeMessage = require('./modes');
const config = require('../config');
const { clearMediaGroupState } = require('../media');
const { updateLastSeen } = require('../db/users');
const { getModeName } = require('../utils/modeNames'); // 新增

async function handlePrivateMessage(msg) {
    const userId = msg.from.id;
    const userName = getUserDisplayName(msg.from);
    const messageText = msg.text || '';

    // 更新最后活跃时间（无论什么消息）
    await updateLastSeen(userId).catch(() => { });

    // ---------- 管理员 / 白名单 + 封禁检查 ----------
    if (!isAdmin(userId)) {
        const { isUserAllowed } = require('../db/users');
        const allowed = await isUserAllowed(userId);
        if (!allowed) {
            await bot.sendMessage(userId, '❌ 您已被封禁或未被加入白名单，无法使用私聊功能', {
                reply_to_message_id: msg.message_id,
                allow_sending_without_reply: true
            }).catch(err => logger.error('发送权限错误提示失败:', err.message));
            logger.info(`用户 ${userId} 尝试使用私聊，但被拒绝`);
            return;
        }
    }

    const rawState = getRawUserState(userId);
    if (rawState) {
        updateUserActivity(userId);
    }

    if (messageText.startsWith('/')) {
        const fullCommand = messageText.trim();
        const executed = await executeCommand(fullCommand, userId, msg);
        if (executed) {
            return;
        } else {
            await bot.sendMessage(userId, '❌ 指令错误', {
                reply_to_message_id: msg.message_id,
                allow_sending_without_reply: true
            }).catch(err => logger.error('发送指令错误提示失败:', err.message));
            return;
        }
    }

    let currentState = getUserState(userId);
    if (!currentState && rawState) {
        const mode = rawState.mode;

        if (mode === 'media_group' || mode === 'media_hide' || mode === 'media_unhide') {
            const totalMedia = (rawState.mediaItems || []).length;
            await clearMediaGroupState(userId, true, rawState);
            let modeName = mode === 'media_hide' ? '媒体遮罩模式' : (mode === 'media_unhide' ? '媒体去遮罩模式' : '媒体合并模式');

            let exitMsg = `✅ 已退出${modeName}（超时）`;
            if (mode === 'media_group' && totalMedia > 0) {
                const groupTotal = rawState.groupSize || 10;
                const fullGroups = Math.floor(totalMedia / groupTotal);
                const remainder = totalMedia % groupTotal;
                if (remainder > 0) {
                    exitMsg += `，共合并媒体 ${fullGroups * groupTotal} (+${remainder}) 个，${fullGroups} (+1) 组`;
                } else {
                    exitMsg += `，共合并媒体 ${totalMedia} 个，${fullGroups} 组`;
                }
            }

            await bot.sendMessage(userId, exitMsg).catch(() => { });
            deleteUserState(userId);
            logger.info(`用户 ${userId} ${mode}模式超时自动退出`);
            currentState = getUserState(userId);
        } else {
            if (rawState._onExit) {
                await rawState._onExit(userId, rawState);
            }
            deleteUserState(userId);

            const modeName = getModeName(mode);
            await bot.sendMessage(userId, `✅ 已退出${modeName}（超时）`).catch(() => { });
            logger.info(`用户 ${userId} ${mode}模式超时自动退出`);
            currentState = getUserState(userId);
        }
    }

    if (!currentState && rawState) {
        const mode = rawState.mode;
        logger.info(`用户 ${userId} 状态超时后仍然存在，强制重新激活 (mode=${mode})`);
        setUserState(userId, {
            ...rawState,
            lastActivity: Date.now()
        });
        currentState = getUserState(userId);
    }

    if (currentState) {
        const handled = await handleModeMessage(msg, currentState);
        if (handled) return;
    }

    if (messageText && !messageText.startsWith('/')) {
        await handleQuery(msg);
    }
}

module.exports = { handlePrivateMessage };