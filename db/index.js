// db/index.js
const { getCollection } = require('./getCollection');
const COLLECTIONS = require('./collections');
const logger = require('../logger');

async function initCollections() {
    try {
        const db = require('../database').getDb();

        // message 集合索引
        const messageCol = db.collection(COLLECTIONS.MESSAGE);
        await messageCol.createIndex({ file_unique_id: 1 }, { unique: true });
        await messageCol.createIndex({ group_id: 1 });
        await messageCol.createIndex({ media_type: 1, level: 1, text: 1 });

        // media 集合索引
        const mediaCol = db.collection(COLLECTIONS.MEDIA);
        await mediaCol.createIndex({ file_unique_id: 1 }, { unique: true });
        await mediaCol.createIndex({ group_id: 1, message_id: 1 });
        await mediaCol.createIndex({ media_type: 1 });
        await mediaCol.createIndex({ video_time: 1 });

        // group_list 集合索引
        const groupListCol = db.collection(COLLECTIONS.GROUP_LIST);
        await groupListCol.createIndex({ group_id: 1 }, { unique: true });

        // log 集合索引
        const logCol = db.collection(COLLECTIONS.LOG);
        await logCol.createIndex({ time: -1 });

        // transport 集合索引
        const transportCol = db.collection(COLLECTIONS.TRANSPORT);
        await transportCol.createIndex({ chat_id: 1 }, { unique: true });

        // channel_group 集合索引
        const channelGroupCol = db.collection(COLLECTIONS.CHANNEL_GROUP);
        await channelGroupCol.createIndex({ id: 1 }, { unique: true });

        // users 集合索引
        const usersCol = db.collection(COLLECTIONS.USERS);
        await usersCol.createIndex({ id: 1 }, { unique: true });
        await usersCol.createIndex({ group: 1 });
        await usersCol.createIndex({ state: 1, white: 1 });

        logger.success('数据库集合索引创建完成');
    } catch (err) {
        logger.error('初始化集合索引失败:', err.message);
    }
}

module.exports = {
    COLLECTIONS,
    getCollection,
    initCollections
};
