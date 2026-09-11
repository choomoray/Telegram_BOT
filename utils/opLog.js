// utils/opLog.js
/**
 * 操作日志（schema v2）——统一写入入口，面向月表/年终统计设计
 *
 * 与旧版（只有 type/time/userId）的区别：
 *   - `action`（稳定动作键）+ `actionLabel`（冗余中文名）：报表按动作聚合，改文案不影响历史数据
 *   - `category`：动作大类（media/send/query/clean/tag/user/chat/setting/content/transport/system/webui）
 *   - `date`（BSON Date）+ `time`（毫秒时间戳）：`date` 可直接用于 $year/$month/$dateToString 聚合
 *   - `source`：发生位置（private/group/channel/webui/system）
 *   - `target` / `counts` / `detail`：结构化上下文（媒体类型、数量、时长、标签、查询词…）
 *   - `result` / `error` / `durationMs`：成功失败与耗时，便于统计失败率与性能
 *   - `type`：保留旧编号，兼容既有 `/log` 与历史数据
 *
 * 约定：所有写入都不得影响业务流程——失败只记 logger.error，绝不抛出。
 */
const { getCollection, COLLECTIONS } = require('../db/getCollection');
const logger = require('../logger');

const SCHEMA_VERSION = 2;

/** 动作大类（报表分组用） */
const CATEGORIES = {
    system: '系统',
    media: '媒体',
    send: '发送',
    reply: '回复',
    query: '查询',
    clean: '清理',
    tag: '标签',
    user: '用户',
    chat: '群组/频道',
    setting: '设置',
    content: '文章/合集',
    transport: '搬运',
    webui: 'Web 控制台'
};

/**
 * 动作目录：action -> { type（旧编号，兼容 /log 与历史统计）, category, label }
 * 新增功能时在这里登记一个动作，再在业务点调用 logOperation 即可。
 */
const ACTIONS = {
    // ---------- 系统 ----------
    bot_start: { type: 0, category: 'system', label: '机器人启动' },
    bot_stop: { type: 0, category: 'system', label: '机器人关闭' },
    setting_update: { type: 24, category: 'setting', label: '设置更新' },
    webui_login: { type: 27, category: 'webui', label: '控制台登录' },
    webui_login_fail: { type: 27, category: 'webui', label: '控制台登录失败' },
    webui_db_execute: { type: 28, category: 'webui', label: '控制台数据操作' },

    // ---------- 媒体收录 ----------
    media_save: { type: 1, category: 'media', label: '媒体收录' },
    media_save_duplicate: { type: 1, category: 'media', label: '媒体重复命中' },
    media_save_fail: { type: 1, category: 'media', label: '媒体收录失败' },
    channel_forward: { type: 1, category: 'media', label: '频道转发归属' },
    media_edit: { type: 2, category: 'media', label: '媒体描述修改' },
    media_delete: { type: 3, category: 'media', label: '媒体描述清空' },
    media_delete_group: { type: 19, category: 'media', label: '删除媒体组' },
    media_delete_one: { type: 19, category: 'media', label: '删除单个媒体' },
    media_clean_execute: { type: 18, category: 'clean', label: '执行清理' },
    media_clean_scan: { type: 18, category: 'clean', label: '清理扫描' },
    mark: { type: 20, category: 'media', label: '媒体标记' },

    // ---------- 发送 / 回复 / 合并 ----------
    send_media: { type: 25, category: 'send', label: '发送媒体' },
    send_text: { type: 25, category: 'send', label: '发送文本' },
    send_fail: { type: 25, category: 'send', label: '发送失败' },
    reply_media: { type: 13, category: 'reply', label: '回复媒体' },
    reply_text: { type: 13, category: 'reply', label: '回复文本' },
    reply_fail: { type: 13, category: 'reply', label: '回复失败' },
    media_merge: { type: 14, category: 'media', label: '媒体合并' },
    media_hide: { type: 15, category: 'media', label: '媒体加遮罩' },
    media_unhide: { type: 21, category: 'media', label: '媒体去遮罩' },

    // ---------- 查询 / 随机 / 帮助 ----------
    query_keyword: { type: 22, category: 'query', label: '关键字查询' },
    search: { type: 17, category: 'query', label: '查找' },
    help: { type: 16, category: 'query', label: '帮助' },
    log_view: { type: 17, category: 'query', label: '日志统计查看' },
    random_video: { type: 11, category: 'query', label: '随机视频' },
    random_picture: { type: 12, category: 'query', label: '随机图片' },

    // ---------- 媒体其他操作 ----------
    media_password: { type: 2, category: 'media', label: '媒体密码设置' },
    // 历史编号 23（LOG_TYPES.EDIT_TEXT）：旧数据只有 type，没有动作键，这里补一个正式名字，
    // 避免统计报表出现 legacy_type_23 这类占位名
    media_edit_text: { type: 23, category: 'media', label: '修改文本' },

    // ---------- 标签 ----------
    tag_add: { type: 26, category: 'tag', label: '标签添加' },
    tag_remove: { type: 26, category: 'tag', label: '标签移除' },
    tag_create: { type: 26, category: 'tag', label: '标签创建' },
    tag_rename: { type: 26, category: 'tag', label: '标签改名' },
    tag_delete: { type: 26, category: 'tag', label: '标签删除' },
    tag_pin: { type: 26, category: 'tag', label: '标签置顶' },

    // ---------- 用户 ----------
    user_create: { type: 29, category: 'user', label: '用户新增' },
    user_update: { type: 29, category: 'user', label: '用户修改' },
    user_delete: { type: 29, category: 'user', label: '用户删除' },
    user_ban: { type: 30, category: 'user', label: '用户封禁' },
    user_unban: { type: 30, category: 'user', label: '用户解封' },
    user_whitelist_add: { type: 31, category: 'user', label: '加入白名单' },
    user_whitelist_remove: { type: 31, category: 'user', label: '移出白名单' },
    user_join: { type: 32, category: 'user', label: '用户入群' },
    user_leave: { type: 32, category: 'user', label: '用户离群' },
    user_join_request: { type: 32, category: 'user', label: '入群审批' },

    // ---------- 群组 / 频道 ----------
    chat_create: { type: 33, category: 'chat', label: '聊天登记' },
    chat_update: { type: 33, category: 'chat', label: '聊天修改' },
    chat_delete: { type: 33, category: 'chat', label: '聊天删除' },
    chat_bind: { type: 33, category: 'chat', label: '频道群组绑定' },
    chat_unbind: { type: 33, category: 'chat', label: '解除绑定' },

    // ---------- 文章 / 合集 / 搬运 ----------
    article_save: { type: 34, category: 'content', label: '文章保存' },
    article_delete: { type: 34, category: 'content', label: '文章删除' },
    collection_save: { type: 35, category: 'content', label: '合集保存' },
    collection_delete: { type: 35, category: 'content', label: '合集删除' },
    transport_run: { type: 36, category: 'transport', label: '消息搬运' },
    transport_save: { type: 36, category: 'transport', label: '搬运收录保存' },
    transport_delete: { type: 36, category: 'transport', label: '搬运收录删除' },
    transport_check: { type: 36, category: 'transport', label: '收录链接活性检查' }
};

