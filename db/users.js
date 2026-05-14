// db/users.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const { safeApiCall } = require('../utils/safeApiCall');
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

async function banUserFully(userId, source = 'manual') {
    const col = getCol();
    const user = await col.findOne({ id: userId });
    if (!user) {
        logger.warn(`封禁失败：用户 ${userId} 不在数据库中`);
        return { success: false, banned: 0, failed: 0 };
    }

    await col.updateOne({ id: userId }, { $set: { state: 0 } });
    logger.info(`用户 ${userId} 已设置为封禁状态 (source=${source})`);

    const groups = user.group || [];
    let banned = 0;
    let failed = 0;
    const processedIds = new Set(groups);

    for (const gId of groups) {
        try {
            await safeApiCall(() => bot.banChatMember(gId, userId));
            banned++;
            logger.info(`已在频道 ${gId} 中封禁并踢出用户 ${userId}`);
        } catch (err) {
            failed++;
            logger.warn(`在频道 ${gId} 中封禁用户 ${userId} 失败: ${err.message}`);
        }
    }

    try {
        const channelGroupCol = getCollection(COLLECTIONS.CHANNEL_GROUP);
        const allChannelGroups = await channelGroupCol.find({ type: 'group' }).toArray();
        for (const g of allChannelGroups) {
            if (!processedIds.has(g.id)) {
                try {
                    await bot.banChatMember(g.id, userId);
                    banned++;
                    logger.info(`已在 channel_group 群组 ${g.id} 中封禁并踢出用户 ${userId}`);
                } catch (err) {
                    failed++;
                    logger.warn(`在 channel_group 群组 ${g.id} 中封禁用户 ${userId} 失败: ${err.message}`);
                }
            }
        }
    } catch (err) {
        logger.error(`获取 channel_group 列表失败: ${err.message}`);
    }

    logger.info(`用户 ${userId} 封禁完成: 成功 ${banned}，失败 ${failed}`);
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
    logger.info(`用户 ${userId} 已设置为解封状态`);

    const groups = user.group || [];
    let unbanned = 0;
    let failed = 0;
    const processedIds = new Set(groups);

    for (const gId of groups) {
        try {
            await bot.unbanChatMember(gId, userId);
            unbanned++;
            logger.info(`已在频道 ${gId} 中解封用户 ${userId}`);
        } catch (err) {
            failed++;
            logger.warn(`在频道 ${gId} 中解封用户 ${userId} 失败: ${err.message}`);
        }
    }

    try {
        const channelGroupCol = getCollection(COLLECTIONS.CHANNEL_GROUP);
        const allChannelGroups = await channelGroupCol.find({ type: 'group' }).toArray();
        for (const g of allChannelGroups) {
            if (!processedIds.has(g.id)) {
                try {
                    await bot.unbanChatMember(g.id, userId);
                    unbanned++;
                    logger.info(`已在 channel_group 群组 ${g.id} 中解封用户 ${userId}`);
                } catch (err) {
                    failed++;
                    logger.warn(`在 channel_group 群组 ${g.id} 中解封用户 ${userId} 失败: ${err.message}`);
                }
            }
        }
    } catch (err) {
        logger.error(`获取 channel_group 列表失败: ${err.message}`);
    }

    logger.info(`用户 ${userId} 解封完成: 成功 ${unbanned}，失败 ${failed}`);
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

// 操作锁
const userOperationLocks = new Set();

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
    userOperationLocks
};