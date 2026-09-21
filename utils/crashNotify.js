// utils/crashNotify.js
/**
 * 崩溃重启留痕 + 重启成功播报（bot 侧）
 *
 * 看门狗在拉起新进程前，会把崩溃现场写到 `watchdog/crash-marker.json`。
 * bot 启动就绪（**数据库已连接、polling 已开始**）后：
 *   0. **每次启动**都往通知群发一条「🚀 BOT已启动」（reportBotStarted）；
 *   1. 读取该文件 → 写一条 opLog（`bot_watchdog_restart`），WebUI 的操作日志里能查到历史；
 *   2. 给通知群发一条「♻️ BOT重启成功」（带崩溃前的最近 3 条 warn/erro）。
 * 读完即删，保证同一次崩溃只记 / 只报一次。
 *
 * **通知去向（用户要求）**：统一发到 `.env` 的 `STARTUP_NOTIFY_CHAT_ID` + `STARTUP_NOTIFY_THREAD_ID`
 * 指定的**话题群话题**（默认 -1002223278475 / 85），**不再私聊管理员**；
 * 该会话同时被列入"完全不处理"名单（只发通知，不收录、不响应、不管理）。未配置时退回私聊管理员。
 *
 * **时效（用户要求）**：崩溃信息超过 30 分钟就过期 —— 过期时只写 opLog 留痕
 * （detail.stale=true），**不再**发 Telegram 播报。避免"看门狗早已放弃重启、
 * 用户隔几小时手动启动"时收到一条没有意义的「BOT重启成功」。
 * 上限可用看门狗侧 `WATCHDOG_REPORT_MAX_AGE_MIN`（分钟）调整。
 *
 * 分工：
 *   - 「崩溃」报告由看门狗发（崩溃瞬间 bot 已死，只能由外部发，见 watchdog/notify.js）；
 *   - 「启动」与「重启成功」报告由**主 bot 自己**在连上数据库、polling 就绪的第一时间发
 *     （看门狗"等健康确认再补发"要几十秒到几分钟，用户看到的通知会迟到，已移除）。
 */
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const MARKER_FILE = path.join(__dirname, '..', 'watchdog', 'crash-marker.json');

/**
 * 崩溃标记的默认时效上限：超过 30 分钟就不再向管理员播报（用户要求）。
 *
 * 为什么需要：标记文件是"上一次崩溃"的现场，正常情况下看门狗 30 秒后就把 bot 拉起来、
 * bot 立刻读掉它，年龄最多几十秒。但下面这些情况下它会长期躺在磁盘上：
 *   - 看门狗连续崩溃达上限后退出（不再自动重启），用户几小时后才手动启动；
 *   - 崩溃发生在启动阶段、bot 还没走到播报就被再次杀掉。
 * 这时再发「♻️ BOT重启成功」既没有意义（不是这次的启动）、也会让用户以为刚崩过。
 *
 * 看门狗可在标记里带 `reportMaxAgeMs` 覆盖（见 watchdog/config.js: WATCHDOG_REPORT_MAX_AGE_MIN）。
 */
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

function safeText(v, fallback = '未知') {
    if (v === null || v === undefined || v === '') return fallback;
    return String(v);
}

/**
 * 崩溃标记的年龄（毫秒）；无法判断时返回 null。
 *
 * 优先用 `crashedAtMs`（看门狗写标记时的时间戳，最可靠）；
 * 老版本标记没有该字段时退回解析 `timeText`（`YYYY-MM-DD HH:mm:ss`，本地时区）。
 *
 * @param {Object} info - 崩溃标记内容
 * @param {number} [now] - 当前时间戳（测试可注入）
 * @returns {number|null}
 */
function crashMarkerAgeMs(info, now = Date.now()) {
    const ts = Number(info && info.crashedAtMs);
    if (Number.isFinite(ts) && ts > 0) return Math.max(0, now - ts);

    const raw = String((info && info.timeText) || '').trim();
    if (raw) {
        const parsed = Date.parse(raw.replace(' ', 'T'));
        if (Number.isFinite(parsed)) return Math.max(0, now - parsed);
    }
    return null;
}