/** type -> action（反查，用于兼容旧 insertLog 调用与历史数据标签） */
const ACTION_BY_TYPE = {};
for (const [action, meta] of Object.entries(ACTIONS)) {
    if (ACTION_BY_TYPE[meta.type] === undefined) ACTION_BY_TYPE[meta.type] = action;
}

/**
 * 历史日志编号 → 展示用中文名（覆盖 db/log.js 的 LOG_TYPES 全集）
 * 仅用于「只有 type、没有 action/actionLabel」的旧数据兜底，
 * 保证报表里任何历史类型都有可读名字，而不是 legacy_type_23 / legacy_type_undefined。
 */
const LEGACY_TYPE_LABELS = {
    0: '机器人启动', 1: '媒体收录', 2: '媒体编辑', 3: '媒体删除',
    11: '随机视频', 12: '随机图片', 13: '消息回复', 14: '媒体合并',
    15: '媒体遮罩', 16: '帮助', 17: '查找', 18: '清理', 19: '删除模式',
    20: '标记', 21: '媒体去遮罩', 22: '关键字查询', 23: '修改文本',
    24: '设置更新', 25: '发送', 26: '标签操作', 27: '控制台登录',
    28: '控制台数据操作', 29: '用户管理', 30: '封禁/解封', 31: '白名单',
    32: '入群/离群', 33: '群组频道管理', 34: '文章', 35: '合集', 36: '搬运',
    '-1': '未知操作'
};

/** 历史编号 → 展示名（未登记的编号给一个带编号的可读名） */
function legacyTypeLabel(type) {
    const n = Number(type);
    if (!Number.isFinite(n)) return '未知操作';
    return LEGACY_TYPE_LABELS[String(n)] || `历史类型 ${n}`;
}

/** 只保留有限数值字段，避免把任意对象写进统计字段 */
function cleanCounts(counts) {
    if (!counts || typeof counts !== 'object') return undefined;
    const out = {};
    for (const [k, v] of Object.entries(counts)) {
        const num = Number(v);
        if (Number.isFinite(num) && num !== 0) out[k] = num;
    }
    return Object.keys(out).length ? out : undefined;
}

