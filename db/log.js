// db/log.js
/**
 * 操作日志写入（对外保留历史 API）
 *
 * 实现已迁移到 `utils/opLog.js`（schema v2：action/category/date/target/counts/detail/result），
 * 本文件只做两件事：
 *   1. 保留 `LOG_TYPES` 旧编号常量（历史代码/文档引用）
 *   2. `insertLog(type, userId, extra)` 兼容包装（旧编号 → 动作键，extra 进 detail）
 *
 * 新代码请直接使用 `utils/opLog.js` 的 `logOperation`，字段更完整，便于月表/年终统计。
 */
const opLog = require('../utils/opLog');

const LOG_TYPES = {
    BOT_START: 0,
    MEDIA_SAVE: 1,
    MEDIA_EDIT: 2,
    MEDIA_DELETE: 3,
    RANDOM_VIDEO: 11,
    RANDOM_PICTURE: 12,
    MESSAGE_REPLY: 13,
    MEDIA_MERGE: 14,
    MEDIA_HIDE: 15,
    HELP: 16,
    SEARCH: 17,
    CLEAN: 18,
    DELETE_MODE: 19,
    MARK: 20,
    MEDIA_UNHIDE: 21,
    KEYWORD_QUERY: 22,
    EDIT_TEXT: 23,
    SETTING_UPDATE: 24, // 设置更新
    SEND: 25,           // /send 发送
    TAG: 26,            // /tag 标签操作
    WEBUI_LOGIN: 27,    // Web 控制台登录
    WEBUI_DB: 28,       // Web 控制台数据操作
    USER_ADMIN: 29,     // 用户增删改
    USER_BAN: 30,       // 封禁/解封
    USER_WHITELIST: 31, // 白名单
    USER_MEMBER: 32,    // 入群/离群/审批
    CHAT_ADMIN: 33,     // 群组/频道增删改绑定
    ARTICLE: 34,        // 文章
    COLLECTION: 35,     // 合集
    TRANSPORT: 36       // 搬运
};

module.exports = {
    insertLog: opLog.insertLog,
    logOperation: opLog.logOperation,
    LOG_TYPES
};
