// db/groupList.js
const { getCollection, COLLECTIONS } = require('./getCollection');
const logger = require('../logger');

/**
 * 原子性地增加 group_list 的 is_group 计数，若不存在则创建
 * @param {string} groupId - 媒体组ID
 * @param {number} [count=1] - 一次增加的数量（媒体组批量落库时一次 +N，避免 N 次串行往返；
 *                             也避免同一 group_id 的并发 upsert 触发唯一索引冲突）
 */
async function upsertGroupList(groupId, count = 1) {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        const result = await col.updateOne(
            { group_id: groupId },
            {
                $inc: { is_group: count },
                $setOnInsert: {
                    group_id: groupId,
                    is_delete: null,      // 🔁 默认 null，表示“未确定状态”
                    mark: 0
                    // last_mark_time 不在这里写：没被标记过的组不该有该字段，
                    // 只在 /mark 标记成功时由 incrementMark 写入
                }
            },
            { upsert: true }
        );

        if (result.upsertedCount > 0) {
            logger.info(`group_list 创建: group_id=${groupId}, is_group=${count}, is_delete=null`);
        } else {
            const updated = await col.findOne({ group_id: groupId });
            logger.info(`group_list 更新: group_id=${groupId}, +${count}, is_group now=${updated?.is_group || 'unknown'}`);
        }
        return result;
    } catch (err) {
        logger.error(`group_list upsert 失败: ${err.message}`);
        throw err;
    }
}

/**
 * 设置 group_list 的 is_delete 字段
 * @param {string} groupId 
 * @param {number|null} deleteTimestamp - 时间戳（毫秒）或0/null
 */
async function setGroupDelete(groupId, deleteTimestamp) {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        const result = await col.updateOne(
            { group_id: groupId },
            { $set: { is_delete: deleteTimestamp } }
        );
        logger.info(`group_list 设置删除标记: group_id=${groupId}, is_delete=${deleteTimestamp}`);
        return result;
    } catch (err) {
        logger.error(`设置 group_list 删除标记失败: ${err.message}`);
        throw err;
    }
}

/**
 * 按「组内是否还有文本消息」重算 is_delete（全项目唯一判定入口）：
 *   - 组内还有 message 记录（= 仍有文本媒体） → 0，表示无需清理
 *   - 组内已无 message 记录（= 空描述媒体组） → 当前时间戳，表示可被 /clean 清理
 *
 * 任何会改变「组内文本」的写路径（收录 / 发送 / 回复 / 编辑 / 清空描述 / 删除）
 * 都应调用本函数，而不是各自判断后写死 0 或时间戳：这样后续补文本、改文本会变 0，
 * 清空文本又会变回时间戳，且与媒体组内各条消息的到达顺序无关。
 *
 * @param {string} groupId - 媒体组 ID
 * @returns {Promise<number>} 写入的 is_delete 值（0 或时间戳）
 */
async function syncGroupDeleteByText(groupId) {
    try {
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const textCount = await messageCol.countDocuments({ group_id: groupId });
        const deleteTimestamp = textCount > 0 ? 0 : Date.now();
        await setGroupDelete(groupId, deleteTimestamp);
        return deleteTimestamp;
    } catch (err) {
        logger.error(`按文本重算 is_delete 失败: group_id=${groupId}, ${err.message}`);
        throw err;
    }
}

// ---------------- group_list.tags（媒体组标签汇总） ----------------

/**
 * 重算 group_list.tags = 该媒体组内**所有 message 标签的并集**
 * （message.tags 是标签的唯一权威来源，group_list.tags 只是便于"先查 group_list"的汇总）
 *
 * 无标签时移除该字段（保持"没打过标签的组不带 tags 字段"的语义）。
 * 任何会改变组内 message 标签的写路径（按钮 / 手输 / 文本自动匹配 / 编辑 / 重命名 / 删除）
 * 都应调用本函数，避免汇总与 message 不一致。
 *
 * @param {string} groupId - 媒体组 ID
 * @returns {Promise<string[]>} 重算后的标签数组（升序）
 */
async function syncGroupTags(groupId) {
    if (!groupId) return [];
    try {
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const docs = await messageCol
            .find({ group_id: groupId, tags: { $exists: true, $ne: [] } })
            .toArray();
        const set = new Set();
        for (const d of docs) {
            if (Array.isArray(d.tags)) {
                for (const t of d.tags) {
                    const name = String(t || '').trim();
                    if (name) set.add(name);
                }
            }
        }
        const tags = [...set].sort((a, b) => a.localeCompare(b, 'zh'));
        await applyGroupTags(groupId, tags);
        return tags;
    } catch (err) {
        logger.error(`重算 group_list.tags 失败: group_id=${groupId}, ${err.message}`);
        return [];
    }
}

/** 写入（或移除）group_list.tags 字段 */
async function applyGroupTags(groupId, tags) {
    const col = getCollection(COLLECTIONS.GROUP_LIST);
    const update = (tags && tags.length)
        ? { $set: { tags } }
        : { $unset: { tags: '' } };
    await col.updateOne({ group_id: groupId }, update);
}

