// index.js
const logger = require('./logger');
const config = require('./config');
const { connectDB, getClient, getDb } = require('./database');
const { initCollections } = require('./db/index');
const { loadSettings } = require('./db/settings');
const { logOperation } = require('./utils/opLog');
const { upsertChannelGroup, getChannelGroupById } = require('./db/channelGroup');
const { startHealthServer } = require('./healthServer');

// 全局异常兜底：防止单个事件处理器的漏网错误导致整个进程崩溃
process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝:', reason instanceof Error ? (reason.stack || reason.message) : reason);
});
process.on('uncaughtException', (err) => {
    logger.error('未捕获异常（进程继续运行）:', err.stack || err.message);
});

/**
 * 包装事件处理器，确保异步监听器中的异常不会成为未处理拒绝
 */
function safeHandler(fn) {
    return async (...args) => {
        try {
            await fn(...args);
        } catch (err) {
            logger.error(`事件处理异常: ${err.stack || err.message}`);
        }
    };
}

// Web UI 服务引用（node index.js webui / node index.js test 时启用）
let webServer = null;

// 搬运收录链接活性巡检：启动 1 分钟后首查，之后每 6 小时一次；新失效的链接提醒管理员
const TRANSPORT_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const TRANSPORT_CHECK_FIRST_DELAY = 60 * 1000;

function startTransportHealthCheck() {
    const run = async () => {
        try {
            const { checkAllTransports, formatDeadReport, notifyAdmins } = require('./utils/linkHealth');
            const summary = await checkAllTransports({ force: true, concurrency: 3 });
            if (summary.newlyDead.length) {
                const sent = await notifyAdmins(formatDeadReport(summary.newlyDead));
                logger.warn(`搬运收录巡检：新失效 ${summary.newlyDead.length} 条，已提醒 ${sent} 位管理员`);
                logOperation({
                    action: 'transport_check',
                    source: 'system',
                    result: 'fail',
                    target: { type: 'collection', id: 'transport' },
                    counts: { chats: summary.newlyDead.length },
                    detail: {
                        total: summary.total, ok: summary.ok, dead: summary.dead.length,
                        unknown: summary.unknown.length, newlyDead: summary.newlyDead.map(d => d.chat_name || d.chat_id),
                        notified: sent
                    }
                }).catch(() => { });
            } else {
                logger.info(`搬运收录巡检：共 ${summary.total} 条，有效 ${summary.ok}，失效 ${summary.dead.length}，未知 ${summary.unknown.length}`);
            }
            if (summary.recovered.length) logger.success(`搬运收录巡检：${summary.recovered.length} 条链接已恢复可访问`);
        } catch (err) {
            logger.error(`搬运收录巡检失败: ${err.message}`);
        }
    };
    const first = setTimeout(() => {
        run();
        const timer = setInterval(run, TRANSPORT_CHECK_INTERVAL);
        if (typeof timer.unref === 'function') timer.unref();
    }, TRANSPORT_CHECK_FIRST_DELAY);
    if (typeof first.unref === 'function') first.unref();
}

// test 模式（node index test）：在 webui 基础上，日志额外复制一份到 test-log（启动时重置）
const TEST_MODE = process.argv.includes('test');

/**
 * 管理员在 Telegram 侧解除封禁（频道/群「已移除用户 / 黑名单」里移除某个用户）的处理逻辑
 * 见 handlers/chatMemberHandler.js: syncManualUnban()。
 */

