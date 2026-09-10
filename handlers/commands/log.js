// handlers/commands/log.js
/**
 * /log 操作统计（schema v2）
 *
 * 统计口径：
 *   - 主口径按 `category` 汇总 + 按 `action` 明细；历史数据没有 action/category 时
 *     用旧编号 `type` 通过 ACTION_BY_TYPE 归类回退（兼容迁移前的日志）
 *   - 产出量：counts.media / counts.groups 求和
 *   - 活跃时段：北京时间（±8 小时）每 4 小时一段
 *   - 时间口径：近 7 天 / 本月 / 本年（用 date 字段，缺失时 time）
 *
 * 实现说明：一次 find({time:{$gte:年初}}).limit(...) 取数后用 JS 聚合
 * （不使用 aggregate：测试注入的假集合不支持），条数上限 20000，
 * 超出时在文本中注明「仅统计最近 20000 条」。
 */
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { ACTION_BY_TYPE, ACTIONS, actionLabel, categoryLabel, logOperation } = require('../../utils/opLog');

const MAX_DOCS = 20000;      // 单次统计的最大条数（避免日志量过大拖慢查询）
const DAY_MS = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000; // 北京时间 = UTC+8

// 大类展示顺序（未列出的排在最后）
const CATEGORY_ORDER = [
    'media', 'send', 'reply', 'query', 'clean', 'tag',
    'user', 'chat', 'setting', 'content', 'transport', 'webui', 'system'
];

// 活跃时段（北京时间，每 4 小时一段，沿用原有分段）
const HOUR_SLOTS = [
    { label: '00-04', start: 0, end: 4 },
    { label: '04-08', start: 4, end: 8 },
    { label: '08-12', start: 8, end: 12 },
    { label: '12-16', start: 12, end: 16 },
    { label: '16-20', start: 16, end: 20 },
    { label: '20-24', start: 20, end: 24 }
];

/**
 * 解析单条日志的动作/大类（历史数据没有 action 时用 type 回退归类）
 * @param {Object} doc - 日志文档
 * @returns {{action: string, category: string}}
 */
function resolveAction(doc) {
    let action = doc.action;
    if (!action && doc.type !== undefined && doc.type !== null) {
        action = ACTION_BY_TYPE[doc.type];
    }
    if (!action) action = 'unknown';
    const category = doc.category || (ACTIONS[action] && ACTIONS[action].category) || 'system';
    return { action, category };
}

/**
 * 取日志时间戳（优先 date 字段，缺失时用 time）
 * @param {Object} doc - 日志文档
 * @returns {number} 毫秒时间戳（无有效时间返回 0）
 */
function resolveTime(doc) {
    if (doc.date) {
        const t = doc.date instanceof Date ? doc.date.getTime() : new Date(doc.date).getTime();
        if (Number.isFinite(t)) return t;
    }
    return typeof doc.time === 'number' ? doc.time : 0;
}

/**
 * 聚合一批日志：按大类 → 动作汇总，并累计产出量与北京时间各时段活跃度
 * @param {Array} docs - 日志文档数组
 * @returns {{categories: Map, counts: {media:number, groups:number}, slots:number[], total:number, actions:Set<string>}}
 */
function aggregateLogs(docs) {
    const categories = new Map(); // category -> { total, actions: Map(action -> {count, media, groups}) }
    const counts = { media: 0, groups: 0 };
    const slots = new Array(HOUR_SLOTS.length).fill(0);
    const actions = new Set();

    for (const doc of docs) {
        const { action, category } = resolveAction(doc);
        actions.add(action);

        if (!categories.has(category)) categories.set(category, { total: 0, actions: new Map() });
        const cat = categories.get(category);
        cat.total++;

        if (!cat.actions.has(action)) cat.actions.set(action, { count: 0, media: 0, groups: 0 });
        const act = cat.actions.get(action);
        act.count++;

        // 产出量（新版 counts 字段；历史数据没有则不计）
        const c = doc.counts || {};
        const media = Number(c.media) || 0;
        const groups = Number(c.groups) || 0;
        act.media += media;
        act.groups += groups;
        counts.media += media;
        counts.groups += groups;

        // 活跃时段（北京时间）
        const t = resolveTime(doc);
        if (t > 0) {
            const hour = new Date(t + BEIJING_OFFSET_MS).getUTCHours();
            const idx = Math.floor(hour / 4);
            if (idx >= 0 && idx < slots.length) slots[idx]++;
        }
    }

    return { categories, counts, slots, total: docs.length, actions };
}

/** 生成活跃时段条形图（相对比例，最多 10 个方块） */
function buildHourChart(slots) {
    const lines = ['📊 活跃时段（北京时间）'];
    const maxCount = Math.max(...slots, 1);
    const maxBars = 10;
    for (let i = 0; i < HOUR_SLOTS.length; i++) {
        const filled = Math.round((slots[i] / maxCount) * maxBars);
        const bar = '■'.repeat(filled) + '□'.repeat(maxBars - filled);
        lines.push(`${HOUR_SLOTS[i].label}\t${bar}`);
    }
    return lines.join('\n');
}

