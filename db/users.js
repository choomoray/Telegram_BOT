// db/users.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const { safeApiCall } = require('../utils/safeApiCall');
const { logOperation } = require('../utils/opLog');
const logger = require('../logger');
const bot = require('../bot');

function getCol() {
    return getCollection(COLLECTIONS.USERS);
}

async function addUserToGroup(userId, userName = '', groupId) {
    try {
        const col = getCol();
        const now = Date.now();
        const result = await col.updateOne(
            { id: userId },
            {
                $set: { name: userName || `User ${userId}`, last_seen: now },
                $addToSet: { group: groupId },
                $setOnInsert: { state: 1, white: 0, join_time: now }
            },
            { upsert: true }
        );
        logger.info(`用户 ${userId} (${userName}) 加入群组 ${groupId}，upserted=${result.upsertedCount > 0}`);
    } catch (err) {
        logger.error(`添加用户到群组失败: ${err.message}`);
    }
}

async function removeUserFromGroup(userId, groupId) {
    try {
        logger.info(`用户 ${userId} 退出频道 ${groupId}，开始全面封禁`);
        await banUserFully(userId, 'auto');
    } catch (err) {
        logger.error(`处理用户退出频道失败: ${err.message}`);
    }
}

/**
 * 更新用户最后活跃时间（消息活动时调用）
 */
async function updateLastSeen(userId) {
    try {
        const col = getCol();
        await col.updateOne({ id: userId }, { $set: { last_seen: Date.now() } });
    } catch (err) {
        // 静默失败，不影响主流程
    }
}

// 操作锁（封禁/解封操作期间忽略该用户的 chat_member 事件）
const userOperationLocks = new Set();

// 最近被机器人解封的用户（userId -> 过期时间戳）：
// 解封动作会在各聊天产生 left 状态更新（回显），若被 chat_member 处理器当作
// "主动退群"会触发"退出即封禁"——导致"管理员刚解封，机器人立刻又封禁"。
// 解封后在 TTL 内的 left/kicked 更新一律忽略（不触发退出封禁）。
const recentlyUnbanned = new Map();
const RECENT_UNBAN_TTL = 2 * 60 * 1000;

// 定期清理过期的解封记录
setInterval(() => {
    const now = Date.now();
    for (const [userId, expiry] of recentlyUnbanned.entries()) {
        if (now > expiry) recentlyUnbanned.delete(userId);
    }
}, 60 * 1000);

function markRecentlyUnbanned(userId) {
    recentlyUnbanned.set(userId, Date.now() + RECENT_UNBAN_TTL);
}

function isRecentlyUnbanned(userId) {
    const expiry = recentlyUnbanned.get(userId);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
        recentlyUnbanned.delete(userId);
        return false;
    }
    return true;
}

/**
 * 获取需要执行封禁/解封的聊天 ID 集合：
 * - 用户所在的全部群组/频道（user.group）
 * - 管理库中记录的全部群组与频道（channel_group，含绑定的频道↔群组对）
 * 两者并集去重，保证封禁/解封覆盖用户所在的全部聊天（含绑定关系两侧）。
 */
async function collectBanTargetChats(user) {
    const ids = new Set(user.group || []);
    try {
        const channelGroupCol = getCollection(COLLECTIONS.CHANNEL_GROUP);
        const all = await channelGroupCol.find({}).toArray();
        for (const g of all) {
            ids.add(g.id);
        }
    } catch (err) {
        logger.error(`获取 channel_group 列表失败: ${err.message}`);
    }
    return [...ids];
}