/**
 * 增量同步单个标签到 group_list.tags（与 message 集合的 $addToSet / $pull 配对使用）
 * @param {string} groupId
 * @param {string} tag - 标签名
 * @param {1|-1} delta - 1=添加，-1=移除
 */
async function applyTagChangeToGroupTags(groupId, tag, delta) {
    if (!groupId || !tag) return;
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        const update = delta >= 0 ? { $addToSet: { tags: tag } } : { $pull: { tags: tag } };
        await col.updateOne({ group_id: groupId }, update);
    } catch (err) {
        logger.error(`增量同步 group_list.tags 失败: group_id=${groupId}, tag=${tag}, ${err.message}`);
    }
}

/**
 * 全库重算 group_list.tags（标签改名 / 删除后同步，或启动时补齐历史数据）
 * 覆盖两种集合的现有全部 message，并把"已无标签"的组清除 tags 字段。
 * @returns {Promise<{groups: number, tagged: number}>}
 */
async function syncAllGroupTags() {
    try {
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const groupCol = getCollection(COLLECTIONS.GROUP_LIST);
        const docs = await messageCol.find({}).toArray();

        const map = new Map();
        for (const d of docs) {
            const gid = d && d.group_id;
            if (!gid) continue;
            if (!map.has(gid)) map.set(gid, new Set());
            const bucket = map.get(gid);
            if (Array.isArray(d.tags)) {
                for (const t of d.tags) {
                    const name = String(t || '').trim();
                    if (name) bucket.add(name);
                }
            }
        }

        let tagged = 0;
        for (const [gid, set] of map.entries()) {
            const tags = [...set].sort((a, b) => a.localeCompare(b, 'zh'));
            if (tags.length) tagged++;
            await applyGroupTags(gid, tags);
        }

        // 不在映射里的组（已无任何带标签 message）清除 tags 字段
        const groupDocs = await groupCol.find({}, { projection: { group_id: 1 } }).toArray();
        for (const g of groupDocs) {
            const gid = g && g.group_id;
            if (gid && !map.has(gid)) {
                await groupCol.updateOne({ group_id: gid }, { $unset: { tags: '' } });
            }
        }

        logger.success(`group_list.tags 全库同步完成: ${map.size} 个媒体组，其中 ${tagged} 个有标签`);
        return { groups: map.size, tagged };
    } catch (err) {
        logger.error(`group_list.tags 全库同步失败: ${err.message}`);
        return { groups: 0, tagged: 0 };
    }
}

/**
 * 启动时补齐历史数据：把 message.tags 汇总进 group_list.tags
 * 幂等：已同步的库再跑一次结果相同。
 */
async function migrateGroupListTags() {
    const { groups, tagged } = await syncAllGroupTags();
    logger.info(`group_list.tags 迁移检查完成: 共 ${groups} 个媒体组，${tagged} 个带标签`);
    return { groups, tagged };
}

// ---------------- 空媒体组清理（删除媒体后以 media 实际记录为准） ----------------

/**
 * 删除某条媒体**之后**的组状态统一维护（删除路径的唯一入口）：
 *
 * 以 `media` 集合的**实际记录数**为准，而不是 `group_list.is_group` 这个可能漂移的计数器：
 *   - 组内已无任何 media → 删除 group_list 记录，并清掉该组残留的 message（
 *     否则会出现"没有任何媒体的 group_list 项"以及"查不到的孤儿 message"）；
 *   - 组内还有 media → 把 `is_group` 重算为真实数量（顺带修正历史漂移）。
 *
 * 旧实现用 `is_group === 1` 判断"最后一个媒体"、否则 `$inc: -1`：一旦计数器与真实
 * 媒体数不一致（重复计数、历史数据、回滚失败等），删完最后一个媒体后 `is_group`
 * 仍 > 0，group_list 就永远留下来了。
 *
 * @param {string} groupId - 媒体组 ID
 * @returns {Promise<{removed: boolean, remaining: number}>} removed=组记录已被删除
 */
async function removeMediaGroupIfEmpty(groupId) {
    if (!groupId) return { removed: false, remaining: 0 };
    try {
        const mediaCol = getCollection(COLLECTIONS.MEDIA);
        const messageCol = getCollection(COLLECTIONS.MESSAGE);
        const remaining = await mediaCol.countDocuments({ group_id: groupId });

        if (remaining > 0) {
            await getCollection(COLLECTIONS.GROUP_LIST).updateOne(
                { group_id: groupId },
                { $set: { is_group: remaining } }
            );
            return { removed: false, remaining };
        }

        await deleteGroupList(groupId);
        // 组内已无媒体 → 描述记录不应残留（否则按 group_list 查询时永远查不到这些孤儿记录）
        const cleaned = await messageCol.deleteMany({ group_id: groupId }).catch(() => ({ deletedCount: 0 }));
        logger.info(`group_list 已删除（组内已无媒体）: group_id=${groupId}, 同时清理 message ${cleaned.deletedCount || 0} 条`);
        return { removed: true, remaining: 0 };
    } catch (err) {
        logger.error(`空媒体组清理失败: group_id=${groupId}, ${err.message}`);
        return { removed: false, remaining: 0 };
    }
}

