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
        await messageCol.createIndex({ media_type: 1, text: 1 });

        // media 集合索引
        const mediaCol = db.collection(COLLECTIONS.MEDIA);
        await mediaCol.createIndex({ file_unique_id: 1 }, { unique: true });
        await mediaCol.createIndex({ group_id: 1, message_id: 1 });
        await mediaCol.createIndex({ media_type: 1 });
        await mediaCol.createIndex({ video_time: 1 });

        // group_list 集合索引
        const groupListCol = db.collection(COLLECTIONS.GROUP_LIST);
        await groupListCol.createIndex({ group_id: 1 }, { unique: true });

        // log 集合索引（操作日志：时间线 + 月表/年表聚合 + 按动作/大类/用户筛选）
        const logCol = db.collection(COLLECTIONS.LOG);
        await logCol.createIndex({ time: -1 });
        await logCol.createIndex({ date: -1 });
        await logCol.createIndex({ action: 1, date: -1 });
        await logCol.createIndex({ category: 1, date: -1 });
        await logCol.createIndex({ userId: 1, date: -1 });
        await logCol.createIndex({ result: 1, date: -1 });

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

        // article 集合索引
        const articleCol = db.collection(COLLECTIONS.ARTICLE);
        await articleCol.createIndex({ id: 1 }, { unique: true });
        await articleCol.createIndex({ updated_at: -1 });

        // sub_article 集合索引
        const subArticleCol = db.collection(COLLECTIONS.SUB_ARTICLE);
        await subArticleCol.createIndex({ id: 1 }, { unique: true });
        await subArticleCol.createIndex({ article_id: 1, updated_at: -1 });

        // collection 集合索引
        const collectionCol = db.collection(COLLECTIONS.COLLECTION);
        await collectionCol.createIndex({ id: 1 }, { unique: true });
        await collectionCol.createIndex({ type: 1, updated_at: -1 });

        // sub_collection 集合索引
        const subCollectionCol = db.collection(COLLECTIONS.SUB_COLLECTION);
        await subCollectionCol.createIndex({ id: 1 }, { unique: true });
        await subCollectionCol.createIndex({ collection_id: 1, updated_at: -1 });

        // tags 集合索引（独立标签库）
        const tagsCol = db.collection(COLLECTIONS.TAGS);
        await tagsCol.createIndex({ name: 1 }, { unique: true });

        // mark 集合索引（标记历史：按时间/用户查询）
        const markCol = db.collection(COLLECTIONS.MARK);
        await markCol.createIndex({ time: -1 });
        await markCol.createIndex({ userId: 1, time: -1 });
        await markCol.createIndex({ group_id: 1 });

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
