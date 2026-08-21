// handlers/callbacks/index.js
const logger = require('../../logger');
const bot = require('../../bot');
const mediaCallback = require('./mediaCallback');
const directCallback = require('./directCallback');
const directConfirmCallback = require('./directConfirmCallback');
const pageCallback = require('./pageCallback');
const toggleCallback = require('./toggleCallback');
const randomShowCallback = require('./randomShowCallback');
const cleanCallback = require('./cleanCallback');
const cleanContinueCallback = require('./cleanContinueCallback');
const batchContinueCallback = require('./batchContinueCallback');
const editConfirmDbOnly = require('./editConfirmDbOnly');
const execCmdCallback = require('./execCmd');
const { handleMarkMenuCallback, handleMarkRecordCallback, handleMarkRecordSwitchCallback } = require('./markCallback');
const sendMode = require('../modes/sendMode');
const tagMode = require('../modes/tagMode');
const transportMode = require('../modes/transportMode');
const settingMode = require('../modes/settingMode');
const passwordMode = require('../modes/passwordMode');
const { handleCleanConfirm, handleCleanCancel } = cleanCallback;

const callbackHandlers = {
    qmedia: mediaCallback,
    qdirect: directCallback,
    qdirect_confirm: directConfirmCallback,
    qpage: pageCallback,
    qtoggle: toggleCallback,
    rshow: randomShowCallback,
    clean: cleanCallback,
    clean_continue: cleanContinueCallback,
    exec_cmd: execCmdCallback,
    mark_menu: handleMarkMenuCallback,
    markrec: handleMarkRecordCallback,
    markrec_switch: handleMarkRecordSwitchCallback,
    sendg: sendMode.handleCallback,
    sendpage: sendMode.handleCallback,
    sendtag: sendMode.handleTagCallback,
    sendtag_done: sendMode.handleTagCallback,
    tagm: tagMode.handleCallback,
    tagmsg: tagMode.handleCallback,
    tagedit: tagMode.handleCallback,
    edit_dbonly: editConfirmDbOnly,
    edit_dbonly_cancel: async (query) => {
        const userId = query.from.id;
        const { deleteUserState } = require('../../states');
        deleteUserState(userId);
        await bot.editMessageText('⏹ 已取消', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
        }).catch(() => {});
        await bot.answerCallbackQuery(query.id, { text: '已取消' });
    },
    clean_confirm: async (query) => {
        const action = query.data.split(':')[1];
        await handleCleanConfirm(action, query);
    },
    clean_cancel: async (query) => {
        await handleCleanCancel(query);
    },
    qbatch: batchContinueCallback,
    qbatch_stop: async (query) => {
        await bot.answerCallbackQuery(query.id, { text: '⏹ 已停止发送' });
        await bot.editMessageText('⏹ 已停止', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
        }).catch(() => {});
        await bot.sendMessage(query.from.id, '⏹ 已停止发送，如需继续可重新搜索后查看');
    },
    transport: async (query) => {
        await transportMode.handleCallback(query);
    }
};

async function handleCallbackQuery(query) {
    const data = query.data;
    if (!data) {
        try {
            await bot.answerCallbackQuery(query.id);
        } catch (err) {
            logger.warn(`answerCallbackQuery 失败 (无数据): ${err.message}`);
        }
        return;
    }

    // 动态分发 manage 前缀
    if (data.startsWith('manage')) {
        try {
            const manageMode = require('../modes/manage');
            const handled = await manageMode.handleCallback(query);
            if (!handled) {
                await bot.answerCallbackQuery(query.id, { text: '❌ 未知管理操作' });
            }
        } catch (err) {
            logger.error(`处理管理回调 ${data} 时发生错误: ${err.message}`);
            try {
                await bot.answerCallbackQuery(query.id, { text: '❌ 处理失败' });
            } catch (answerErr) {
                logger.warn(`answerCallbackQuery 失败: ${answerErr.message}`);
            }
        }
        return;
    }

    // 动态分发 set_ 前缀 (设置)
    if (data.startsWith('set_')) {
        try {
            await settingMode.handleCallback(query);
        } catch (err) {
            logger.error(`处理设置回调 ${data} 时发生错误: ${err.message}`);
            try {
                await bot.answerCallbackQuery(query.id, { text: '❌ 处理失败' });
            } catch (answerErr) {
                logger.warn(`answerCallbackQuery 失败: ${answerErr.message}`);
            }
        }
        return;
    }

    // 动态分发 password: 前缀 (密码)
    if (data.startsWith('password:')) {
        try {
            await passwordMode.handleCallback(query);
        } catch (err) {
            logger.error(`处理密码回调 ${data} 时发生错误: ${err.message}`);
            try {
                await bot.answerCallbackQuery(query.id, { text: '❌ 处理失败' });
            } catch (answerErr) {
                logger.warn(`answerCallbackQuery 失败: ${answerErr.message}`);
            }
        }
        return;
    }

    // 动态分发 collection: 前缀 (合集)
    if (data.startsWith('collection:')) {
        try {
            const collectionMode = require('../modes/collectionMode');
            const handled = await collectionMode.handleCallback(query);
            if (!handled) {
                await bot.answerCallbackQuery(query.id, { text: '❌ 未知合集操作' });
            }
        } catch (err) {
            logger.error(`处理合集回调 ${data} 时发生错误: ${err.message}`);
            try { await bot.answerCallbackQuery(query.id, { text: '❌ 处理失败' }); } catch (e) {}
        }
        return;
    }

    // 动态分发 article: 前缀 (文章)
    if (data.startsWith('article:')) {
        try {
            const articleMode = require('../modes/articleMode');
            const handled = await articleMode.handleCallback(query);
            if (!handled) {
                await bot.answerCallbackQuery(query.id, { text: '❌ 未知文章操作' });
            }
        } catch (err) {
            logger.error(`处理文章回调 ${data} 时发生错误: ${err.message}`);
            try {
                await bot.answerCallbackQuery(query.id, { text: '❌ 处理失败' });
            } catch (answerErr) {
                logger.warn(`answerCallbackQuery 失败: ${answerErr.message}`);
            }
        }
        return;
    }

    const prefix = data.split(':')[0];
    const handler = callbackHandlers[prefix];
    if (handler) {
        try {
            await handler(query);
        } catch (err) {
            logger.error(`处理回调 ${data} 时发生错误: ${err.message}`);
            try {
                await bot.answerCallbackQuery(query.id, { text: '❌ 处理失败' });
            } catch (answerErr) {
                logger.warn(`answerCallbackQuery 失败: ${answerErr.message}`);
            }
        }
    } else {
        logger.warn(`未处理回调: ${data}`);
        try {
            await bot.answerCallbackQuery(query.id);
        } catch (err) {
            logger.warn(`answerCallbackQuery 失败: ${err.message}`);
        }
    }
}

module.exports = handleCallbackQuery;