async function start() {
    try {
        // 1. 连接数据库
        await connectDB();
        // 2. 初始化集合索引
        await initCollections().catch(err => {
            logger.error('初始化集合索引失败:', err.message);
        });
        // 2.5 迁移旧标签数据（settings.tags -> 独立 tags 集合）
        const { migrateTagsFromSettings } = require('./db/tags');
        await migrateTagsFromSettings().catch(err => logger.error(`标签迁移失败: ${err.message}`));
        // 2.6 清理未标记媒体组的 last_mark_time 空字段（该字段只在 /mark 标记时写入）
        const { cleanupNullMarkTime } = require('./db/groupList');
        await cleanupNullMarkTime().catch(err => logger.error(`清理 last_mark_time 失败: ${err.message}`));
        // 2.7 清理 media 里与 group / channel 位置重复的顶层 message_id（位置以子文档为唯一权威）
        const { cleanupDuplicateMediaMessageId } = require('./db/media');
        await cleanupDuplicateMediaMessageId().catch(err => logger.error(`清理 media 顶层 message_id 失败: ${err.message}`));
        // 3. 加载动态设置
        await loadSettings(config);
        // test 模式：初始化临时日志（重置 test-log/log.log、error.log，仅启动时初始化）
        if (TEST_MODE) {
            await logger.initTestLog().catch(err => logger.warn(`初始化 test 日志失败: ${err.message}`));
        }
        logger.success('数据库连接成功，设置已加载，正在启动 Telegram Bot...');

        // 4. 启动机器人
        const bot = require('./bot');
        bot.startBotPolling();
        const { handlePrivateMessage } = require('./handlers/messageHandlers');
        const { handleGroupMessage, handleGroupEditedMessage } = require('./handlers/groupMessageHandlers');
        const { handleCallbackQuery } = require('./handlers/callbackHandler');

        // 消息事件（合并为一个监听器）
        bot.on('message', safeHandler(async (msg) => {
            if (msg.chat.type === 'private') {
                await handlePrivateMessage(msg);
            } else if (['group', 'supergroup', 'channel'].includes(msg.chat.type)) {
                await handleGroupMessage(msg);
            }
        }));

        bot.on('edited_message', safeHandler(async (msg) => {
            if (['group', 'supergroup', 'channel'].includes(msg.chat.type)) {
                await handleGroupEditedMessage(msg);
            }
        }));

        bot.on('callback_query', safeHandler(async (query) => {
            await handleCallbackQuery(query);
        }));

        // 成员变动事件（成员进出 / 管理员解封；逻辑见 handlers/chatMemberHandler.js）
        const { handleChatMemberUpdate } = require('./handlers/chatMemberHandler');
        bot.on('chat_member', safeHandler(handleChatMemberUpdate));

        // 机器人管理员状态变更
        bot.on('my_chat_member', safeHandler(async (update) => {
            const { chat, new_chat_member } = update;
            if (new_chat_member.status === 'administrator') {
                const exists = await getChannelGroupById(chat.id);
                if (!exists) {
                    await upsertChannelGroup({
                        id: chat.id,
                        name: chat.title || chat.username || `Chat${chat.id}`,
                        type: chat.type === 'channel' ? 'channel' : 'group',
                        bind_id: null,
                        is_bound: false
                    });
                    logger.info(`机器人成为管理员，自动添加群组: ${chat.id} (${chat.title})`);
                }
            }
        }));

        // 加入请求审批
        bot.on('chat_join_request', safeHandler(async (update) => {
            const { chat, from } = update;
            const userId = from.id;
            const chatId = chat.id;
            const userName = from.username || `${from.first_name || ''} ${from.last_name || ''}`.trim() || `User${userId}`;
            const logRequest = (decision, reason) => logOperation({
                action: 'user_join_request',
                source: 'system',
                userId,
                chatId,
                target: { type: 'user', id: userId },
                counts: { users: 1 },
                detail: { decision, reason, userName, chatName: chat.title || chat.username || undefined }
            }).catch(() => { });
            try {
                const { getCollection, COLLECTIONS } = require('./db/getCollection');
                const usersCol = getCollection(COLLECTIONS.USERS);
                const user = await usersCol.findOne({ id: userId });
                if (!user || user.state === 0) {
                    await bot.declineChatJoinRequest(chatId, userId);
                    logger.info(`自动拒绝加入请求：用户 ${userId} 封禁或不在记录中 (群组 ${chatId})`);
                    await logRequest('decline', user ? 'banned' : 'unknown_user');
                    return;
                }
                const groupInfo = await getChannelGroupById(chatId);
                if (groupInfo && groupInfo.bind_id) {
                    const userGroups = user.group || [];
                    if (!userGroups.includes(groupInfo.bind_id)) {
                        await bot.declineChatJoinRequest(chatId, userId);
                        logger.info(`自动拒绝加入请求：用户 ${userId} 未加入关联频道 ${groupInfo.bind_id} (群组 ${chatId})`);
                        await logRequest('decline', 'not_in_bound_channel');
                        return;
                    }
                }
                await bot.approveChatJoinRequest(chatId, userId);
                logger.info(`自动批准加入请求：用户 ${userId} 加入群组 ${chatId}`);
                await logRequest('approve', 'allowed');
            } catch (err) {
                logger.error(`处理加入请求失败: ${err.message}`);
                await logOperation({
                    action: 'user_join_request',
                    result: 'fail',
                    source: 'system',
                    userId,
                    chatId,
                    target: { type: 'user', id: userId },
                    detail: { userName },
                    error: err.message
                }).catch(() => { });
            }
        }));

        // 记录启动日志（schema v2：带版本/数据库/模式，便于年终统计与排障）
        await logOperation({
            action: 'bot_start',
            source: 'system',
            detail: {
                version: require('./package.json').version,
                dbName: require('./database').getDatabaseName(),
                mode: process.argv.includes('test') ? 'test' : (process.argv.includes('webui') ? 'webui' : 'normal'),
                node: process.version
            }
        }).catch(() => { });

        // 启动健康检查 HTTP 服务
        startHealthServer(9699, async () => {
            try {
                await getDb().admin().ping();
                return 'connected';
            } catch {
                return 'disconnected';
            }
        });

        logger.success('系统就绪，Telegram Bot 已启动并等待消息...');

        // 搬运收录链接活性巡检（失效提醒管理员）
        startTransportHealthCheck();

        // 可选：启动 Web UI 管理面板（node index.js webui / node index.js test）
        if (process.argv.includes('webui') || TEST_MODE) {
            const { startWebUI } = require('./webui/server');
            webServer = startWebUI();
        }
    } catch (err) {
        logger.error(`启动失败: ${err.message}`);
        process.exit(1);
    }
}