/**
 * 读取并消费崩溃标记（幂等：读完即删）
 * @returns {Object|null} 崩溃信息；无标记时返回 null
 */
function consumeCrashMarker() {
    let raw;
    try {
        if (!fs.existsSync(MARKER_FILE)) return null;
        raw = fs.readFileSync(MARKER_FILE, 'utf8');
    } catch (err) {
        logger.warn(`读取崩溃标记失败: ${err.message}`);
        return null;
    }

    // 先删除，避免处理过程中再次崩溃导致重复留痕
    try {
        fs.unlinkSync(MARKER_FILE);
    } catch (err) {
        logger.warn(`删除崩溃标记失败（可能导致重复留痕）: ${err.message}`);
    }

    try {
        const info = JSON.parse(raw);
        if (!info || typeof info !== 'object') return null;
        return info;
    } catch (err) {
        logger.warn(`崩溃标记内容无法解析: ${err.message}`);
        return null;
    }
}

/**
 * 通知收件会话（用户要求）：
 *   配置了 `STARTUP_NOTIFY_CHAT_ID` → 只发那个**话题群**的指定话题（不再私聊管理员）；
 *   未配置（0）→ 退回管理员私聊，保持老行为。
 * @returns {Array<{chatId:number, threadId:(number|undefined)}>}
 */
function notifyTargets() {
    const { STARTUP_NOTIFY_CHAT_ID, STARTUP_NOTIFY_THREAD_ID, ADMIN_CHAT_IDS } = require('../config');
    if (STARTUP_NOTIFY_CHAT_ID) {
        return [{ chatId: STARTUP_NOTIFY_CHAT_ID, threadId: STARTUP_NOTIFY_THREAD_ID || undefined }];
    }
    return (Array.isArray(ADMIN_CHAT_IDS) ? ADMIN_CHAT_IDS : []).map(chatId => ({ chatId, threadId: undefined }));
}

