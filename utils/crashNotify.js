// utils/crashNotify.js
/**
 * 崩溃重启留痕（bot 侧）
 *
 * 看门狗在拉起新进程前，会把崩溃现场写到 `watchdog/crash-marker.json`。
 * bot 启动就绪后读取该文件，**只写一条 opLog**（`bot_watchdog_restart`），
 * WebUI 的操作日志里能查到历史；读完即删，保证同一次崩溃只记一次。
 *
 * 注意分工：**崩溃 / 重启的 Telegram 通知由看门狗负责**
 * （watchdog/notify.js + 短命的 watchdog/notify-bot.js）——
 * 崩溃瞬间 bot 已死，而"重启是否真的成功"也只有看门狗能连续观测，
 * 因此通知不放在 bot 侧，避免重复发送与"起来又立刻崩"时误报成功。
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
 * 启动就绪后记录"上次是被看门狗从崩溃中拉起来的"
 * @returns {Promise<{reported: boolean, reason?: string}>}
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

    return { reported: true, reason: info.reason };
}

module.exports = {
    MARKER_FILE,
    consumeCrashMarker,
    reportRestartFromWatchdog
};
