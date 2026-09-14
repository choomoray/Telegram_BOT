// utils/crashNotify.js
/**
 * 崩溃重启留痕 + 重启成功播报（bot 侧）
 *
 * 看门狗在拉起新进程前，会把崩溃现场写到 `watchdog/crash-marker.json`。
 * bot 启动就绪（**数据库已连接、polling 已开始**）后读取该文件：
 *   1. 写一条 opLog（`bot_watchdog_restart`），WebUI 的操作日志里能查到历史；
 *   2. 用**主 bot 自己**给管理员发一条「♻️ BOT重启成功」（带崩溃前的最近 3 条 warn/erro）。
 * 读完即删，保证同一次崩溃只记 / 只报一次。
 *
 * 分工（用户要求）：
 *   - 「崩溃」报告由看门狗发（崩溃瞬间 bot 已死，只能由外部发，见 watchdog/notify.js）；
 *   - 「重启成功」报告**必须由重启成功、连上数据库的主 bot 第一时间发**，
 *     不能等看门狗的健康轮询确认（那要几十秒到几分钟，用户看到的"重启成功"会迟到）。
 */
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const MARKER_FILE = path.join(__dirname, '..', 'watchdog', 'crash-marker.json');

function safeText(v, fallback = '未知') {
    if (v === null || v === undefined || v === '') return fallback;
    return String(v);
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
 * 给所有管理员发「♻️ BOT重启成功」（文案与看门狗崩溃报告同一套格式，见 watchdog/notify.js）
 * @param {Object} info - 崩溃标记内容（取其中的 tail / reportLimit）
 * @returns {Promise<number>} 成功发送的管理员数
 */
async function sendRestartReport(info) {
    // 通知模式为 off（看门狗崩溃标记里带过来）时不发，保持"彻底不发通知"的语义
    if (info && info.notifyMode === 'off') {
        logger.info('通知模式为 off，跳过重启成功播报');
        return 0;
    }
    // 文案格式化复用看门狗那份实现（纯 Node 内置依赖，不会把 bot 的依赖问题带给它，反之亦然）
    const { formatRestartReport, DEFAULT_REPORT_LIMIT } = require('../watchdog/notify');
    const { ADMIN_CHAT_IDS } = require('../config');
    if (!Array.isArray(ADMIN_CHAT_IDS) || ADMIN_CHAT_IDS.length === 0) {
        logger.warn('未配置 ADMIN_CHAT_ID，跳过重启成功播报');
        return 0;
    }
    const limit = Number(info && info.reportLimit) > 0 ? Number(info.reportLimit) : DEFAULT_REPORT_LIMIT;
    const text = formatRestartReport({ ok: true, tail: (info && info.tail) || [], limit });
    const bot = require('../bot');

    let sent = 0;
    for (const chatId of ADMIN_CHAT_IDS) {
        try {
            await bot.sendMessage(chatId, text, { disable_web_page_preview: true });
            sent++;
        } catch (err) {
            logger.warn(`重启成功播报发送失败 chat_id=${chatId}: ${err.message}`);
        }
    }
    if (sent > 0) logger.success(`已向 ${sent} 位管理员播报「BOT重启成功」`);
    return sent;
}

/**
 * 启动就绪后播报"上次是被看门狗从崩溃中拉起来的"
 *
 * 在 index.js 里位于「数据库连接成功 + bot 开始 polling」之后，因此这条通知
 * 就是重启成功后的第一时间发出的（不再等看门狗健康轮询确认）。
 *
 * @returns {Promise<{reported: boolean, reason?: string, sent?: number}>}
 */
async function reportRestartFromWatchdog() {
    const info = consumeCrashMarker();
    if (!info) return { reported: false };

    logger.warn(`检测到上次为崩溃退出，已由看门狗自动重启：${safeText(info.reason)}`);

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
                crashedAt: info.timeText
            }
        });
    } catch (err) {
        logger.warn(`重启事件写操作日志失败: ${err.message}`);
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
    consumeCrashMarker,
    sendRestartReport,
    reportRestartFromWatchdog
};
