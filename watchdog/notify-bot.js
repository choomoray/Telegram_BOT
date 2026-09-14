// watchdog/notify-bot.js
/**
 * 短命通知进程：**只负责把一条消息发给管理员，然后自己结束。**
 *
 * 由 watchdog.js 通过 `spawnNotifier()` 拉起（载荷经 `NOTIFY_PAYLOAD` 环境变量传入，
 * base64(JSON)，避免长文本/中文在命令行里被转义或截断）。
 *
 * 关键约束（用户要求）：
 *   - 与主 bot 完全解耦：主 bot 可能还没起来、或起来后马上又崩，
 *     这条崩溃消息都必须已经发出去；
 *   - **无论发送成功与否，到 ttlMs 就结束**（不会常驻，不会变成第二个轮询实例）；
 *   - 只调 sendMessage（不 getUpdates），因此与主 bot 共用同一个 token 不会冲突。
 *
 * 用法（一般不手动调用）：
 *   NOTIFY_PAYLOAD=<base64> node watchdog/notify-bot.js
 * 退出码：0 = 至少一个管理员收到；1 = 全部失败或载荷错误（看门狗只记日志，不据此重启）
 */
const { sendToAdmins } = require('./notify');

const DEFAULT_TTL_MS = 5000;

function parsePayload() {
    const raw = process.env.NOTIFY_PAYLOAD;
    if (!raw) return null;
    try {
        const json = Buffer.from(raw, 'base64').toString('utf8');
        const data = JSON.parse(json);
        if (!data || typeof data !== 'object') return null;
        return data;
    } catch {
        return null;
    }
}

function log(msg) {
    // 输出到 stdout，由看门狗转发（保持终端现象一致）
    process.stdout.write(`[通知bot] ${msg}\n`);
}

async function main() {
    const payload = parsePayload();
    if (!payload) {
        log('载荷无效，退出');
        process.exit(1);
    }

    const ttlMs = Number(payload.ttlMs) > 0 ? Number(payload.ttlMs) : DEFAULT_TTL_MS;

    // TTL 兜底：到点无条件结束，避免任何异常路径让它变成常驻进程
    const killer = setTimeout(() => {
        log(`到达 TTL（${ttlMs}ms），结束`);
        process.exit(0);
    }, ttlMs);
    if (typeof killer.unref === 'function') killer.unref();

    const cfg = {
        telegramToken: payload.token,
        adminChatIds: Array.isArray(payload.adminChatIds) ? payload.adminChatIds : []
    };

    try {
        const res = await sendToAdmins(cfg, payload.text);
        if (res.sent > 0) {
            log(`已发送给 ${res.sent} 位管理员${res.failed ? `，失败 ${res.failed} 位` : ''}`);
            clearTimeout(killer);
            process.exit(0);
        }
        log(`发送失败：${res.errors.join('；') || '无收件人'}`);
    } catch (err) {
        log(`发送异常：${err.message}`);
    }

    clearTimeout(killer);
    process.exit(1);
}

main();