async function banUserFully(userId, source = 'manual') {
    const col = getCol();
    const user = await col.findOne({ id: userId });
    if (!user) {
        logger.warn(`封禁失败：用户 ${userId} 不在数据库中`);
        return { success: false, banned: 0, failed: 0 };
    }

    await col.updateOne({ id: userId }, { $set: { state: 0 } });
    logger.info(`用户 ${userId} 已设置为封禁状态 (source=${source})`);

    const chatIds = await collectBanTargetChats(user);
    let banned = 0;
    let failed = 0;

    for (const chatId of chatIds) {
        try {
            await safeApiCall(() => bot.banChatMember(chatId, userId));
            banned++;
            logger.info(`已在聊天 ${chatId} 中封禁并踢出用户 ${userId}`);
        } catch (err) {
            failed++;
            logger.warn(`在聊天 ${chatId} 中封禁用户 ${userId} 失败: ${err.message}`);
        }
    }

    logger.info(`用户 ${userId} 封禁完成: 成功 ${banned}，失败 ${failed}`);
    logOperation({
        action: 'user_ban',
        source: source === 'auto' ? 'system' : 'private',
        target: { type: 'user', id: userId },
        counts: { users: 1, chats: chatIds.length },
        detail: { source, name: user.name, banned, failed, chatCount: chatIds.length }
    }).catch(() => { });
    return { success: true, banned, failed };
}

async function unbanUserFully(userId) {
    const col = getCol();
    const user = await col.findOne({ id: userId });
    if (!user) {
        logger.warn(`解封失败：用户 ${userId} 不在数据库中`);
        return { success: false, unbanned: 0, failed: 0 };
    }

    await col.updateOne({ id: userId }, { $set: { state: 1 } });
    // 标记最近解封：TTL 内忽略该用户的 left/kicked 状态更新，防止解封动作回显触发"退出即封禁"
    markRecentlyUnbanned(userId);
    logger.info(`用户 ${userId} 已设置为解封状态`);

    const chatIds = await collectBanTargetChats(user);
    let unbanned = 0;
    let failed = 0;

    for (const chatId of chatIds) {
        try {
            await bot.unbanChatMember(chatId, userId);
            unbanned++;
            logger.info(`已在聊天 ${chatId} 中解封用户 ${userId}`);
        } catch (err) {
            failed++;
            logger.warn(`在聊天 ${chatId} 中解封用户 ${userId} 失败: ${err.message}`);
        }
    }

    logger.info(`用户 ${userId} 解封完成: 成功 ${unbanned}，失败 ${failed}`);
    logOperation({
        action: 'user_unban',
        source: 'private',
        target: { type: 'user', id: userId },
        counts: { users: 1, chats: chatIds.length },
        detail: { name: user.name, unbanned, failed, chatCount: chatIds.length }
    }).catch(() => { });
    return { success: true, unbanned, failed };
}

async function isUserAllowed(userId) {
    try {
        const col = getCol();
        const user = await col.findOne({ id: userId });
        if (!user) return false;
        if (user.state === 0) return false;
        return user.white === 1;
    } catch (err) {
        logger.error(`查询用户权限失败: ${err.message}`);
        return false;
    }
}

async function setUserState(userId, state) {
    try {
        const col = getCol();
        await col.updateOne({ id: userId }, { $set: { state } });
        logger.info(`用户 ${userId} 状态更新为 ${state}`);
    } catch (err) {
        logger.error(`设置用户状态失败: ${err.message}`);
    }
}

async function setUserWhite(userId, white) {
    try {
        const col = getCol();
        await col.updateOne({ id: userId }, { $set: { white } });
        logger.info(`用户 ${userId} 白名单更新为 ${white}`);
    } catch (err) {
        logger.error(`设置用户白名单失败: ${err.message}`);
    }
}

async function getAllUsers() {
    try {
        const col = getCol();
        return await col.find({}).toArray();
    } catch (err) {
        logger.error(`获取所有用户失败: ${err.message}`);
        return [];
    }
}

module.exports = {
    addUserToGroup,
    removeUserFromGroup,
    updateLastSeen,
    banUserFully,
    unbanUserFully,
    isUserAllowed,
    setUserState,
    setUserWhite,
    getAllUsers,
    userOperationLocks,
    markRecentlyUnbanned,
    isRecentlyUnbanned
};
