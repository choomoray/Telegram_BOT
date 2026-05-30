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
        bot.on('message', async (msg) => {
            if (msg.chat.type === 'private') {
                await handlePrivateMessage(msg);
            } else if (['group', 'supergroup', 'channel'].includes(msg.chat.type)) {
                await handleGroupMessage(msg);
            }
        });

        bot.on('edited_message', async (msg) => {
            if (['group', 'supergroup', 'channel'].includes(msg.chat.type)) {
                await handleGroupEditedMessage(msg);
            }
        });

        bot.on('callback_query', async (query) => {
            await handleCallbackQuery(query);
        });

        // 成员变动事件
        bot.on('chat_member', async (update) => {
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
        });

        // 机器人管理员状态变更
        bot.on('my_chat_member', async (update) => {
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
        });

        // 加入请求审批
        bot.on('chat_join_request', async (update) => {
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
        });

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
    } catch (err) {
        logger.error(`启动失败: ${err.message}`);
        process.exit(1);
    }
}

start();

process.on('SIGINT', async () => {
    const client = getClient();
    if (client) {
        await client.close();
        logger.info('MongoDB 连接已关闭');
    }
    process.exit(0);
});