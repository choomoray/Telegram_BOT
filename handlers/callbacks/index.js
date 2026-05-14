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
const selectModelCallback = require('./selectModel');
const toggleThinkingCallback = require('./toggleThinking');
const retryModelCallback = require('./retryModel');
const execCmdCallback = require('./execCmd');
const handleSwitchModelCallback = require('./switchModel');
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
    select_model: selectModelCallback,
    toggle_thinking: toggleThinkingCallback,
    retry_model: retryModelCallback,
    exec_cmd: execCmdCallback,
    switch_model: handleSwitchModelCallback,
    clean_confirm: async (query) => {
        const action = query.data.split(':')[1];
        await handleCleanConfirm(action, query);
    },
    clean_cancel: async (query) => {
        await handleCleanCancel(query);
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

    // 动态分发 pwd_ 前缀 (密码)
    if (data.startsWith('pwd_')) {
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