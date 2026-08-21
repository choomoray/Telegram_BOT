// db/tags.js
/**
 * 标签管理（存储在 settings 集合的 tags 数组项中）
 * 标签名去重，message 集合的 tags 字段引用这些标签
 */
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');
const SETTINGS_ID = 'app_settings';

async function getTags() {
    try {
        const col = getCollection(COLLECTIONS.SETTINGS);
        const doc = await col.findOne({ _id: SETTINGS_ID });
        return Array.isArray(doc && doc.tags) ? doc.tags : [];
    } catch (err) {
        logger.error(`获取标签列表失败: ${err.message}`);
        return [];
    }
}

async function saveTags(tags) {
    const col = getCollection(COLLECTIONS.SETTINGS);
    await col.updateOne({ _id: SETTINGS_ID }, { $set: { tags } }, { upsert: true });
}

/**
 * 添加标签（已存在则报错）
 */
async function addTag(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return { ok: false, error: '标签名不能为空' };
    if (trimmed.length > 20) return { ok: false, error: '标签名最长 20 个字符' };
    const tags = await getTags();
    if (tags.includes(trimmed)) return { ok: false, error: `标签「${trimmed}」已存在` };
    tags.push(trimmed);
    await saveTags(tags);
    logger.info(`标签已添加: ${trimmed}`);
    return { ok: true, tags };
}

/**
 * 删除标签（同步移除 message 集合中的该标签）
 * @returns {Promise<{ok: boolean, tags: string[], synced?: number, error?: string}>}
 */
async function removeTag(name) {
    const tags = await getTags();
    const idx = tags.indexOf(name);
    if (idx === -1) return { ok: false, error: `标签「${name}」不存在` };
    tags.splice(idx, 1);
    await saveTags(tags);
    // 同步移除所有 message 中的该标签
    const { removeTagFromAllMessages } = require('./message');
    const synced = await removeTagFromAllMessages(name);
    logger.info(`标签已删除: ${name}, 同步清理 message ${synced} 条`);
    return { ok: true, tags, synced };
}

/**
 * 重命名标签（同步修改 message 集合中的对应标签）
 * @returns {Promise<{ok: boolean, tags: string[], synced?: number, error?: string}>}
 */
async function renameTag(oldName, newName) {
    const trimmed = String(newName || '').trim();
    if (!trimmed) return { ok: false, error: '新标签名不能为空' };
    if (trimmed.length > 20) return { ok: false, error: '标签名最长 20 个字符' };
    const tags = await getTags();
    if (!tags.includes(oldName)) return { ok: false, error: `标签「${oldName}」不存在` };
    if (tags.includes(trimmed)) return { ok: false, error: `标签「${trimmed}」已存在` };
    const idx = tags.indexOf(oldName);
    tags[idx] = trimmed;
    await saveTags(tags);
    // 同步修改 message 中的标签名
    const { renameTagInMessages } = require('./message');
    const synced = await renameTagInMessages(oldName, trimmed);
    logger.info(`标签已重命名: ${oldName} -> ${trimmed}, 同步修改 message ${synced} 条`);
    return { ok: true, tags, synced };
}

module.exports = { getTags, saveTags, addTag, removeTag, renameTag };
