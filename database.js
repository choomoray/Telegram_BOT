// database.js
const { MongoClient } = require('mongodb');
const config = require('./config');
const { MONGODB_URI, DB_NAME, ATLAS_AUTO_WHITELIST } = config;
const logger = require('./logger');

let client = null;

/**
 * 数据库名：只有一个（生产）库。
 * 历史上曾有"`--test` 用 `_test` 库 + TEST_MONGODB_URI"的专用测试库模式，已按用户要求移除。
 */
function getDatabaseName() {
    return DB_NAME;
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
 * 连不上时尝试"出口 IP 不在 Atlas 白名单"这条自救路径（见 utils/atlasAccessList.js）
 *
 * 只在 `ATLAS_AUTO_WHITELIST=1` 且错误形态像网络/白名单问题时才动作；
 * 内部有冷却与并发去重，因此在重试循环里每轮调用也不会打爆 Atlas API。
 * 无论成功失败都**不抛异常**：白名单维护失败不应该掩盖原始的连接错误。
 *
 * @param {Error} err - 本次连接失败的错误
 * @param {string} trigger - 触发来源（日志/通知用）
 */
async function tryAtlasWhitelistRepair(err, trigger) {
    if (!ATLAS_AUTO_WHITELIST) return null;
    try {
        const { classifyDbError, ensureIpWhitelisted } = require('./utils/atlasAccessList');
        const cls = classifyDbError(err);
        if (!cls.candidate) {
            logger.info(`[Atlas] 本次连接失败不像是白名单问题（${cls.reason}），跳过白名单维护`);
            return null;
        }
        logger.warn(`[Atlas] 连接失败判定为可疑白名单问题（${cls.reason}），尝试自动维护白名单...`);
        const result = await ensureIpWhitelisted({ trigger });
        if (result && result.ok) {
            logger.success(`[Atlas] 白名单就绪（IP=${result.ip}${result.added ? '，已新增临时条目' : '，已有条目覆盖'}），继续重试连接`);
        } else if (result && result.skipped) {
            logger.info(`[Atlas] 白名单维护跳过：${result.reason}`);
        } else {
            logger.warn(`[Atlas] 白名单维护未成功：${(result && result.reason) || '未知原因'}`);
        }
        return result;
    } catch (repairErr) {
        logger.warn(`[Atlas] 白名单维护异常: ${repairErr.message}`);
        return null;
    }
}

/**
 * 连接 MongoDB，支持自动重试（总尝试时间约30秒）
 *
 * 可被停机信号中止：启动阶段（如数据库连不上）按 Ctrl+C 会立即抛出，
 * 不再把 6 次重试 + 5 秒间隔全部耗完。
 *
 * 每次尝试失败后，若开了 ATLAS_AUTO_WHITELIST，会先判断"是不是出口 IP 不在白名单"，
 * 是则自动加临时条目（并等它 ACTIVE）再进入下一轮重试 —— 代理换 IP 后无需人工干预。
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

    const uri = MONGODB_URI;
    const dbName = getDatabaseName();

    logger.info(`正在连接数据库, 数据库名: ${dbName}`);

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
            if (signal && signal.aborted) throw abortedError();
            // 疑似出口 IP 不在 Atlas 白名单 → 自动加临时条目（等生效）再重试
            await tryAtlasWhitelistRepair(err, `startup-attempt-${i + 1}`);
            if (signal && signal.aborted) throw abortedError();
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

// ---------------- 运行期数据库守卫（掉线时同样自动维护 Atlas 白名单） ----------------

let dbGuardTimer = null;

/**
 * 启动运行期心跳守卫：定期 ping 数据库，失败且判定为"疑似白名单问题"时，
 * 复用 connectDB 里的同一套自救流程（内部有冷却，不会反复打 Atlas API）。
 * 需要 ATLAS_AUTO_WHITELIST=1，否则不启动（返回 null）。
 * @param {Object} [opts] - { intervalMs }
 * @returns {NodeJS.Timeout|null}
 */
function startDbGuard({ intervalMs } = {}) {
    if (!ATLAS_AUTO_WHITELIST) {
        logger.info('[Atlas] ATLAS_AUTO_WHITELIST 未开启，数据库心跳守卫不启动');
        return null;
    }
    if (dbGuardTimer) return dbGuardTimer;
    const every = intervalMs || config.DB_GUARD_INTERVAL_MS || 60000;
    dbGuardTimer = setInterval(async () => {
        try {
            await getDb().admin().ping();
        } catch (err) {
            await tryAtlasWhitelistRepair(err, 'runtime-heartbeat');
        }
    }, every);
    if (dbGuardTimer.unref) dbGuardTimer.unref();
    logger.info(`[Atlas] 数据库心跳守卫已启动（每 ${Math.round(every / 1000)}s 一次，掉线自动维护白名单）`);
    return dbGuardTimer;
}

/** 停止运行期守卫（优雅关闭 / 测试用） */
function stopDbGuard() {
    if (dbGuardTimer) {
        clearInterval(dbGuardTimer);
        dbGuardTimer = null;
    }
}

module.exports = {
    connectDB,
    getClient,
    getDb,
    getDatabaseName,
    // 运行期守卫
    startDbGuard,
    stopDbGuard,
    // 供测试直接验证"等待可被打断"的语义（不必真的去连数据库）
    sleepOrAbort
};