// db/channelGroup.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

function getCol() {
    return getCollection(COLLECTIONS.CHANNEL_GROUP);
}

async function upsertChannelGroup(data) {
    try {
        const col = getCol();
        const { id, name, type, bind_id, is_bound } = data;
        const doc = {
            id,
            name,
            type,
            bind_id: bind_id || null,
            is_bound: !!is_bound
        };
        // 使用 id 作为唯一键
        await col.updateOne({ id: data.id }, { $set: doc }, { upsert: true });
        logger.info(`channel_group upsert: id=${data.id}, name=${name}, type=${type}`);
        return true;
    } catch (err) {
        logger.error(`channel_group upsert 失败: ${err.message}`);
        return false;
    }
}

async function getAllChannelGroups() {
    try {
        const col = getCol();
        return await col.find({}).sort({ id: 1 }).toArray();
    } catch (err) {
        logger.error(`获取 channel_group 列表失败: ${err.message}`);
        return [];
    }
}

async function getChannelGroupById(id) {
    try {
        const col = getCol();
        return await col.findOne({ id });
    } catch (err) {
        logger.error(`查询 channel_group 失败: ${err.message}`);
        return null;
    }
}

async function updateChannelGroup(id, updates) {
    try {
        const col = getCol();
        // 如果更新 bind_id，同步设置 is_bound
        if (updates.bind_id !== undefined) {
            updates.is_bound = updates.bind_id !== null;
        }
        await col.updateOne({ id }, { $set: updates });
        logger.info(`channel_group 更新: id=${id}`, updates);
        return true;
    } catch (err) {
        logger.error(`更新 channel_group 失败: ${err.message}`);
        return false;
    }
}

async function deleteChannelGroup(id) {
    try {
        const col = getCol();
        const result = await col.deleteOne({ id });
        logger.info(`channel_group 删除: id=${id}, deleted=${result.deletedCount}`);
        return result.deletedCount > 0;
    } catch (err) {
        logger.error(`删除 channel_group 失败: ${err.message}`);
        return false;
    }
}

module.exports = {
    upsertChannelGroup,
    getAllChannelGroups,
    getChannelGroupById,
    updateChannelGroup,
    deleteChannelGroup
};