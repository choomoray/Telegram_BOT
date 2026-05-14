// db/transport.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

function getTransportCollection() {
    return getCollection(COLLECTIONS.TRANSPORT);
}

async function upsertTransport(data) {
    try {
        const col = getTransportCollection();
        const existing = await col.findOne({ chat_id: data.chat_id });
        let result;
        if (existing) {
            result = await col.updateOne(
                { chat_id: data.chat_id },
                { $set: { chat_name: data.chat_name, url: data.url }, $inc: { num: 1 } }
            );
            logger.info(`transport 更新: chat_id=${data.chat_id}, 新 num=${(existing.num || 0) + 1}`);
        } else {
            result = await col.insertOne({
                chat_id: data.chat_id,
                chat_name: data.chat_name,
                url: data.url,
                num: 0
            });
            logger.info(`transport 插入: chat_id=${data.chat_id}, num=0`);
        }
        return result;
    } catch (err) {
        logger.error(`transport upsert 失败: ${err.message}`);
        throw err;
    }
}

async function getAllTransports() {
    try {
        const col = getTransportCollection();
        let docs = await col.find({}).sort({ num: -1, chat_id: 1 }).toArray();
        let needUpdate = false;
        for (const doc of docs) {
            if (doc.num === undefined) {
                doc.num = 0;
                needUpdate = true;
            }
        }
        if (needUpdate) {
            await col.updateMany({ num: { $exists: false } }, { $set: { num: 0 } });
            logger.info('已为旧 transport 记录补全 num=0');
        }
        return docs;
    } catch (err) {
        logger.error(`获取 transport 列表失败: ${err.message}`);
        return [];
    }
}

async function getTransportByChatId(chatId) {
    try {
        const col = getTransportCollection();
        return await col.findOne({ chat_id: chatId });
    } catch (err) {
        logger.error(`获取 transport 失败: ${err.message}`);
        return null;
    }
}

async function deleteTransport(chatId) {
    try {
        const col = getTransportCollection();
        const result = await col.deleteOne({ chat_id: chatId });
        logger.info(`transport 删除: chat_id=${chatId}, deleted=${result.deletedCount}`);
        return result;
    } catch (err) {
        logger.error(`删除 transport 失败: ${err.message}`);
        throw err;
    }
}

/**
 * 从 Telegram 链接中提取 chat_id，如果无法获取名称则返回默认名称
 * @param {string} url - 原始链接
 * @param {Object} bot - Telegram bot 实例
 * @returns {Promise<{chat_id: number, chat_name: string, url: string, is_verified: boolean}>}
 */
async function extractChatInfo(url, bot) {
    // 1. 公开链接 t.me/username
    const publicMatch = url.match(/https?:\/\/t\.me\/([a-zA-Z][a-zA-Z0-9_]{4,31})(?:\/.*)?$/);
    if (publicMatch) {
        const username = publicMatch[1];
        try {
            const chat = await bot.getChat(`@${username}`);
            return {
                chat_id: chat.id,
                chat_name: chat.title || username,
                url: url,
                is_verified: true
            };
        } catch (err) {
            logger.error(`通过 username 获取 chat 失败: ${err.message}`);
            throw new Error('无法识别该链接，请确保机器人已加入该群组/频道或链接正确');
        }
    }

    // 2. 隐私频道链接 t.me/c/数字
    const cMatch = url.match(/https?:\/\/t\.me\/c\/(\d+)(?:\/\d+)?/);
    if (cMatch) {
        const chatIdNum = cMatch[1];
        const actualChatId = parseInt(`-100${chatIdNum}`);
        if (isNaN(actualChatId)) {
            throw new Error('无效的频道ID');
        }
        let chatName = `频道 ${chatIdNum}`;
        let isVerified = false;
        try {
            const chat = await bot.getChat(actualChatId);
            chatName = chat.title || chatName;
            isVerified = true;
        } catch (err) {
            logger.warn(`无法获取频道 ${actualChatId} 信息: ${err.message}`);
        }
        return {
            chat_id: actualChatId,
            chat_name: chatName,
            url: url,
            is_verified: isVerified
        };
    }

    // 3. 私有邀请链接
    const inviteMatch = url.match(/https?:\/\/t\.me\/(joinchat\/[A-Za-z0-9_-]+|\+[A-Za-z0-9_-]+)/);
    if (inviteMatch) {
        throw new Error('私有邀请链接需要机器人先加入该群组/频道，请先添加机器人到目标群组/频道，然后使用 /transport 手动添加');
    }

    // 4. 数字ID
    const numericId = parseInt(url);
    if (!isNaN(numericId)) {
        try {
            const chat = await bot.getChat(numericId);
            return {
                chat_id: chat.id,
                chat_name: chat.title || chat.username || `Chat ${numericId}`,
                url: url,
                is_verified: true
            };
        } catch (err) {
            throw new Error('无法获取该 ID 的群组信息，请确保机器人已加入');
        }
    }

    throw new Error('链接格式无法识别，请提供公开链接、频道内消息链接或数字ID');
}

module.exports = {
    getTransportCollection,
    upsertTransport,
    getAllTransports,
    getTransportByChatId,
    deleteTransport,
    extractChatInfo
};