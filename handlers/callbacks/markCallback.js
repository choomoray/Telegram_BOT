// handlers/callbacks/markCallback.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { getMarkedGroups } = require('../../db/groupList');
const { createSession, getSession, getPageResults } = require('../../utils/queryCache');
const { deleteUserState, updateUserActivity } = require('../../states');
const { insertLog } = require('../../db/log');
const {
    sortMarkRecords,
    formatMarkRecords,
    buildMarkRecordsKeyboard,
    PAGE_SIZE
} = require('../../utils/markFormatter');

/**
 * 获取标记记录（group_list.mark > 0 的组，关联 message 集合取代表消息）
 */
async function getMarkRecords() {
    const groups = await getMarkedGroups();
    if (!groups.length) return [];

    const groupIds = groups.map(g => g.group_id);
    const messageCol = getCollection(COLLECTIONS.MESSAGE);
    const messages = await messageCol.find({ group_id: { $in: groupIds } }).toArray();
    const msgByGroup = new Map();
    for (const m of messages) {
        if (!msgByGroup.has(m.group_id)) msgByGroup.set(m.group_id, m);
    }

    return groups.map(g => {
        const msg = msgByGroup.get(g.group_id);
        return {
            group_id: g.group_id,
            mark: g.mark || 0,
            last_mark_time: g.last_mark_time || null,
            text: msg ? (msg.text || '') : '',
            chat_id: msg ? msg.chat_id : null,
            message_id: msg ? msg.message_id : null,
            media_type: msg ? msg.media_type : null,
            level: msg ? msg.level : null
        };
    });
}

/**
 * 显示标记记录（首次打开或翻页/切换后统一入口）
 */
async function showMarkRecords(query, chatId, messageId, sessionId, page) {
    let session;
    if (sessionId) {
        session = getSession(sessionId);
        if (!session) {
            await bot.editMessageText('⚠️ 记录会话已过期，请重新发送 /mark 打开标记记录', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }
    } else {
        // 首次打开：查询并缓存
        const records = await getMarkRecords();
        if (!records.length) {
            await bot.editMessageText('📊 暂无标记记录', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }
        sessionId = createSession(query.from.id, '标记记录', sortMarkRecords(records, 'count'), records.length, '', { pageSize: PAGE_SIZE });
        session = getSession(sessionId);
        session.allRecords = records;       // 原始记录（用于切换排序）
        session.sortMode = 'count';         // 默认按标记次数
    }

    const { pageResults, totalPages, currentPage } = getPageResults(sessionId, page || 1);
    const text = formatMarkRecords(pageResults, session.results.length, currentPage, totalPages, PAGE_SIZE, session.sortMode);
    const keyboard = buildMarkRecordsKeyboard(sessionId, currentPage, totalPages, session.sortMode);

    await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
}

/**
 * 标记模式菜单回调（mark_menu:start | mark_menu:records | mark_menu:exit）
 */
async function handleMarkMenuCallback(query) {
    const data = query.data;
    const action = data.split(':')[1];
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    switch (action) {
        case 'start': {
            updateUserActivity(userId);
            await bot.editMessageText('✅ 开始标记\n请发送要标记的媒体（支持媒体组，仅处理第一条媒体）。', {
                chat_id: chatId,
                message_id: messageId
            });
            await bot.answerCallbackQuery(query.id, { text: '开始标记' });
            insertLog(20, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
            logger.info(`用户 ${userId} 通过菜单开始标记`);
            break;
        }
        case 'records': {
            await bot.answerCallbackQuery(query.id, { text: '加载标记记录...' });
            logger.info(`用户 ${userId} 查看标记记录`);
            await showMarkRecords(query, chatId, messageId, null, 1);
            break;
        }
        case 'exit': {
            deleteUserState(userId);
            await bot.editMessageText('🚪 已退出标记模式', {
                chat_id: chatId,
                message_id: messageId
            });
            await bot.answerCallbackQuery(query.id, { text: '已退出' });
            logger.info(`用户 ${userId} 通过菜单退出标记模式`);
            break;
        }
        default: {
            await bot.answerCallbackQuery(query.id, { text: '❌ 无效操作' });
        }
    }
}

/**
 * 标记记录翻页回调（markrec:sessionId:page）
 */
async function handleMarkRecordCallback(query) {
    const parts = query.data.split(':');
    const sessionId = parts[1];
    const page = parseInt(parts[2], 10) || 1;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    try {
        await bot.answerCallbackQuery(query.id);
        await showMarkRecords(query, chatId, messageId, sessionId, page);
    } catch (err) {
        logger.error(`标记记录翻页失败: ${err.message}`);
    }
}

/**
 * 标记记录排序切换回调（markrec_switch:sessionId）
 */
async function handleMarkRecordSwitchCallback(query) {
    const sessionId = query.data.split(':')[1];
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    try {
        const session = getSession(sessionId);
        if (!session) {
            await bot.answerCallbackQuery(query.id, { text: '⚠️ 会话已过期' });
            await bot.editMessageText('⚠️ 记录会话已过期，请重新发送 /mark 打开标记记录', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }
        session.sortMode = session.sortMode === 'count' ? 'time' : 'count';
        session.results = sortMarkRecords(session.allRecords || session.results, session.sortMode);
        await bot.answerCallbackQuery(query.id, {
            text: session.sortMode === 'count' ? '按标记次数排序' : '按最后标记时间排序'
        });
        logger.info(`用户 ${query.from.id} 切换标记记录排序: ${session.sortMode}`);
        await showMarkRecords(query, chatId, messageId, sessionId, 1);
    } catch (err) {
        logger.error(`标记记录排序切换失败: ${err.message}`);
    }
}

module.exports = {
    handleMarkMenuCallback,
    handleMarkRecordCallback,
    handleMarkRecordSwitchCallback,
    getMarkRecords
};
