// db/tags.js
/**
 * 标签管理（存储在 settings 集合的 tags 数组项中）
 *
 * 标签结构（对象数组）：
 *   { name: string, important: boolean, count: number }
 *   - name: 标签名（去重，查询时大小写不敏感）
 *   - important: 是否重要标签（固定排在展示最前，不参与次数排序）
 *   - count: 使用次数（每次给媒体打上该标签 +1，移除 -1，最低 0）
 *
 * 展示排序规则（sortTags）：
 *   重要标签置顶（保持相对顺序）→ 其余按使用次数降序 → 次数相同按名称
 */
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');
const SETTINGS_ID = 'app_settings';

/**
 * 获取标签数组（兼容旧数据：字符串自动转为对象；标签名统一转为大写显示）
 * @returns {Promise<Array<{name, important, count}>>}
 */
async function getTags() {
    try {
        const col = getCollection(COLLECTIONS.SETTINGS);
        const doc = await col.findOne({ _id: SETTINGS_ID });
        const raw = Array.isArray(doc && doc.tags) ? doc.tags : [];
        return raw.map(t => {
            const name = String(typeof t === 'string' ? t : (t && t.name) || '').trim().toUpperCase();
            return {
                name,
                important: !!(t && typeof t === 'object' && t.important),
                count: (t && typeof t === 'object' && t.count) || 0
            };
        });
    } catch (err) {
        logger.error(`获取标签列表失败: ${err.message}`);
        return [];
    }
}

/**
 * 标签展示排序：重要标签置顶（保持相对顺序），其余按使用次数降序，次数相同按名称
 * @param {Array} tags - 标签对象数组
 * @returns {Array} 排序后的新数组（纯函数，可测试）
 */
function sortTags(tags) {
    const arr = tags.map(t => ({ name: t.name, important: !!t.important, count: t.count || 0 }));
    const important = arr.filter(t => t.important);
    const normal = arr.filter(t => !t.important)
        .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'zh'));
    return [...important, ...normal];
}

async function saveTags(tags) {
    const col = getCollection(COLLECTIONS.SETTINGS);
    await col.updateOne({ _id: SETTINGS_ID }, { $set: { tags } }, { upsert: true });
}

/**
 * 添加标签（已存在则报错；标签名统一转换为大写）
 * @param {string} name - 标签名
 * @param {Object} opts - { important }
 */
async function addTag(name, opts = {}) {
    const trimmed = String(name || '').trim().toUpperCase();
    if (!trimmed) return { ok: false, error: '标签名不能为空' };
    if (trimmed.length > 20) return { ok: false, error: '标签名最长 20 个字符' };
    const tags = await getTags();
    if (tags.some(t => t.name.toLowerCase() === trimmed.toLowerCase())) {
        return { ok: false, error: `标签「${trimmed}」已存在` };
    }
    tags.push({ name: trimmed, important: !!opts.important, count: 0 });
    await saveTags(tags);
    logger.info(`标签已添加: ${trimmed}${opts.important ? '（重要）' : ''}`);
    return { ok: true, tags };
}

/**
 * 删除标签（同步移除 message 集合中的该标签）
 * @returns {Promise<{ok, tags, synced?, error?}>}
 */
async function removeTag(name) {
    const tags = await getTags();
    const idx = tags.findIndex(t => t.name.toLowerCase() === String(name).toLowerCase());
    if (idx === -1) return { ok: false, error: `标签「${name}」不存在` };
    const removed = tags[idx].name;
    tags.splice(idx, 1);
    await saveTags(tags);
    const { removeTagFromAllMessages } = require('./message');
    const synced = await removeTagFromAllMessages(removed);
    logger.info(`标签已删除: ${removed}, 同步清理 message ${synced} 条`);
    return { ok: true, tags, synced };
}

/**
 * 重命名标签（同步修改 message 集合中的对应标签）
 * @returns {Promise<{ok, tags, synced?, error?}>}
 */
async function renameTag(oldName, newName) {
    const trimmed = String(newName || '').trim();
    if (!trimmed) return { ok: false, error: '新标签名不能为空' };
    if (trimmed.length > 20) return { ok: false, error: '标签名最长 20 个字符' };
    const tags = await getTags();
    const idx = tags.findIndex(t => t.name.toLowerCase() === String(oldName).toLowerCase());
    if (idx === -1) return { ok: false, error: `标签「${oldName}」不存在` };
    if (tags.some((t, i) => i !== idx && t.name.toLowerCase() === trimmed.toLowerCase())) {
        return { ok: false, error: `标签「${trimmed}」已存在` };
    }
    const prevName = tags[idx].name;
    tags[idx].name = trimmed;
    await saveTags(tags);
    const { renameTagInMessages } = require('./message');
    const synced = await renameTagInMessages(prevName, trimmed);
    logger.info(`标签已重命名: ${prevName} -> ${trimmed}, 同步修改 message ${synced} 条`);
    return { ok: true, tags, synced };
}

/**
 * 设置/取消标签的「重要」标记（重要标签固定排在展示最前）
 * @returns {Promise<{ok, tags, error?}>}
 */
async function setTagImportant(name, important) {
    const tags = await getTags();
    const t = tags.find(x => x.name.toLowerCase() === String(name).toLowerCase());
    if (!t) return { ok: false, error: `标签「${name}」不存在` };
    t.important = !!important;
    await saveTags(tags);
    logger.info(`标签重要标记: ${t.name} -> ${t.important ? '重要' : '普通'}`);
    return { ok: true, tags };
}

/**
 * 标签使用次数增减（打标签 +1，移除 -1，最低 0）
 */
async function tagUsed(name, delta = 1) {
    try {
        const tags = await getTags();
        const t = tags.find(x => x.name.toLowerCase() === String(name).toLowerCase());
        if (!t) return;
        t.count = Math.max(0, (t.count || 0) + delta);
        await saveTags(tags);
    } catch (err) {
        logger.error(`更新标签使用次数失败: ${err.message}`);
    }
}

module.exports = {
    getTags,
    sortTags,
    saveTags,
    addTag,
    removeTag,
    renameTag,
    setTagImportant,
    tagUsed
};
