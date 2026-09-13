// watchdog/notify.js
/**
 * 独立 Telegram 通知：直接用 Node 内置 https 调 Bot API。
 *
 * 为什么不 require 项目的 bot.js / node-telegram-bot-api：
 *   - 崩溃瞬间 bot 是死的，通知必须由看门狗自己发；
 *   - 也不希望 bot 侧的依赖问题把看门狗一起拖垮。
 */
const https = require('https');
const { URLSearchParams } = require('url');

/**
 * 发送一条 Telegram 消息
 * @param {Object} cfg - 看门狗配置（需要 telegramToken / adminChatIds）
 * @param {string} text - 消息内容
 * @returns {Promise<{sent: number, failed: number, errors: string[]}>}
 */
async function sendToAdmins(cfg, text) {
    const result = { sent: 0, failed: 0, errors: [] };
    if (!cfg.telegramToken || !Array.isArray(cfg.adminChatIds) || cfg.adminChatIds.length === 0) {
        result.errors.push('缺少 TELEGRAM_BOT_TOKEN 或 ADMIN_CHAT_ID，无法发送通知');
        return result;
    }
    if (!text) return result;

    for (const chatId of cfg.adminChatIds) {
        try {
            await sendMessage(cfg.telegramToken, chatId, text);
            result.sent++;
        } catch (err) {
            result.failed++;
            result.errors.push(`chat ${chatId}: ${err.message}`);
        }
    }
    return result;
}

/** 原生 https POST /sendMessage（不引第三方库） */
function sendMessage(token, chatId, text) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            chat_id: String(chatId),
            text,
            disable_web_page_preview: 'true'
        }).toString();

        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${token}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
                reject(new Error(`HTTP ${res.statusCode} ${String(data).slice(0, 200)}`));
            });
        });

        req.on('timeout', () => { req.destroy(new Error('请求超时')); });
        req.on('error', reject);
        req.end(body);
    });
}

/** 崩溃通知文案 */
function formatCrashReport(info) {
    const lines = [];
    lines.push(`💥 Bot 崩溃，${Math.round(info.restartDelayMs / 1000)} 秒后自动重启`);
    lines.push('');
    lines.push(`启动方式：node index.js${info.botArgs && info.botArgs.length ? ' ' + info.botArgs.join(' ') : ''}（${info.mode}）`);
    lines.push(`崩溃时间：${info.timeText}`);
    lines.push(`原因：${info.reason}`);
    if (info.uptimeText) lines.push(`崩溃前已运行：${info.uptimeText}`);
    lines.push(`连续崩溃：${info.consecutive}/${info.maxRestarts}`);
    if (info.tail && info.tail.length) {
        lines.push('');
        lines.push('最近日志：');
        lines.push(info.tail.join('\n'));
    }
    return lines.join('\n');
}

/** 重启失败 / 反复崩溃通知文案 */
function formatRestartFailedReport(info) {
    const lines = [];
    lines.push('🚨 Bot 重启后未能就绪（可能仍在崩溃循环）');
    lines.push('');
    lines.push(`启动方式：node index.js${info.botArgs && info.botArgs.length ? ' ' + info.botArgs.join(' ') : ''}（${info.mode}）`);
    lines.push(`最后崩溃：${info.timeText}`);
    lines.push(`原因：${info.reason}`);
    lines.push(`连续崩溃：${info.consecutive}/${info.maxRestarts}`);
    if (info.tail && info.tail.length) {
        lines.push('');
        lines.push('最近日志：');
        lines.push(info.tail.join('\n'));
    }
    return lines.join('\n');
}

/** 达到重启上限、停止重试的通知文案 */
function formatGiveUpReport(info) {
    return [
        '🛑 Bot 反复崩溃，看门狗已停止自动重启，请人工介入',
        '',
        `启动方式：node index.js${info.botArgs && info.botArgs.length ? ' ' + info.botArgs.join(' ') : ''}（${info.mode}）`,
        `时间窗口：${Math.round(info.restartWindowMs / 60000)} 分钟内崩溃 ${info.consecutive} 次（上限 ${info.maxRestarts}）`,
        `最后原因：${info.reason}`,
        '',
        '排查后可重新启动看门狗：node watchdog.js ' + (info.botArgs || []).join(' ')
    ].join('\n');
}

module.exports = {
    sendToAdmins,
    sendMessage,
    formatCrashReport,
    formatRestartFailedReport,
    formatGiveUpReport
};