/** 生成「各大类一行」的统计文本（媒体 收录12/编辑3…） */
function buildCategoryLines(categories) {
    const known = CATEGORY_ORDER.filter(c => categories.has(c));
    const rest = [...categories.keys()].filter(c => !CATEGORY_ORDER.includes(c));
    const order = [...known, ...rest];
    if (order.length === 0) return '（暂无操作记录）';

    return order.map(category => {
        const cat = categories.get(category);
        const actions = [...cat.actions.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .map(([action, stat]) => `${actionLabel(action)}${stat.count}`)
            .join('/');
        return `${categoryLabel(category)} ${actions}`;
    }).join('\n');
}

/**
 * 依据已取到的一批日志生成某个时间口径的统计报告
 * @param {Array} docs - 该时间范围内的日志
 * @param {string} title - 报告标题（如「近 7 天」）
 * @param {Object} [opts] - { detail: 是否展开「大类 → 动作」明细（默认 true） }
 */
function buildReport(docs, title, opts = {}) {
    const agg = aggregateLogs(docs);
    const detail = opts.detail !== false;
    const truncated = agg.total >= MAX_DOCS ? '（仅统计最近 20000 条）' : '';

    if (!detail) {
        return {
            text: `【${title}】${agg.total} 次操作 · 媒体 ${agg.counts.media} · 媒体组 ${agg.counts.groups}${truncated}`,
            agg
        };
    }

    let text = `📊 操作统计（${title}）\n`;
    text += `共 ${agg.total} 次操作 · 媒体 ${agg.counts.media} · 媒体组 ${agg.counts.groups}${truncated}\n\n`;
    text += buildCategoryLines(agg.categories);
    return { text, agg };
}

async function handleLogCommand(userId, msg) {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    let processingMsg;
    try {
        processingMsg = await bot.sendMessage(chatId, '🔍 日志正在查询中...', {
            reply_to_message_id: messageId,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`用户 ${userId} /log 发送查询中消息失败: ${err.message}`);
        return;
    }

    (async () => {
        try {
            // 三个时间口径：近 7 天 / 本月 / 本年（北京时间边界）
            const now = Date.now();
            const beijingNow = new Date(now + BEIJING_OFFSET_MS);
            const last7d = now - 7 * DAY_MS;
            const monthStart = Date.UTC(beijingNow.getUTCFullYear(), beijingNow.getUTCMonth(), 1) - BEIJING_OFFSET_MS;
            const yearStart = Date.UTC(beijingNow.getUTCFullYear(), 0, 1) - BEIJING_OFFSET_MS;

            // 一次取数（年初至今），三个口径在 JS 内按时间切分
            const logCol = getCollection(COLLECTIONS.LOG);
            const docs = await logCol.find({
                $or: [
                    { date: { $gte: new Date(yearStart) } },
                    { time: { $gte: yearStart } }
                ]
            }).limit(MAX_DOCS).toArray();

            const recent7d = docs.filter(d => resolveTime(d) >= last7d);
            const recentMonth = docs.filter(d => resolveTime(d) >= monthStart);

            // 结构：近 7 天明细（大类 → 动作）+ 本月/本年汇总 + 本年活跃时段
            const week = buildReport(recent7d, '近 7 天');
            const month = buildReport(recentMonth, '本月', { detail: false });
            const year = buildReport(docs, '本年', { detail: false });

            const segments = [
                week.text,
                '',
                month.text,
                year.text,
                '',
                buildHourChart(year.agg.slots)
            ];
            let result = segments.join('\n');
            // Telegram 单条上限 4096：超长时退化为「仅汇总 + 时段图」，保证能发出去
            if (result.length > 3800) {
                result = [week.text.split('\n\n')[0], month.text, year.text, '', buildHourChart(year.agg.slots)].join('\n');
            }
            if (result.length > 4000) result = result.slice(0, 3990) + '…';
            await bot.editMessageText(result, {
                chat_id: chatId,
                message_id: processingMsg.message_id
            });

            // 统计查看留痕（记录本次统计覆盖的动作数）
            logOperation({
                action: 'log_view',
                source: 'private',
                userId,
                detail: { types: year.agg.actions.size }
            }).catch(() => { });

            logger.info(`用户 ${userId} 执行 /log 统计成功`);
        } catch (err) {
            logger.error(`执行 /log 失败: ${err.message}`);
            try {
                await bot.editMessageText('❌ 统计失败，请稍后重试', {
                    chat_id: chatId,
                    message_id: processingMsg.message_id
                });
            } catch (editErr) {
                logger.error(`编辑错误消息失败: ${editErr.message}`);
            }
        }
    })();
}

module.exports = handleLogCommand;