/**
 * 启动时清理历史遗留的"没有任何媒体的 group_list 项"（以及其孤儿 message 记录）
 * 幂等：清理完再跑一次匹配 0 条。
 * @returns {Promise<{removed: number, messages: number}>}
 */
async function cleanupOrphanGroupList() {
    try {
        const groupCol = getCollection(COLLECTIONS.GROUP_LIST);
        const mediaCol = getCollection(COLLECTIONS.MEDIA);
        const messageCol = getCollection(COLLECTIONS.MESSAGE);

        const groups = await groupCol.find({}, { projection: { group_id: 1 } }).toArray();
        let removed = 0;
        let messages = 0;
        for (const g of groups) {
            const groupId = g && g.group_id;
            if (!groupId) continue;
            const mediaCount = await mediaCol.countDocuments({ group_id: groupId });
            if (mediaCount > 0) continue;

            await groupCol.deleteOne({ group_id: groupId });
            const res = await messageCol.deleteMany({ group_id: groupId }).catch(() => ({ deletedCount: 0 }));
            messages += res.deletedCount || 0;
            removed++;
            logger.info(`清理无媒体的 group_list: group_id=${groupId}（同时清理 message ${res.deletedCount || 0} 条）`);
        }
        if (removed > 0) {
            logger.success(`清理无媒体的 group_list 记录: ${removed} 条，孤儿 message ${messages} 条`);
        }
        return { removed, messages };
    } catch (err) {
        logger.error(`清理无媒体的 group_list 失败: ${err.message}`);
        return { removed: 0, messages: 0 };
    }
}

/**
 * 查询 group_list
 */
async function findGroupList(groupId) {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        return await col.findOne({ group_id: groupId });
    } catch (err) {
        logger.error(`查询 group_list 失败: ${err.message}`);
        return null;
    }
}

/**
 * 删除 group_list 记录（用于回滚）
 */
async function deleteGroupList(groupId) {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        const result = await col.deleteOne({ group_id: groupId });
        logger.info(`group_list 删除: group_id=${groupId}, deleted=${result.deletedCount}`);
        return result;
    } catch (err) {
        logger.error(`删除 group_list 失败: ${err.message}`);
        throw err;
    }
}

/**
 * 标记次数 +1，并记录最后标记时间（**只有标记过的组才有 last_mark_time 字段**）
 * @param {string} groupId - 媒体组ID
 * @returns {Promise<number|null>} 更新后的 mark 值（未匹配到则返回 null）
 */
async function incrementMark(groupId) {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        const result = await col.updateOne(
            { group_id: groupId },
            { $inc: { mark: 1 }, $set: { last_mark_time: Date.now() } }
        );
        if (result.matchedCount === 0) {
            logger.error(`incrementMark: group_list 未找到 group_id=${groupId}`);
            return null;
        }
        const updated = await col.findOne({ group_id: groupId }, { projection: { mark: 1 } });
        return updated ? updated.mark : null;
    } catch (err) {
        logger.error(`incrementMark 失败: ${err.message}`);
        throw err;
    }
}

/**
 * 一次性清理历史数据：把「没被标记过」（last_mark_time 为 null）的字段直接删掉，
 * 让 group_list 里只有真正标记过的组才带 last_mark_time。
 * 幂等：清理完再跑一次匹配 0 条。
 * @returns {Promise<number>} 清理的文档数
 */
async function cleanupNullMarkTime() {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        const result = await col.updateMany(
            { last_mark_time: null },
            { $unset: { last_mark_time: '' } }
        );
        const cleaned = result.modifiedCount || 0;
        if (cleaned > 0) logger.success(`group_list 清理未标记的 last_mark_time 字段: ${cleaned} 条`);
        return cleaned;
    } catch (err) {
        logger.error(`清理 last_mark_time 失败: ${err.message}`);
        return 0;
    }
}

/**
 * 获取所有标记次数大于 0 的媒体组（按标记次数降序）
 * @returns {Promise<Array>} group_list 文档数组
 */
async function getMarkedGroups() {
    try {
        const col = getCollection(COLLECTIONS.GROUP_LIST);
        return await col.find({ mark: { $gt: 0 } }).sort({ mark: -1 }).toArray();
    } catch (err) {
        logger.error(`查询已标记媒体组失败: ${err.message}`);
        return [];
    }
}

module.exports = {
    upsertGroupList,
    setGroupDelete,
    syncGroupDeleteByText,
    findGroupList,
    deleteGroupList,
    incrementMark,
    cleanupNullMarkTime,
    getMarkedGroups,
    // group_list.tags（媒体组标签汇总）
    syncGroupTags,
    applyTagChangeToGroupTags,
    syncAllGroupTags,
    migrateGroupListTags,
    // 空媒体组清理（删除媒体后以 media 实际记录为准）
    removeMediaGroupIfEmpty,
    cleanupOrphanGroupList
};