/** 限制 detail 体积（避免单条日志过大） */
function cleanDetail(detail) {
    if (!detail || typeof detail !== 'object') return undefined;
    const out = {};
    for (const [k, v] of Object.entries(detail)) {
        if (v === undefined || v === null || v === '') continue;
        if (typeof v === 'string') out[k] = v.length > 300 ? v.slice(0, 300) + '…' : v;
        else if (Array.isArray(v)) out[k] = v.slice(0, 30);
        else if (typeof v === 'object') out[k] = JSON.stringify(v).slice(0, 300);
        else out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
}

function actionLabel(action) {
    return (ACTIONS[action] && ACTIONS[action].label) || action;
}

function categoryLabel(category) {
    return CATEGORIES[category] || category;
}

/**
 * 写入一条操作日志（业务无关的失败兜底：绝不抛出）
 * @param {Object} entry
 * @param {string} entry.action   - 动作键（见 ACTIONS），未知键记为 unknown 但保留原文
 * @param {string} [entry.category] - 覆盖默认大类
 * @param {'ok'|'fail'} [entry.result='ok']
 * @param {'private'|'group'|'channel'|'webui'|'system'} [entry.source='private']
 * @param {number} [entry.userId] - 操作者（WebUI 用 0 表示控制台自身）
 * @param {number} [entry.chatId] / [entry.messageId] - 触发上下文
 * @param {{type:string,id:(string|number)}} [entry.target] - 操作对象
 * @param {Object} [entry.counts] - 统计数值（media/groups/users/messages/mediaTypes…）
 * @param {Object} [entry.detail] - 结构化细节（标签、查询词、媒体类型、时长…）
 * @param {string} [entry.error]  - 失败原因
 * @param {number} [entry.durationMs]
 * @returns {Promise<boolean>} 是否写入成功
 */
async function logOperation(entry = {}) {
    try {
        const key = typeof entry.action === 'string' && entry.action ? entry.action : 'unknown';
        const meta = ACTIONS[key];
        const now = Date.now();

        const doc = {
            logSchema: SCHEMA_VERSION,
            action: key,
            actionLabel: meta ? meta.label : (entry.actionLabel || key),
            category: entry.category || (meta ? meta.category : 'system'),
            type: entry.type !== undefined ? entry.type : (meta ? meta.type : -1),
            result: entry.result === 'fail' ? 'fail' : 'ok',
            source: entry.source || (entry.userId === 0 ? 'webui' : 'private'),
            time: now,
            date: new Date(now)
        };
        if (entry.userId !== undefined && entry.userId !== null) doc.userId = entry.userId;
        if (entry.chatId !== undefined && entry.chatId !== null) doc.chatId = entry.chatId;
        if (entry.messageId !== undefined && entry.messageId !== null) doc.messageId = entry.messageId;
        if (entry.target && entry.target.type) doc.target = { type: entry.target.type, id: entry.target.id };
        const counts = cleanCounts(entry.counts);
        if (counts) doc.counts = counts;
        const detail = cleanDetail(entry.detail);
        if (detail) doc.detail = detail;
        if (entry.error) doc.error = String(entry.error).slice(0, 300);
        if (entry.durationMs !== undefined && entry.durationMs !== null) doc.durationMs = Math.round(entry.durationMs);

        await getCollection(COLLECTIONS.LOG).insertOne(doc);

        const target = doc.target ? ` target=${doc.target.type}:${doc.target.id}` : '';
        const countsText = doc.counts ? ` counts=${JSON.stringify(doc.counts)}` : '';
        logger.info(`操作日志: ${doc.action}(${doc.actionLabel}) result=${doc.result}${doc.userId !== undefined ? ` user=${doc.userId}` : ''}${target}${countsText}`);
        return true;
    } catch (err) {
        // 日志失败不能影响业务
        logger.error(`操作日志写入失败: ${err.message}`);
        return false;
    }
}

/**
 * 旧接口兼容：insertLog(type, userId, extra)
 * 自动把旧编号映射为新动作键，未知的 extra 字段进入 detail
 * @deprecated 新代码请直接使用 logOperation
 */
async function insertLog(type, userId, extra = {}) {
    const action = ACTION_BY_TYPE[type] || 'unknown';
    const { queryText, setting, value, ...rest } = extra || {};
    return logOperation({
        action,
        type,
        userId,
        detail: {
            ...rest,
            ...(queryText ? { query: queryText } : {}),
            ...(setting ? { setting, value } : {})
        }
    });
}

/** 供 WebUI/报表使用的目录（动作 + 大类 + 旧编号） */
function getCatalog() {
    return {
        schemaVersion: SCHEMA_VERSION,
        categories: CATEGORIES,
        actions: Object.entries(ACTIONS).map(([action, meta]) => ({
            action,
            label: meta.label,
            category: meta.category,
            type: meta.type
        }))
    };
}

module.exports = {
    SCHEMA_VERSION,
    CATEGORIES,
    ACTIONS,
    ACTION_BY_TYPE,
    logOperation,
    insertLog,
    getCatalog,
    actionLabel,
    categoryLabel,
    legacyTypeLabel,
    LEGACY_TYPE_LABELS
};
