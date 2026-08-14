// index.js
const logger = require('./logger');
const config = require('./config');
const { connectDB, getClient, getDb } = require('./database');
const { initCollections } = require('./db/index');
const { loadSettings } = require('./db/settings');
const { insertLog } = require('./db/log');
const { addUserToGroup, removeUserFromGroup, updateLastSeen, banUserFully, userOperationLocks } = require('./db/users');
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

// Web UI 服务引用（node index.js webui 时启用）
let webServer = null;

async function start() {
    try {
        // 1. 连接数据库
        await connectDB();
        // 2. 初始化集合索引
        await initCollections().catch(err => {
            logger.error('初始化集合索引失败:', err.message);
        });
        // 3. 加载动态设置
        await loadSettings(config);
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

        // 成员变动事件
        bot.on('chat_member', safeHandler(async (update) => {
            const { chat, new_chat_member } = update;
            if (!new_chat_member || !new_chat_member.user) return;
            const userId = new_chat_member.user.id;
            const userName = new_chat_member.user.username ||
                `${new_chat_member.user.first_name || ''} ${new_chat_member.user.last_name || ''}`.trim() ||
                `User${userId}`;

            if (userOperationLocks.has(userId)) {
                logger.info(`用户 ${userId} 正在被管理员操作，忽略自动成员变动事件`);
                return;
            }

            const newStatus = new_chat_member.status;
            await updateLastSeen(userId).catch(() => { });

            if (['member', 'administrator', 'creator'].includes(newStatus)) {
                const { getCollection, COLLECTIONS } = require('./db/getCollection');
                const usersCol = getCollection(COLLECTIONS.USERS);
                const user = await usersCol.findOne({ id: userId });
                if (user && user.state === 0) {
                    logger.warn(`封禁用户 ${userId} 尝试加入群组 ${chat.id}，立即踢出并全面封禁`);
                    await banUserFully(userId, 'auto').catch(err => logger.error(`踢出封禁用户失败: ${err.message}`));
                    return;
                }
                await addUserToGroup(userId, userName, chat.id);
                logger.info(`用户 ${userId} (${userName}) 加入群组 ${chat.id} (状态: ${newStatus})`);
            } else if (['left', 'kicked'].includes(newStatus)) {
                await removeUserFromGroup(userId, chat.id);
                logger.info(`用户 ${userId} 离开群组 ${chat.id} (状态: ${newStatus})`);
            }
        }));

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
            try {
                const { getCollection, COLLECTIONS } = require('./db/getCollection');
                const usersCol = getCollection(COLLECTIONS.USERS);
                const user = await usersCol.findOne({ id: userId });
                if (!user || user.state === 0) {
                    await bot.declineChatJoinRequest(chatId, userId);
                    logger.info(`自动拒绝加入请求：用户 ${userId} 封禁或不在记录中 (群组 ${chatId})`);
                    return;
                }
                const groupInfo = await getChannelGroupById(chatId);
                if (groupInfo && groupInfo.bind_id) {
                    const userGroups = user.group || [];
                    if (!userGroups.includes(groupInfo.bind_id)) {
                        await bot.declineChatJoinRequest(chatId, userId);
                        logger.info(`自动拒绝加入请求：用户 ${userId} 未加入关联频道 ${groupInfo.bind_id} (群组 ${chatId})`);
                        return;
                    }
                }
                await bot.approveChatJoinRequest(chatId, userId);
                logger.info(`自动批准加入请求：用户 ${userId} 加入群组 ${chatId}`);
            } catch (err) {
                logger.error(`处理加入请求失败: ${err.message}`);
            }
        }));

        // 记录启动日志
        await insertLog(0);

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

        // 可选：启动 Web UI 管理面板（node index.js webui）
        if (process.argv.includes('webui')) {
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
async function gracefulShutdown(signal) {
    logger.info(`收到 ${signal}，正在优雅关闭...`);
    try {
        const bot = require('./bot');
        await bot.stopPolling();
        logger.info('Telegram 轮询已停止');
    } catch (err) {
        logger.warn(`停止轮询失败: ${err.message}`);
    }
    if (webServer) {
        try {
            // 先断开所有 SSE 长连接，否则 server.close() 会永久等待
            const { closeAllSseClients } = require('./webui/server');
            closeAllSseClients();
        } catch (err) {
            logger.warn(`关闭 SSE 连接失败: ${err.message}`);
        }
        // 关闭 HTTP 服务（加 3 秒超时兜底，避免异常连接挂起进程）
        await Promise.race([
            new Promise(resolve => webServer.close(resolve)),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]);
        logger.info('Web UI 服务已关闭');
    }
    const client = getClient();
    if (client) {
        try {
            await client.close();
            logger.info('MongoDB 连接已关闭');
        } catch (err) {
            logger.warn(`关闭 MongoDB 失败: ${err.message}`);
        }
    }
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));