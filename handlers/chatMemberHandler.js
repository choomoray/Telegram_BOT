// handlers/chatMemberHandler.js
/**
 * chat_member 事件处理（成员进出 / 解封）——从 index.js 抽出来，便于单测。
 *
 * 核心规则：
 *   - `member/administrator/creator`：库中已封禁（state=0）的用户加入 → 立即踢出并全面封禁；
 *     否则登记加入（addUserToGroup）。
 *   - `left/kicked`：**退出即封禁**（本项目的既定策略）→ removeUserFromGroup → banUserFully(auto)；
 *     但"刚被解封"的用户（TTL 内）忽略，避免解封回显导致又封回去。
 *   - `kicked → 非 kicked`：这是**管理员在 Telegram 侧解除封禁**（频道/群「已移除用户 / 黑名单」里移除该用户），
 *     用户并没有主动退群！以前只按新状态判断会把 `left` 当成退群 → 立刻又封回去。
 *     现在识别为解封：同步库状态为正常 + 标记"最近解封" + 绝不触发自动封禁。
 */
const logger = require('../logger');
const { logOperation } = require('../utils/opLog');
const {
    addUserToGroup,
    removeUserFromGroup,
    updateLastSeen,
    banUserFully,
    userOperationLocks,
    isRecentlyUnbanned,
    setUserState,
    markRecentlyUnbanned
} = require('../db/users');

const MEMBER_STATUSES = ['member', 'administrator', 'creator'];

/**
 * 管理员在 Telegram 侧解除封禁时同步库状态：
 * 把 state 同步回正常（1），并标记"最近解封"以忽略后续 left/kicked 回显。
 * 其它聊天里 Telegram 侧的封禁状态保持原样（只解除了这一个聊天）。
 * @param {number} userId
 * @param {string} [userName]
 */
async function syncManualUnban(userId, userName) {
    const { getCollection, COLLECTIONS } = require('../db/getCollection');
    const usersCol = getCollection(COLLECTIONS.USERS);
    const user = await usersCol.findOne({ id: userId });

    if (user && user.state === 0) {
        await setUserState(userId, 1);
        logger.info(`检测到管理员在 Telegram 侧解封用户 ${userId}（kicked → 非 kicked），库状态已同步为正常`);
        logOperation({
            action: 'user_unban',
            source: 'system',
            target: { type: 'user', id: userId },
            counts: { users: 1 },
            detail: { via: 'telegram_manual', name: user.name || userName || undefined }
        }).catch(() => { });
    }
    markRecentlyUnbanned(userId);
}

/**
 * 处理一次 chat_member 更新
 * @param {Object} update - Telegram chat_member update（含 chat / old_chat_member / new_chat_member）
 */
async function handleChatMemberUpdate(update) {
    const chat = update && update.chat;
    const newMember = update && update.new_chat_member;
    if (!chat || !newMember || !newMember.user) return;

    const userId = newMember.user.id;
    const userName = newMember.user.username ||
        `${newMember.user.first_name || ''} ${newMember.user.last_name || ''}`.trim() ||
        `User${userId}`;

    if (userOperationLocks.has(userId)) {
        logger.info(`用户 ${userId} 正在被管理员操作，忽略自动成员变动事件`);
        return;
    }

    const newStatus = newMember.status;
    // 旧状态：用来区分「管理员解封」与「真的退群 / 被踢」
    const oldStatus = update.old_chat_member ? update.old_chat_member.status : undefined;
    await updateLastSeen(userId).catch(() => { });

    // 管理员在 Telegram 侧解除封禁（黑名单里移除）：kicked → left / member，**不是退群**
    if (oldStatus === 'kicked' && newStatus !== 'kicked') {
        await syncManualUnban(userId, userName);
        if (MEMBER_STATUSES.includes(newStatus)) {
            await addUserToGroup(userId, userName, chat.id);
            logger.info(`用户 ${userId} (${userName}) 在 ${chat.id} 被解封并回到成员状态: ${newStatus}`);
            logOperation({
                action: 'user_join',
                source: 'system',
                userId,
                chatId: chat.id,
                target: { type: 'user', id: userId },
                counts: { users: 1 },
                detail: { userName, status: newStatus, afterUnban: true, chatName: chat.title || chat.username || undefined }
            }).catch(() => { });
        }
        return;
    }

    if (MEMBER_STATUSES.includes(newStatus)) {
        const { getCollection, COLLECTIONS } = require('../db/getCollection');
        const usersCol = getCollection(COLLECTIONS.USERS);
        const user = await usersCol.findOne({ id: userId });
        if (user && user.state === 0) {
            logger.warn(`封禁用户 ${userId} 尝试加入群组 ${chat.id}，立即踢出并全面封禁`);
            await banUserFully(userId, 'auto').catch(err => logger.error(`踢出封禁用户失败: ${err.message}`));
            return;
        }
        await addUserToGroup(userId, userName, chat.id);
        logger.info(`用户 ${userId} (${userName}) 加入群组 ${chat.id} (状态: ${newStatus})`);
        logOperation({
            action: 'user_join',
            source: 'system',
            userId,
            chatId: chat.id,
            target: { type: 'user', id: userId },
            counts: { users: 1 },
            detail: { userName, status: newStatus, chatName: chat.title || chat.username || undefined }
        }).catch(() => { });
        return;
    }

    if (['left', 'kicked'].includes(newStatus)) {
        // 解封动作回显：用户刚被（管理员/机器人）解封，unban 会产生 left 状态更新，
        // 不视为主动退群，跳过"退出即封禁"，避免"解封后机器人立刻又封禁"
        if (isRecentlyUnbanned(userId)) {
            logger.info(`用户 ${userId} 刚被解封，忽略 left/kicked 状态更新，不做退出封禁`);
            return;
        }
        await removeUserFromGroup(userId, chat.id);
        logger.info(`用户 ${userId} 离开群组 ${chat.id} (状态: ${newStatus})`);
        logOperation({
            action: 'user_leave',
            source: 'system',
            userId,
            chatId: chat.id,
            target: { type: 'user', id: userId },
            counts: { users: 1 },
            detail: { userName, status: newStatus, autoBanned: true, chatName: chat.title || chat.username || undefined }
        }).catch(() => { });
    }
}

module.exports = { handleChatMemberUpdate, syncManualUnban, MEMBER_STATUSES };
