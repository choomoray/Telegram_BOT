// utils/inflight.js
/**
 * 进程内登记表：**机器人正在把某个文件发送到 Telegram**（发送中 → 落库完成）
 *
 * 为什么需要它：
 *   1. `/send` 把媒体组发给「频道 + 关联讨论群」时，Telegram 会**立刻**把帖子自动转发到讨论群，
 *      而机器人的发送/落库还没结束 —— 那一刻库里查不到这条媒体，
 *      群组转发兜底（handlers/groupMessageHandlers.js: transferRecordToGroup）就会
 *      "照常收录"，另建一个媒体组。结果是讨论群多出一组 **无描述、可清理** 的影子媒体组
 *      （用户看到的就是"发送时带描述，发到频道后描述没了"）。
 *      有了这张表，转发兜底能知道"这个文件正在被 /send 发送"，
 *      短暂等一下（等落库完成）再查，就不会另建组，而是只补一个群组位置。
 *   2. 同一批文件在发送过程中被重复投递时，`/send` 用同一张表吞掉重复，避免同一文件入库两次。
 *
 * 语义很窄：**只在"正在发送（含落库）"这段窗口内为真**，发送流程一结束（finally）立刻清掉；
 * 「某个文件是否已经收录过」一律以数据库为准，不要用这张表去挡用户重新发送
 * （否则 delete_group 之后重新发送同一批文件会被误判成重复而静默忽略）。
 */

const TTL_MS = 60 * 1000;        // 兜底 TTL：正常路径都会显式清除，这里只防"忘了清"
const files = new Map();          // file_unique_id -> 登记时间戳

/** 登记：这个文件正在发送（含落库阶段） */
function markInFlight(fileUniqueId) {
    if (!fileUniqueId) return;
    files.set(String(fileUniqueId), Date.now());
}

/** 解除登记（发送流程结束时调用） */
function clearInFlight(fileUniqueId) {
    if (!fileUniqueId) return;
    files.delete(String(fileUniqueId));
}

/** 这个文件是不是正在发送中（含落库阶段） */
function isInFlight(fileUniqueId) {
    if (!fileUniqueId) return false;
    const ts = files.get(String(fileUniqueId));
    if (ts === undefined) return false;
    if (Date.now() - ts > TTL_MS) {   // 过期：当作没在发送（防漏清导致永久挡路）
        files.delete(String(fileUniqueId));
        return false;
    }
    return true;
}

/** 当前登记的文件数（日志 / 测试用） */
function inFlightCount() {
    return files.size;
}

/** 清理过期登记（定时兜底） */
function sweepInFlight(now = Date.now()) {
    for (const [key, ts] of files.entries()) {
        if (now - ts > TTL_MS) files.delete(key);
    }
}

module.exports = { markInFlight, clearInFlight, isInFlight, inFlightCount, sweepInFlight, TTL_MS };