start();

// 优雅关闭：停止轮询 → 关闭 Web UI → 关闭数据库连接 → 退出
// 每一步都带超时兜底，另有 12 秒总超时强制退出，保证任何环节卡住进程都能结束
async function gracefulShutdown(signal) {
    logger.info(`收到 ${signal}，正在优雅关闭...`);

    // 总超时兜底：优雅关闭超过 12 秒仍未完成则强制退出
    const forceExitTimer = setTimeout(() => {
        logger.error('优雅关闭超时（12s），强制退出');
        process.exit(1);
    }, 12000);

    const withTimeout = (promise, ms) => Promise.race([
        promise,
        new Promise(resolve => setTimeout(resolve, ms))
    ]);

    try {
        // 0. 关闭前立即清理：删除定时删除消息 + 遗留提示消息（收到关闭信号时立即执行，不等定时器）
        try {
            const { cleanupOnShutdown } = require('./handlers/shutdownCleanup');
            await cleanupOnShutdown();
        } catch (err) {
            logger.warn(`关闭前清理失败: ${err.message}`);
        }

        // 1. 停止 Telegram 轮询（最多等待 5 秒）
        try {
            const bot = require('./bot');
            await withTimeout(bot.stopPolling(), 5000);
            logger.info('Telegram 轮询已停止');
        } catch (err) {
            logger.warn(`停止轮询失败: ${err.message}`);
        }

        // 2. 关闭 Web UI（先断开 SSE 长连接，再关 HTTP 服务，最多等待 3 秒）
        if (webServer) {
            try {
                // 先断开所有 SSE 长连接，否则 server.close() 会永久等待
                const { closeAllSseClients } = require('./webui/server');
                closeAllSseClients();
            } catch (err) {
                logger.warn(`关闭 SSE 连接失败: ${err.message}`);
            }
            await withTimeout(new Promise(resolve => webServer.close(resolve)), 3000);
            logger.info('Web UI 服务已关闭');
        }

        // 关闭日志必须在断开数据库之前写入（否则连不上库，日志会丢）
        await logOperation({
            action: 'bot_stop',
            source: 'system',
            detail: { signal, uptimeSec: Math.round(process.uptime()) }
        }).catch(() => { });

        // 3. 关闭 MongoDB 连接（最多等待 3 秒）
        const client = getClient();
        if (client) {
            try {
                await withTimeout(client.close(), 3000);
                logger.info('MongoDB 连接已关闭');
            } catch (err) {
                logger.warn(`关闭 MongoDB 失败: ${err.message}`);
            }
        }

        // 4. 日志队列刷盘：放在最后，等待所有待写日志（含上述清理日志）落盘后再退出
        try {
            const { flushLogs } = require('./logger');
            await withTimeout(flushLogs(), 3000);
        } catch (err) {
            console.error(`日志刷盘失败: ${err.message}`);
        }
    } finally {
        clearTimeout(forceExitTimer);
    }

    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));