/** 本地时间文本（`YYYY-MM-DD HH:mm:ss`，与看门狗 timeText() 同格式） */
function nowText(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 把一条通知发给所有收件会话（通知群按话题发） */
async function sendNotify(text, { disablePreview = true } = {}) {
    const bot = require('../bot');
    let sent = 0;
    for (const { chatId, threadId } of notifyTargets()) {
        try {
            await bot.sendMessage(chatId, text, {
                ...(threadId ? { message_thread_id: threadId } : {}),
                ...(disablePreview ? { disable_web_page_preview: true } : {})
            });
            sent++;
        } catch (err) {
            logger.warn(`通知发送失败 chat_id=${chatId}${threadId ? ` thread=${threadId}` : ''}: ${err.message}`);
        }
    }
    return sent;
}

/**
 * 每次启动的播报：「🚀 BOT已启动」，发到通知群（话题群）。
 *
 * 与「♻️ BOT重启成功」的区别：这条**每次启动都发**（正常启动也有），
 * 那条只在"上次是崩溃退出、由看门狗拉起来"时发（见 reportRestartFromWatchdog）。
 *
 * @returns {Promise<{sent:number, text:string}>}
 */
async function reportBotStarted() {
    const { version } = require('../package.json');
    const mode = process.argv.includes('test') ? 'test' : (process.argv.includes('webui') ? 'webui' : 'normal');
    let dbName = '';
    try {
        dbName = require('../database').getDatabaseName();
    } catch (err) {
        dbName = '';
    }
    const text = [
        '🚀 BOT已启动',
        '',
        `版本：${version}　模式：${mode}`,
        ...(dbName ? [`数据库：${dbName}`] : []),
        `时间：${nowText()}`
    ].join('\n');

    const sent = await sendNotify(text);
    if (sent > 0) logger.success(`已播报「BOT已启动」（${sent} 个收件会话）`);
    return { sent, text };
}

/**
 * 给所有管理员发「♻️ BOT重启成功」（文案与看门狗崩溃报告同一套格式，见 watchdog/notify.js）
 * @param {Object} info - 崩溃标记内容（取其中的 tail / reportLimit）
 * @returns {Promise<number>} 成功发送的收件会话数
 */
async function sendRestartReport(info) {
    // 通知模式为 off（看门狗崩溃标记里带过来）时不发，保持"彻底不发通知"的语义
    if (info && info.notifyMode === 'off') {
        logger.info('通知模式为 off，跳过重启成功播报');
        return 0;
    }
    // 文案格式化复用看门狗那份实现（纯 Node 内置依赖，不会把 bot 的依赖问题带给它，反之亦然）
    const { formatRestartReport, DEFAULT_REPORT_LIMIT } = require('../watchdog/notify');
    const limit = Number(info && info.reportLimit) > 0 ? Number(info.reportLimit) : DEFAULT_REPORT_LIMIT;
    const text = formatRestartReport({ ok: true, tail: (info && info.tail) || [], limit });

    const sent = await sendNotify(text);
    if (sent > 0) logger.success(`已播报「BOT重启成功」（${sent} 个收件会话）`);
    return sent;
}

/**
 * 启动就绪后播报"上次是被看门狗从崩溃中拉起来的"
 *
 * 在 index.js 里位于「数据库连接成功 + bot 开始 polling」之后，因此这条通知
 * 就是重启成功后的第一时间发出的（不再等看门狗健康轮询确认）。
 *
 * **时效**：崩溃标记超过 `reportMaxAgeMs`（默认 30 分钟）就过期 ——
 * 只写一条 opLog 留痕，不再向管理员播报「BOT重启成功」（用户要求）。
 *
 * @returns {Promise<{reported: boolean, reason?: string, sent?: number, stale?: boolean, ageMs?: number}>}
 */
async function reportRestartFromWatchdog() {
    const info = consumeCrashMarker();
    if (!info) return { reported: false };

    const maxAgeMs = Number(info.reportMaxAgeMs) > 0 ? Number(info.reportMaxAgeMs) : DEFAULT_MAX_AGE_MS;
    const ageMs = crashMarkerAgeMs(info);
    const stale = ageMs !== null && ageMs > maxAgeMs;
    const ageText = ageMs === null ? '无法判断' : `${Math.round(ageMs / 60000)} 分钟`;

    if (stale) {
        logger.warn(`崩溃标记已过期（${ageText}前，上限 ${Math.round(maxAgeMs / 60000)} 分钟），本次只留痕、不再播报`);
    } else {
        logger.warn(`检测到上次为崩溃退出，已由看门狗自动重启：${safeText(info.reason)}`);
    }

    try {
        const { logOperation } = require('./opLog');
        await logOperation({
            action: 'bot_watchdog_restart',
            source: 'system',
            result: 'ok',
            detail: {
                reason: info.reason,
                exitCode: info.exitCode === undefined ? undefined : info.exitCode,
                signal: info.signal || undefined,
                mode: info.mode,
                botArgs: Array.isArray(info.botArgs) ? info.botArgs : [],
                uptimeText: info.uptimeText || undefined,
                consecutive: info.consecutive,
                maxRestarts: info.maxRestarts,
                crashedAt: info.timeText,
                // 过期标记：留痕但注明"未播报"，便于在 WebUI 操作日志里区分
                stale: stale || undefined,
                staleAgeMinutes: stale ? Math.round(ageMs / 60000) : undefined
            }
        });
    } catch (err) {
        logger.warn(`重启事件写操作日志失败: ${err.message}`);
    }

    // 过期（如看门狗早已停止重启、用户几小时后手动启动）：到此为止，不发 Telegram 消息
    if (stale) {
        return { reported: false, reason: 'stale', stale: true, ageMs };
    }

    // 重启成功的第一时间向管理员播报（用主 bot 自己发，不依赖看门狗）
    let sent = 0;
    try {
        sent = await sendRestartReport(info);
    } catch (err) {
        logger.warn(`重启成功播报失败: ${err.message}`);
    }

    return { reported: true, reason: info.reason, sent };
}

module.exports = {
    MARKER_FILE,
    DEFAULT_MAX_AGE_MS,
    crashMarkerAgeMs,
    consumeCrashMarker,
    notifyTargets,
    nowText,
    sendNotify,
    reportBotStarted,
    sendRestartReport,
    reportRestartFromWatchdog
};
