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
 * 在等待期间响应停机信号：等待 `ms` 毫秒，但一旦收到 SIGINT/SIGTERM 立即结束等待。
 *
 * 直接用 `setTimeout` 的话，启动阶段卡在重试里时按 Ctrl+C 不会有任何反应：
 * 总要等定时器自然到期才会轮到下一轮循环去检查中止标记。
 * @param {number} ms - 最长等待时间
 * @param {AbortSignal} signal - 停机信号
 */
function sleepOrAbort(ms, signal) {
    return new Promise((resolve) => {
        if (signal && signal.aborted) return resolve();
        let timer = null;
        const done = () => {
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', done);
            resolve();
        };
        timer = setTimeout(done, ms);
        if (signal) signal.addEventListener('abort', done, { once: true });
    });
}

/**
 * 连接 MongoDB，支持自动重试（总尝试时间约30秒）
 *
 * 可被停机信号中止：启动阶段（如数据库连不上）按 Ctrl+C 会立即抛出，
 * 不再把 6 次重试 + 5 秒间隔全部耗完。
 *
 * @param {number} retries - 最大重试次数
 * @param {number} delay - 重试间隔（毫秒）
 * @param {AbortSignal} [signal] - 停机信号（见 shutdown.js: getAbortSignal()）
 * @returns {Promise<MongoClient>}
 */
async function connectDB(retries = 6, delay = 5000, signal = null) {
    if (client && client.topology && client.topology.isConnected()) {
        return client;
    }

    const uri = getMongoUri();
    const dbName = getDatabaseName();

    logger.info(`正在连接数据库: ${isTestMode ? '测试模式' : '正常模式'}, 数据库名: ${dbName}`);

    const abortedError = () => {
        const err = new Error('启动过程已中止（收到停机信号）');
        err.aborted = true;
        return err;
    };

    for (let i = 0; i < retries; i++) {
        if (signal && signal.aborted) throw abortedError();

        const attemptClient = new MongoClient(uri, {
            serverSelectionTimeoutMS: 5000,
        });

        try {
            await attemptClient.connect();
            // 连接建立期间收到停机信号：关掉刚建立的连接再中止，避免句柄泄漏
            if (signal && signal.aborted) {
                await attemptClient.close().catch(() => { });
                throw abortedError();
            }
            client = attemptClient;
            logger.success(`MongoDB Atlas 连接成功，使用数据库: ${dbName}`);
            return client;
        } catch (err) {
            // 中止信号触发的异常直接向上抛，不计入"连接失败重试"
            if (err && err.aborted) throw err;
            // logger 只输出第一个参数，必须把 err.message 拼进同一句里
            logger.error(`MongoDB 连接尝试 ${i + 1}/${retries} 失败: ${err.message}`);
            // 关闭失败的客户端，避免连接句柄泄漏
            await attemptClient.close().catch(() => { });
            if (i < retries - 1) {
                await sleepOrAbort(delay, signal);
            }
        }
    }

    if (signal && signal.aborted) throw abortedError();

    // 所有重试均失败，抛出异常
    throw new Error(`MongoDB 连接失败，已重试 ${retries} 次`);
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
    getDatabaseName,
    // 供测试直接验证"等待可被打断"的语义（不必真的去连数据库）
    sleepOrAbort
};