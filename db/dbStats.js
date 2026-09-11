// db/dbStats.js
/**
 * 数据库存储统计（WebUI「数据库」页 + 概览卡片共用）
 *
 * 数据来源：
 *   - db.command({ dbStats: 1 })       → 整库 objects / dataSize / storageSize / indexSize
 *   - db.command({ collStats: name })  → 各集合 count / size / storageSize / nindexes / indexSize
 * 部分 MongoDB 套餐（如共享集群受限账号）不允许这两条命令，此时降级为
 *   estimatedDocumentCount() 只取文档数，并在返回值里带上 available:false + reason，
 *   前端据此提示"当前套餐不支持读取存储大小"。
 */
const { getDb } = require('../database');
const logger = require('../logger');

const COLLECTION_LABELS = {
    message: '消息文本',
    media: '媒体文件',
    group_list: '媒体组汇总',
    user_setting: '用户设置',
    log: '操作日志',
    channel_group: '群组 / 频道',
    users: '用户',
    transport: '搬运收录',
    settings: '全局设置',
    article: '文章',
    sub_article: '子文章',
    collection: '合集',
    sub_collection: '子合集',
    tags: '标签库'
};

const CACHE_TTL = 15 * 1000; // 15 秒缓存，避免频繁刷新打爆 Atlas
let cache = { at: 0, data: null };

function labelOf(name) {
    return COLLECTION_LABELS[name] || name;
}

/** 收集要统计的集合名（内置 COLLECTIONS + 库中实际存在的其它集合） */
async function listCollectionNames(db) {
    const names = new Set();
    try {
        const existing = await db.listCollections({}, { nameOnly: true }).toArray();
        for (const c of existing) if (c && c.name) names.add(c.name);
    } catch (err) {
        logger.warn(`列出集合失败，使用内置清单: ${err.message}`);
    }
    const COLLECTIONS = require('./collections');
    for (const n of Object.values(COLLECTIONS)) names.add(n);
    return [...names].sort();
}

/**
 * 读取数据库统计
 * @param {Object} opts - { force: 跳过缓存 }
 * @returns {Promise<Object>}
 */
async function getDbStats(opts = {}) {
    if (!opts.force && cache.data && Date.now() - cache.at < CACHE_TTL) return cache.data;

    const db = getDb();
    const names = await listCollectionNames(db);

    let totals = null;
    let dbStatsError = null;
    try {
        const s = await db.command({ dbStats: 1 });
        totals = {
            collections: s.collections,
            objects: s.objects,
            dataSize: s.dataSize,
            storageSize: s.storageSize,
            indexes: s.indexes,
            indexSize: s.indexSize,
            avgObjSize: s.avgObjSize,
            freeStorageSize: s.freeStorageSize,
            scaleFactor: s.scaleFactor
        };
    } catch (err) {
        dbStatsError = String(err.message || err);
        logger.warn(`dbStats 不可用（降级为仅文档数）: ${dbStatsError}`);
    }

    const collections = [];
    let anyCollStats = false;
    let collStatsError = null;

    for (const name of names) {
        let info = {
            name,
            label: labelOf(name),
            count: null,
            size: null,
            storageSize: null,
            indexSize: null,
            nindexes: null,
            avgObjSize: null,
            available: false,
            error: null
        };
        try {
            const s = await db.command({ collStats: name });
            anyCollStats = true;
            info = {
                ...info,
                count: s.count,
                size: s.size,
                storageSize: s.storageSize,
                indexSize: s.totalIndexSize !== undefined ? s.totalIndexSize : s.indexSize,
                nindexes: s.nindexes,
                avgObjSize: s.avgObjSize,
                available: true
            };
        } catch (err) {
            info.error = String(err.message || err);
            if (!collStatsError) collStatsError = info.error;
            try {
                info.count = await db.collection(name).estimatedDocumentCount();
            } catch (countErr) {
                info.count = null;
                info.error = `${info.error}；统计文档数也失败：${countErr.message}`;
            }
        }
        collections.push(info);
    }

    const available = !!(totals || anyCollStats);
    const data = {
        database: db.databaseName,
        at: Date.now(),
        available,
        reason: available ? null : (dbStatsError || collStatsError || '当前 MongoDB 套餐不允许读取存储统计'),
        totals: totals || (available ? {
            collections: collections.length,
            objects: collections.reduce((sum, c) => sum + (c.count || 0), 0),
            dataSize: collections.reduce((sum, c) => sum + (c.size || 0), 0),
            storageSize: collections.reduce((sum, c) => sum + (c.storageSize || 0), 0),
            indexes: collections.reduce((sum, c) => sum + (c.nindexes || 0), 0),
            indexSize: collections.reduce((sum, c) => sum + (c.indexSize || 0), 0),
            avgObjSize: null
        } : null),
        collections: collections.sort((a, b) => (b.size || 0) - (a.size || 0) || a.name.localeCompare(b.name))
    };

    cache = { at: Date.now(), data };
    return data;
}

/** 概览卡片用的精简版本（失败时返回 available:false，不影响概览渲染） */
async function getDbStatsSummary() {
    try {
        const stats = await getDbStats();
        return {
            available: stats.available,
            database: stats.database,
            objects: stats.totals ? stats.totals.objects : null,
            collections: stats.totals ? stats.totals.collections : stats.collections.length,
            storageSize: stats.totals ? stats.totals.storageSize : null,
            dataSize: stats.totals ? stats.totals.dataSize : null,
            indexSize: stats.totals ? stats.totals.indexSize : null,
            reason: stats.reason
        };
    } catch (err) {
        logger.error(`读取数据库统计失败: ${err.message}`);
        return { available: false, reason: String(err.message || err) };
    }
}

function clearDbStatsCache() {
    cache = { at: 0, data: null };
}

module.exports = { getDbStats, getDbStatsSummary, clearDbStatsCache, COLLECTION_LABELS };
