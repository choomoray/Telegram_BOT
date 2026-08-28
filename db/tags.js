// db/tags.js
/**
 * 标签管理（独立 tags 集合，未来标签增多时避免 settings 单文档膨胀）
 *
 * 文档结构（每个标签一条记录）：
 *   { name: string, pin: number, count: number }
 *   - name: 标签名（大写，唯一索引）
 *   - pin: 置顶位置：0=不置顶；>0=按钮网格位置（每行 4 个，1=左上第一个按钮，
 *          5=第二行第一个，以此类推；按 pin 升序排列）
 *   - count: 使用次数（每次给媒体打上该标签 +1，移除 -1，最低 0）
 *
 * 展示排序规则（sortTags）：
 *   置顶标签（pin>0）按 pin 升序排最前 → 其余按使用次数降序 → 次数相同按名称
 */
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

function normalizePin(pin) {
    return Number.isInteger(pin) && pin > 0 ? pin : 0;
}

/**
 * 获取标签数组（标签名统一大写，pin 非法值视为 0）
 * @returns {Promise<Array<{name, pin, count}>>}
 */
async function getTags() {
    try {
        const col = getCollection(COLLECTIONS.TAGS);
        const docs = await col.find({}).toArray();
        return docs.map(t => ({
            name: String(t.name || '').trim().toUpperCase(),
            pin: normalizePin(t.pin),
            count: t.count || 0
        }));
    } catch (err) {
        logger.error(`获取标签列表失败: ${err.message}`);
        return [];
    }
}

/**
 * 标签展示排序：置顶（pin>0）按 pin 升序在前，其余按使用次数降序，次数相同按名称
 * @param {Array} tags - 标签对象数组
 * @returns {Array} 排序后的新数组（纯函数，可测试）
 */
function sortTags(tags) {
    const arr = tags.map(t => ({
        name: t.name,
        pin: normalizePin(t.pin),
        count: t.count || 0
    }));
    const pinned = arr.filter(t => t.pin > 0)
        .sort((a, b) => (a.pin - b.pin) || a.name.localeCompare(b.name, 'zh'));
    const normal = arr.filter(t => t.pin === 0)
        .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'zh'));
    return [...pinned, ...normal];
}

/**
 * 添加标签（已存在则报错；标签名统一转换为大写）
 * @param {string} name - 标签名
 * @param {Object} opts - { pin }
 */
async function addTag(name, opts = {}) {
    const trimmed = String(name || '').trim().toUpperCase();
    if (!trimmed) return { ok: false, error: '标签名不能为空' };
    if (trimmed.length > 20) return { ok: false, error: '标签名最长 20 个字符' };
    try {
        const col = getCollection(COLLECTIONS.TAGS);
        const pin = normalizePin(opts.pin);
        await col.insertOne({ name: trimmed, pin, count: 0 });
        logger.info(`标签已添加: ${trimmed}${pin ? `（置顶位置 ${pin}）` : ''}`);
        return { ok: true, tags: await getTags() };
    } catch (err) {
        if (err.code === 11000) {
            return { ok: false, error: `标签「${trimmed}」已存在` };
        }
        logger.error(`添加标签失败: ${err.message}`);
        return { ok: false, error: '添加标签失败' };
    }
}

/**
 * 删除标签（同步移除 message 集合中的该标签）
 * @returns {Promise<{ok, tags, synced?, error?}>}
 */
async function removeTag(name) {
    const target = String(name || '').trim().toUpperCase();
    const col = getCollection(COLLECTIONS.TAGS);
    const result = await col.deleteOne({ name: target });
    if (result.deletedCount === 0) return { ok: false, error: `标签「${name}」不存在` };
    const { removeTagFromAllMessages } = require('./message');
    const synced = await removeTagFromAllMessages(target);
    logger.info(`标签已删除: ${target}, 同步清理 message ${synced} 条`);
    return { ok: true, tags: await getTags(), synced };
}

/**
 * 重命名标签（同步修改 message 集合中的对应标签）
 * @returns {Promise<{ok, tags, synced?, error?}>}
 */
