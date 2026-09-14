// utils/transportCheck.js
/**
 * 搬运收录链接活性巡检（**按需触发**）
 *
 * 触发时机（用户要求：不再随 bot 启动自动跑）：
 *   1. 用户执行 `/transport` 指令；
 *   2. WebUI 进入「搬运收录」视图。
 *
 * 内置节流与并发去重：
 *   - 距上次检查不足 MIN_INTERVAL 时直接跳过（除非 force），避免频繁点按钮把
 *     Telegram 打到限流；
 *   - 同一时刻只跑一次，重复调用复用同一个 Promise。
 */
const logger = require('../logger');
const { logOperation } = require('./opLog');

/** 最短检查间隔（10 分钟） */
const MIN_INTERVAL = 10 * 60 * 1000;

let inFlight = null;
let lastCheckedAt = 0;

/** 上次检查时间（0 = 从未检查过） */
function getLastCheckedAt() {
    return lastCheckedAt;
}

/** 是否处于节流窗口内 */
function isThrottled(now = Date.now()) {
    return !!lastCheckedAt && now - lastCheckedAt < MIN_INTERVAL;
}

/**
 * 按需检查链接活性
 *
 * 注意：结果**不发 Telegram 通知**。失效链接请在 WebUI 控制台「搬运」页编辑或删除；
 * 这里只写日志 + opLog。
 *
 * @param {Object} [opts]
 *   - force: true 忽略节流，强制重新检查
 * @returns {Promise<Object|null>} 检查摘要；被节流跳过时返回 null
 */
async function checkTransportOnDemand(opts = {}) {
    const { force = false } = opts;

    if (inFlight) return inFlight;
    if (!force && isThrottled()) return null;

    inFlight = (async () => {
        try {
            const { checkAllTransports } = require('./linkHealth');
            const summary = await checkAllTransports({ force: true, concurrency: 3 });
            lastCheckedAt = Date.now();

            // 注意：**不向管理员发 Telegram 消息**。
            // 失效链接请到 WebUI 控制台「搬运」页编辑或删除（那里有完整列表与操作按钮），
            // 这里只写日志 + 记一条 opLog，便于在控制台排查历史。
            if (summary.newlyDead.length) {
                logger.warn(`搬运收录巡检：新失效 ${summary.newlyDead.length} 条（请在 WebUI 控制台「搬运」页编辑或删除）`);
                logOperation({
                    action: 'transport_check',
                    source: 'system',
                    result: 'fail',
                    target: { type: 'collection', id: 'transport' },
                    counts: { chats: summary.newlyDead.length },
                    detail: {
                        total: summary.total,
                        ok: summary.ok,
                        dead: summary.dead.length,
                        unknown: summary.unknown.length,
                        newlyDead: summary.newlyDead.map(d => d.chat_name || d.chat_id)
                    }
                }).catch(() => { });
            } else {
                logger.info(`搬运收录巡检：共 ${summary.total} 条，有效 ${summary.ok}，失效 ${summary.dead.length}，未知 ${summary.unknown.length}`);
            }
            if (summary.dead.length) {
                logger.warn(`搬运收录巡检：当前共 ${summary.dead.length} 条失效链接，请在 WebUI 控制台「搬运」页处理`);
            }
            if (summary.recovered.length) {
                logger.success(`搬运收录巡检：${summary.recovered.length} 条链接已恢复可访问`);
            }
            return summary;
        } catch (err) {
            logger.error(`搬运收录巡检失败: ${err.message}`);
            return null;
        } finally {
            inFlight = null;
        }
    })();

    return inFlight;
}

/** 仅测试用：重置内部状态 */
function _resetForTest() {
    inFlight = null;
    lastCheckedAt = 0;
}

module.exports = { checkTransportOnDemand, isThrottled, getLastCheckedAt, MIN_INTERVAL, _resetForTest };
