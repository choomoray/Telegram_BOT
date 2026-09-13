// utils/crashNotify.js
/**
 * 崩溃重启播报（bot 侧）
 *
 * 看门狗在拉起新进程前，会把崩溃现场写到 `watchdog/crash-marker.json`。
 * bot 启动就绪后读取该文件：
 *   1. 通知管理员「已自动重启 + 崩溃原因 + 最近日志」；
 *   2. 写一条 opLog（`bot_watchdog_restart`），WebUI 的操作日志里能查到历史；
 *   3. **删除标记文件**，保证同一次崩溃只播报一次。
 *
 * 为什么要由 bot 来发（而不是看门狗直接发）：
 *   这条消息本身就是"重启成功"的证据；看门狗只在重启**失败**时才直接发（见 watchdog.js）。
 */
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const MARKER_FILE = path.join(__dirname, '..', 'watchdog', 'crash-marker.json');

/** 格式化崩溃时间为本地可读文本（marker 里存的是看门狗写的字符串，这里兜底解析） */
function safeText(v, fallback = '未知') {
    if (v === null || v === undefined || v === '') return fallback;
    return String(v);
}

/** 组装给管理员的消息 */
function formatRestartReport(info) {
    const args = Array.isArray(info.botArgs) && info.botArgs.length ? ' ' + info.botArgs.join(' ') : '';
    const lines = [];
    lines.push('🔄 Bot 已自动重启');
    lines.push('');
    lines.push(`启动方式：node index.js${args}（${safeText(info.mode)}）`);
    lines.push(`崩溃时间：${safeText(info.timeText)}`);
    lines.push(`原因：${safeText(info.reason)}`);
    if (info.uptimeText) lines.push(`崩溃前已运行：${info.uptimeText}`);
    lines.push(`连续崩溃：${safeText(info.consecutive)}/${safeText(info.maxRestarts)}`);
    if (Array.isArray(info.tail) && info.tail.length) {
        lines.push('');
        lines.push('最近日志：');
        // Telegram 单条消息上限 4096 字符，这里做个保守截断
        const tail = info.tail.slice(-20).join('\n');
        lines.push(tail.length > 2500 ? tail.slice(-2500) : tail);
    }
    return lines.join('\n');
}

/**
 * 读取并消费崩溃标记（幂等：读完即删，改名为 .consumed 失败也不影响）
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

    // 先删除，避免播报过程中再次崩溃导致重复通知
    try {
        fs.unlinkSync(MARKER_FILE);
    } catch (err) {
        logger.warn(`删除崩溃标记失败（可能导致重复播报）: ${err.message}`);
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
 * 启动就绪后播报上次崩溃导致的重启
 * @returns {Promise<{reported: boolean, notified?: number, reason?: string}>}
 */
async function reportRestartFromWatchdog() {
    const info = consumeCrashMarker();
    if (!info) return { reported: false };

    const text = formatRestartReport(info);
    let notified = 0;
    try {
        const { notifyAdmins } = require('./linkHealth');
        notified = await notifyAdmins(text);
    } catch (err) {
        logger.warn(`重启播报发送失败: ${err.message}`);
    }

    logger.warn(`检测到上次为崩溃退出，已自动重启并通知 ${notified} 位管理员：${safeText(info.reason)}`);

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
                notified,
                crashedAt: info.timeText
            }
        });
    } catch (err) {
        logger.warn(`重启事件写操作日志失败: ${err.message}`);
    }

    return { reported: true, notified, reason: info.reason };
}

module.exports = {
    MARKER_FILE,
    consumeCrashMarker,
    formatRestartReport,
    reportRestartFromWatchdog
};