async function renameTag(oldName, newName) {
    const trimmed = String(newName || '').trim().toUpperCase();
    if (!trimmed) return { ok: false, error: '新标签名不能为空' };
    if (trimmed.length > 20) return { ok: false, error: '标签名最长 20 个字符' };
    const old = String(oldName || '').trim().toUpperCase();
    const col = getCollection(COLLECTIONS.TAGS);
    const target = await col.findOne({ name: old });
    if (!target) return { ok: false, error: `标签「${oldName}」不存在` };
    if (old !== trimmed) {
        const dup = await col.findOne({ name: trimmed });
        if (dup) return { ok: false, error: `标签「${trimmed}」已存在` };
    }
    await col.updateOne({ name: old }, { $set: { name: trimmed } });
    const { renameTagInMessages } = require('./message');
    const synced = await renameTagInMessages(old, trimmed);
    logger.info(`标签已重命名: ${old} -> ${trimmed}, 同步修改 message ${synced} 条`);
    return { ok: true, tags: await getTags(), synced };
}

/**
 * 设置标签置顶位置：0=取消置顶；>0=按钮网格位置（每行 4 个，1=左上第一个按钮）
 * @returns {Promise<{ok, tags, error?}>}
 */
async function setTagPin(name, pin) {
    const target = String(name || '').trim().toUpperCase();
    const p = normalizePin(pin);
    const col = getCollection(COLLECTIONS.TAGS);
    const result = await col.updateOne({ name: target }, { $set: { pin: p } });
    if (result.matchedCount === 0) return { ok: false, error: `标签「${name}」不存在` };
    logger.info(`标签置顶位置: ${target} -> ${p === 0 ? '不置顶' : `位置 ${p}`}`);
    return { ok: true, tags: await getTags() };
}

/**
 * 标签使用次数增减（打标签 +1，移除 -1，最低 0；管道更新避免并发读改写）
 */
async function tagUsed(name, delta = 1) {
    try {
        const target = String(name || '').trim().toUpperCase();
        const col = getCollection(COLLECTIONS.TAGS);
        await col.updateOne(
            { name: target },
            [{ $set: { count: { $max: [0, { $add: [{ $ifNull: ['$count', 0] }, delta] }] } } }]
        );
    } catch (err) {
        logger.error(`更新标签使用次数失败: ${err.message}`);
    }
}

/**
 * 从 settings.tags 迁移旧标签数据到独立 tags 集合（幂等：tags 集合非空即跳过）。
 * 旧数据 important=true 按出现顺序分配 pin 1..N，其余 pin=0；迁移完成后清除 settings.tags。
 */
async function migrateTagsFromSettings() {
    try {
        const tagsCol = getCollection(COLLECTIONS.TAGS);
        const existingCount = await tagsCol.countDocuments({});
        if (existingCount > 0) return;

        const settingsCol = getCollection(COLLECTIONS.SETTINGS);
        const doc = await settingsCol.findOne({ _id: 'app_settings' });
        const raw = Array.isArray(doc && doc.tags) ? doc.tags : [];
        if (raw.length === 0) return;

        let pinSeq = 0;
        const docs = [];
        for (const t of raw) {
            const name = String(typeof t === 'string' ? t : (t && t.name) || '').trim().toUpperCase();
            if (!name) continue;
            const important = !!(t && typeof t === 'object' && t.important);
            docs.push({
                name,
                pin: important ? ++pinSeq : 0,
                count: (t && typeof t === 'object' && t.count) || 0
            });
        }
        if (docs.length > 0) {
            await tagsCol.insertMany(docs);
            await settingsCol.updateOne({ _id: 'app_settings' }, { $unset: { tags: '' } });
            logger.success(`标签迁移: settings.tags -> tags 集合，共 ${docs.length} 个标签`);
        }
    } catch (err) {
        logger.error(`标签迁移失败: ${err.message}`);
    }
}

module.exports = {
    getTags,
    sortTags,
    addTag,
    removeTag,
    renameTag,
    setTagPin,
    tagUsed,
    migrateTagsFromSettings
};
