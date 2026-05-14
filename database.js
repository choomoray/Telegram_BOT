// database.js
const { MongoClient } = require('mongodb');
const { MONGODB_URI, DB_NAME, isTestMode, TEST_MONGODB_URI } = require('./config');
const logger = require('./logger');

let client = null;

function getDatabaseName() {
    if (isTestMode) {
        return DB_NAME + '_test';
    }
    return DB_NAME;
}

function getMongoUri() {
    if (isTestMode && TEST_MONGODB_URI) {
        return TEST_MONGODB_URI;
    }
    return MONGODB_URI;
}

/**
 * 连接 MongoDB，支持自动重试（总尝试时间约30秒）
 * 失败时抛出异常，由调用方处理退出
 */
async function connectDB(retries = 6, delay = 5000) {
    if (client && client.topology && client.topology.isConnected()) {
        return client;
    }

    const uri = getMongoUri();
    const dbName = getDatabaseName();

    logger.info(`正在连接数据库: ${isTestMode ? '测试模式' : '正常模式'}, 数据库名: ${dbName}`);

    for (let i = 0; i < retries; i++) {
        const attemptClient = new MongoClient(uri, {
            serverSelectionTimeoutMS: 5000,
        });

        try {
            await attemptClient.connect();
            client = attemptClient;
            logger.success(`MongoDB Atlas 连接成功，使用数据库: ${dbName}`);
            return client;
        } catch (err) {
            logger.error(`MongoDB 连接尝试 ${i + 1}/${retries} 失败:`, err.message);
            if (i < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // 所有重试均失败，抛出异常
    throw new Error('MongoDB 连接失败，已重试 30 秒');
}

function getClient() {
    if (!client) {
        throw new Error('MongoDB 尚未连接，请先调用 connectDB()');
    }
    return client;
}

function getDb() {
    return getClient().db(getDatabaseName());
}

module.exports = {
    connectDB,
    getClient,
    getDb,
    getDatabaseName
};