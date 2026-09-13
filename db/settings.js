// db/settings.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const { getClient } = require('../database');
const logger = require('../logger');
const SETTINGS_ID = 'app_settings';

// 默认设置（包含原 user_setting 的所有字段）
const DEFAULT_SETTINGS = {
    _id: SETTINGS_ID,
    // 全局
    search_random: 1,
    random_pictures: 0,
    random_pictures_num: 9,
    random_videos: 0,
    random_videos_time: '<1min',
    random_videos_num_text: 15,
    random_videos_num_video: 10,
    media_group_num: 10,
    article_sort: 'recent',
    sub_article_sort: 'time_desc'
    // 标签已迁移至独立 tags 集合（db/tags.js），不再存储在 settings
};

// 允许更新的 key 列表（不含密钥类字段，见 SECRET_KEYS）
const ALLOWED_KEYS = Object.keys(DEFAULT_SETTINGS).filter(k => k !== '_id');

/**
 * 密钥类设置：可以存放在 settings 文档里，但**不通过 config / /setting 面板读写**，
 * 只能由各自的功能模块用专用函数访问（避免密钥进入 config 对象被日志打印）。
 *   - `webui_password`：Web UI 登录密码（唯一来源，见 webui/server.js）
 */
const SECRET_KEYS = ['webui_password'];

let cachedSettings = null;
let lastFetchTime = 0;
const CACHE_TTL = 5000;

/**
 * 获取最新设置（带缓存）
 */
async function getSettings() {
    const now = Date.now();
    if (cachedSettings && (now - lastFetchTime) < CACHE_TTL) {
        return cachedSettings;
    }
    try {
        const col = getCollection(COLLECTIONS.SETTINGS);
        const doc = await col.findOne({ _id: SETTINGS_ID });
        if (doc) {
            // 补全新字段
            let needUpdate = false;
            for (const key of ALLOWED_KEYS) {
                if (doc[key] === undefined) {
                    doc[key] = DEFAULT_SETTINGS[key];
                    needUpdate = true;
                }
            }
            if (needUpdate) {
                await col.updateOne({ _id: SETTINGS_ID }, { $set: doc });
            }
            cachedSettings = doc;
        } else {
            // 首次创建
            await col.insertOne(DEFAULT_SETTINGS);
            cachedSettings = { ...DEFAULT_SETTINGS };
        }
        lastFetchTime = now;
        return cachedSettings;
    } catch (err) {
        logger.error(`获取设置失败: ${err.message}`);
        if (cachedSettings) return cachedSettings;
        return { ...DEFAULT_SETTINGS };
    }
}

/**
 * 启动时加载设置到 config 对象
 */
async function loadSettings(config) {
    const settings = await getSettings();
    for (const key of ALLOWED_KEYS) {
        if (settings[key] !== undefined && key in config) {
            config[key] = settings[key];
        }
    }
    logger.info('全局设置已加载到 config');
}

/**
 * 更新单个设置项
 * @param {object} config - config 对象（可传 {}）
 * @param {string} key - 设置键名
 * @param {any} value - 新值
 * @param {number} retries - 重试次数
 */
async function updateSetting(config, key, value, retries = 2) {
    if (!ALLOWED_KEYS.includes(key)) {
        throw new Error(`不允许修改的设置: ${key}`);
    }
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const client = getClient();
            if (!client || !client.topology || !client.topology.isConnected()) {
                logger.warn(`数据库连接已断开，尝试重连...`);
                const { connectDB } = require('../database');
                await connectDB();
                logger.info(`数据库重连成功`);
            }
            const col = getCollection(COLLECTIONS.SETTINGS);
            const update = { $set: { [key]: value } };
            await col.updateOne({ _id: SETTINGS_ID }, update, { upsert: true });
            if (key in config) {
                config[key] = value;
            }
            cachedSettings = null;
            logger.info(`设置已更新: ${key}=${value}`);
            return true;
        } catch (err) {
            lastError = err;
            logger.error(`更新设置失败 (尝试 ${attempt}/${retries}): ${err.message}`);
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }
    logger.error(`最终更新设置失败: ${lastError?.message}`);
    return false;
}

/**
 * 批量更新设置（用于 /setting 面板）
 */
async function updateSettings(config, updates, retries = 2) {
    const keys = Object.keys(updates);
    const invalidKeys = keys.filter(k => !ALLOWED_KEYS.includes(k));
    if (invalidKeys.length > 0) {
        throw new Error(`不允许修改的设置: ${invalidKeys.join(', ')}`);
    }
    return updateSetting(config, keys[0], updates[keys[0]], retries); // 简化版，可扩展为逐个更新
}

/**
 * 清空设置缓存：下一次 getSettings() 重新读库。
 * 测试里重置内存库后必须调用，否则会读到上一个用例缓存下来的文档。
 */
function clearSettingsCache() {
    cachedSettings = null;
    lastFetchTime = 0;
}

// ---------------- 密钥类设置（settings 文档字段，不进 config） ----------------

/**
 * 读取 Web UI 登录密码（settings.webui_password）
 *
 * 复用 getSettings 的 5 秒缓存：登录时才读取，密码一改最多 5 秒后生效。
 * 未配置（字段不存在 / 空字符串 / 非字符串）返回 null，由调用方决定拒绝登录。
 * @returns {Promise<string|null>}
 */
async function getSettingPassword() {
    const settings = await getSettings();
    const value = settings ? settings.webui_password : undefined;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
}

/**
 * 写入 / 清除 Web UI 登录密码
 * @param {string|null} password - 新密码；传空字符串或 null 表示清除该字段
 * @returns {Promise<boolean>}
 */
async function setSettingPassword(password) {
    try {
        const col = getCollection(COLLECTIONS.SETTINGS);
        const value = (typeof password === 'string') ? password.trim() : '';
        const update = value ? { $set: { webui_password: value } } : { $unset: { webui_password: '' } };
        await col.updateOne({ _id: SETTINGS_ID }, update, { upsert: true });
        cachedSettings = null; // 立即失效缓存，改完马上生效
        logger.info(value ? 'Web UI 登录密码已更新' : 'Web UI 登录密码已清除');
        return true;
    } catch (err) {
        logger.error(`更新 Web UI 登录密码失败: ${err.message}`);
        return false;
    }
}

module.exports = {
    getSettings,
    loadSettings,
    updateSetting,
    updateSettings,
    getSettingPassword,
    setSettingPassword,
    clearSettingsCache,
    ALLOWED_KEYS,
    SECRET_KEYS,
    DEFAULT_SETTINGS
};