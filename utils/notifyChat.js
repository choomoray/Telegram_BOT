// utils/notifyChat.js
/**
 * 运行状态通知的**统一出口**
 *
 * 用户要求：凡是与「启动 / 机器人运行状态」有关的消息，都发到那个专用**话题群**
 * （`.env` 的 `STARTUP_NOTIFY_CHAT_ID` + `STARTUP_NOTIFY_THREAD_ID`，
 * 默认 `-1002223278475` / 话题 `85`，即 `t.me/c/2223278475/85`），不再私聊管理员。
 *
 * 目前的使用者（都在这里取收件会话，别再各自读 ADMIN_CHAT_IDS）：
 *   - `utils/crashNotify.js`：每次启动「🚀 BOT已启动」、崩溃重启「♻️ BOT重启成功」；
 *   - `utils/atlasAccessList.js`：**数据库连不上**、自动维护 Atlas 白名单成功 / 超时 / 失败；
 *   - `utils/linkHealth.js`：搬运收录链接失效清单（notifyAdmins）；
 *   - 看门狗侧（`watchdog/notify.js`）独立读同一组 `.env` 变量，
 *     发「⚠️ BOT出现意外崩溃」/「🛑 停止自动重启」。
 *
 * 未配置（`STARTUP_NOTIFY_CHAT_ID=0`）时**退回私聊管理员**，保证老部署行为不变。
 * 该会话同时被列入「完全不处理」名单（只发通知，不收录、不响应、不管理，见 utils/permissions.isIgnoredChat）。
 */
const logger = require('../logger');

/**
 * 通知收件会话：
 *   配置了 `STARTUP_NOTIFY_CHAT_ID` → 只发那个话题群的指定话题（不再私聊管理员）；
 *   未配置（0）→ 退回管理员私聊。
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

/**
 * 把一条运行状态通知发给所有收件会话（通知群按话题发）。
 * 单个会话发送失败只记日志，不影响其它会话与调用方流程。
 *
 * @param {string} text - 通知正文
 * @param {Object} [opts]
 *   - disablePreview: 关闭链接预览（默认 true）
 *   - label: 失败日志里用的名字（便于排障）
 * @returns {Promise<number>} 成功发送的会话数
 */
async function sendNotify(text, { disablePreview = true, label = '状态通知' } = {}) {
    if (!text) return 0;
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
            logger.warn(`${label}发送失败 chat_id=${chatId}${threadId ? ` thread=${threadId}` : ''}: ${err.message}`);
        }
    }
    return sent;
}

module.exports = {
    notifyTargets,
    nowText,
    sendNotify
};
