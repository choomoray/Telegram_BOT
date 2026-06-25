// handlers/modes/settingMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getSettings, updateSetting } = require('../../db/settings');
const { getRawUserState, setUserState, deleteUserState } = require('../../states');
const { insertLog } = require('../../db/log');
const { paginationRow } = require('../../utils/reply');

const TIME_OPTIONS = [
    { label: '全部时长', value: 'all' },
    { label: '< 1分钟', value: '<1min' },
    { label: '< 3分钟', value: '<3min' },
    { label: '1 - 5分钟', value: '1-5min' },
    { label: '3 - 10分钟', value: '3-10min' },
    { label: '5 - 30分钟', value: '5-30min' },
    { label: '> 30分钟', value: '>30min' },
    { label: '> 1小时', value: '>1h' }
];

const SETTINGS = [
    {
        key: 'search_level', type: 'bool', label: '搜索等级排序',
        getValue: async () => {
            const s = await getSettings();
            return s.search_level === 1 ? '开启' : '关闭';
        },
        update: async (val) => {
            await updateSetting({}, 'search_level', val === '1' ? 1 : 0);
        }
    },
    {
        key: 'search_random', type: 'bool', label: '搜索随机排序',
        getValue: async () => {
            const s = await getSettings();
            return s.search_random === 1 ? '开启' : '关闭';
        },
        update: async (val) => {
            await updateSetting({}, 'search_random', val === '1' ? 1 : 0);
        }
    },
    {
        key: 'random_pictures', type: 'bool', label: '随机图片源',
        getValue: async () => {
            const s = await getSettings();
            return s.random_pictures === 1 ? 'media库' : 'message库';
        },
        update: async (val) => {
            await updateSetting({}, 'random_pictures', val === '1' ? 1 : 0);
        }
    },
    {
        key: 'random_pictures_num', type: 'number', label: '随机图片数',
        getValue: async () => {
            const s = await getSettings();
            return s.random_pictures_num.toString();
        },
        update: async (val) => {
            let num = parseInt(val);
            if (isNaN(num)) num = 9;
            if (num < 1) num = 1;
            if (num > 10) num = 10;
            await updateSetting({}, 'random_pictures_num', num);
        }
    },
    {
        key: 'random_videos', type: 'enum', label: '随机视频模式',
        options: [
            { label: '文字模式', value: '0' },
            { label: '视频模式', value: '1' }
        ],
        getValue: async () => {
            const s = await getSettings();
            return s.random_videos === 1 ? '视频模式' : '文字模式';
        },
        update: async (val) => {
            await updateSetting({}, 'random_videos', val === '1' ? 1 : 0);
        }
    },
    {
        key: 'random_videos_time', type: 'enum', label: '随机视频时长',
        options: TIME_OPTIONS,
        getValue: async () => {
            const s = await getSettings();
            const current = s.random_videos_time || '<1min';
            const opt = TIME_OPTIONS.find(o => o.value === current);
            return opt ? opt.label : '< 1分钟';
        },
        update: async (val) => {
            await updateSetting({}, 'random_videos_time', val);
        }
    },
    {
        key: 'random_videos_num_text', type: 'number', label: '文字模式视频数量',
        getValue: async () => {
            const s = await getSettings();
            return s.random_videos_num_text.toString();
        },
        update: async (val) => {
            let num = parseInt(val);
            if (isNaN(num)) num = 15;
            if (num < 10) num = 10;
            if (num > 50) num = 50;
            await updateSetting({}, 'random_videos_num_text', num);
        }
    },
    {
        key: 'random_videos_num_video', type: 'number', label: '视频模式视频数量',
        getValue: async () => {
            const s = await getSettings();
            return s.random_videos_num_video.toString();
        },
        update: async (val) => {
            let num = parseInt(val);
            if (isNaN(num)) num = 10;
            if (num < 1) num = 1;
            if (num > 10) num = 10;
            await updateSetting({}, 'random_videos_num_video', num);
        }
    },
    {
        key: 'STREAM_OUTPUT', type: 'bool', label: 'AI流式输出',
        getValue: async () => {
            const s = await getSettings();
            return s.STREAM_OUTPUT ? '开启' : '关闭';
        },
        update: async (val) => {
            await updateSetting({}, 'STREAM_OUTPUT', val === '1');
        }
    },
    {
        key: 'STREAM_UPDATE_INTERVAL', type: 'number', label: '流式输出间隔',
        getValue: async () => {
            const s = await getSettings();
            return s.STREAM_UPDATE_INTERVAL.toString();
        },
        update: async (val) => {
            let num = parseInt(val);
            if (isNaN(num)) num = 500;
            if (num < 100) num = 100;
            if (num > 500) num = 500;
            await updateSetting({}, 'STREAM_UPDATE_INTERVAL', num);
        }
    },
    {
        key: 'media_group_num', type: 'number', label: '媒体组合并每组数量',
        getValue: async () => {
            const s = await getSettings();
            return s.media_group_num.toString();
        },
        update: async (val) => {
            let num = parseInt(val);
            if (isNaN(num)) num = 10;
            if (num < 1) num = 1;
            if (num > 10) num = 10;
            await updateSetting({}, 'media_group_num', num);
        }
    },
];

const ITEMS_PER_PAGE = 20;

async function getSettingsList() {
    const list = [];
    for (const setting of SETTINGS) {
        const value = await setting.getValue();
        list.push({
            key: setting.key,
            label: setting.label,
            value: value,
            type: setting.type,
            update: setting.update,
            options: setting.options
        });
    }
    return list;
}

async function showSettings(userId, page, editMessageId = null) {
    const list = await getSettingsList();
    const totalPages = Math.ceil(list.length / ITEMS_PER_PAGE);
    const start = (page - 1) * ITEMS_PER_PAGE;
    const pageItems = list.slice(start, start + ITEMS_PER_PAGE);

    const keyboard = [];
    for (let i = 0; i < pageItems.length; i += 2) {
        const row = [];
        const item1 = pageItems[i];
        if (item1) {
            row.push({ text: `${item1.label}：${item1.value}`, callback_data: `set_edit:${item1.key}` });
        }
        const item2 = pageItems[i + 1];
        if (item2) {
            row.push({ text: `${item2.label}：${item2.value}`, callback_data: `set_edit:${item2.key}` });
        }
        keyboard.push(row);
    }

    if (totalPages > 1) {
        keyboard.push(paginationRow(page, totalPages, (p) => `set_page:${p}`));
    }

    keyboard.push([{ text: '🚪 退出设置', callback_data: 'set_exit' }]);

    const text = `⚙️ 可配置信息如下：`;
    if (editMessageId) {
        try {
            await bot.editMessageText(text, {
                chat_id: userId,
                message_id: editMessageId,
                reply_markup: { inline_keyboard: keyboard }
            });
            const state = getRawUserState(userId);
            if (state && state.mode === 'setting') {
                setUserState(userId, { ...state, mainMsgId: editMessageId });
            }
        } catch (err) {
            if (err.response && err.response.body && err.response.body.description === 'Bad Request: message is not modified') {
                return;
            }
            logger.error(`编辑设置面板失败: ${err.message}`);
            const sent = await bot.sendMessage(userId, text, { reply_markup: { inline_keyboard: keyboard } });
            const state = getRawUserState(userId);
            if (state && state.mode === 'setting') {
                setUserState(userId, { ...state, mainMsgId: sent.message_id });
            }
            return sent;
        }
    } else {
        const sent = await bot.sendMessage(userId, text, { reply_markup: { inline_keyboard: keyboard } });
        const state = getRawUserState(userId);
        if (state && state.mode === 'setting') {
            setUserState(userId, { ...state, mainMsgId: sent.message_id });
        }
        return sent;
    }
}

async function refreshSettings(userId, state) {
    await showSettings(userId, state.page || 1, state.mainMsgId);
}

async function enterEdit(userId, settingKey, replyToMsgId) {
    const list = await getSettingsList();
    const setting = list.find(s => s.key === settingKey);
    if (!setting) return;

    let editText = '';
    let keyboard = {};

    if (setting.type === 'bool') {
        editText = `🔧 编辑 ${setting.label}：当前值 ${setting.value}\n请选择新值：`;
        let btn1Text, btn2Text;
        if (setting.key === 'random_pictures') {
            btn1Text = 'message数据库';
            btn2Text = 'media数据库';
        } else {
            btn1Text = '开启';
            btn2Text = '关闭';
        }
        keyboard = {
            inline_keyboard: [
                [
                    { text: btn1Text, callback_data: `set_confirm:${settingKey}:0` },
                    { text: btn2Text, callback_data: `set_confirm:${settingKey}:1` }
                ],
                [{ text: '🔙 返回', callback_data: 'set_back' }]
            ]
        };
        await bot.editMessageText(editText, {
            chat_id: userId,
            message_id: replyToMsgId,
            reply_markup: keyboard
        });
    } else if (setting.type === 'enum') {
        editText = `🔧 编辑 ${setting.label}：当前值 ${setting.value}\n请选择新值：`;
        const buttons = setting.options.map(opt => ({
            text: opt.label,
            callback_data: `set_confirm:${settingKey}:${opt.value}`
        }));
        const rows = [];
        for (let i = 0; i < buttons.length; i += 2) {
            rows.push(buttons.slice(i, i + 2));
        }
        rows.push([{ text: '🔙 返回', callback_data: 'set_back' }]);
        keyboard = { inline_keyboard: rows };
        await bot.editMessageText(editText, {
            chat_id: userId,
            message_id: replyToMsgId,
            reply_markup: keyboard
        });
    } else if (setting.type === 'number') {
        editText = `🔧 编辑 ${setting.label}：当前值 ${setting.value}\n请输入新值（数字）：`;
        keyboard = {
            inline_keyboard: [
                [{ text: '🔙 返回', callback_data: 'set_back' }]
            ]
        };
        await bot.editMessageText(editText, {
            chat_id: userId,
            message_id: replyToMsgId,
            reply_markup: keyboard
        });
        const state = getRawUserState(userId);
        if (state && state.mode === 'setting') {
            setUserState(userId, {
                ...state,
                step: 'editing',
                editingKey: settingKey,
                mainMsgId: replyToMsgId
            });
        }
        return;
    }

    const state = getRawUserState(userId);
    if (state && state.mode === 'setting') {
        setUserState(userId, {
            ...state,
            step: 'editing',
            editingKey: settingKey,
            mainMsgId: replyToMsgId
        });
    }
}

async function handleNumberInput(userId, text, state) {
    const editingKey = state.editingKey;
    const list = await getSettingsList();
    const setting = list.find(s => s.key === editingKey);
    if (!setting) return false;

    let num = parseFloat(text);
    if (isNaN(num)) {
        await bot.sendMessage(userId, '❌ 请输入有效的数字。');
        return true;
    }
    try {
        await setting.update(num.toString());
        insertLog(24, userId, { setting: editingKey, value: num }).catch(err => logger.error(`记录日志失败: ${err.message}`));

        const keyboard = {
            inline_keyboard: [[{ text: '🔙 返回设置', callback_data: 'set_back' }]]
        };
        await bot.sendMessage(userId, `✅ ${setting.label} 已更新为 ${num}`, {
            reply_markup: keyboard
        });

        const newState = getRawUserState(userId);
        if (newState && newState.mode === 'setting') {
            setUserState(userId, {
                ...newState,
                step: 'main',
                editingKey: null,
                lastActivity: Date.now()
            });
        }
        return true;
    } catch (err) {
        logger.error(`更新设置失败: ${err.message}`);
        await bot.sendMessage(userId, '❌ 更新失败，请稍后重试。');
        return true;
    }
}

async function handleCallback(query) {
    const data = query.data;
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    const state = getRawUserState(userId);
    if (!state || state.mode !== 'setting') return false;

    if (data.startsWith('set_page:')) {
        const page = parseInt(data.split(':')[1]);
        if (isNaN(page)) return false;
        setUserState(userId, { ...state, page, lastActivity: Date.now() });
        await showSettings(userId, page, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'set_exit') {
        await bot.sendMessage(userId, '✅ 已退出设置');
        await bot.editMessageText('⚙️ 设置已关闭', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] }
        }).catch(() => { });
        deleteUserState(userId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data === 'set_back') {
        setUserState(userId, { ...state, step: 'main', editingKey: null, lastActivity: Date.now() });
        await showSettings(userId, state.page || 1, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('set_edit:')) {
        const key = data.split(':')[1];
        await enterEdit(userId, key, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }
    if (data.startsWith('set_confirm:')) {
        const parts = data.split(':');
        const key = parts[1];
        const val = parts[2];
        const list = await getSettingsList();
        const setting = list.find(s => s.key === key);
        if (!setting) {
            await bot.answerCallbackQuery(query.id, { text: '❌ 无效设置' });
            return true;
        }
        try {
            if (setting.type === 'bool' || setting.type === 'enum') {
                await setting.update(val);
                insertLog(24, userId, { setting: key, value: val }).catch(err => logger.error(`记录日志失败: ${err.message}`));
                const keyboard = {
                    inline_keyboard: [[{ text: '🔙 返回设置', callback_data: 'set_back' }]]
                };
                let displayValue = val;
                if (setting.type === 'enum' && setting.options) {
                    const opt = setting.options.find(o => o.value === val);
                    if (opt) displayValue = opt.label;
                } else if (key === 'random_pictures') {
                    displayValue = val === '1' ? 'media库' : 'message库';
                } else if (setting.type === 'bool') {
                    displayValue = val === '1' ? '开启' : '关闭';
                }
                await bot.sendMessage(userId, `✅ ${setting.label} 已更新为 ${displayValue}`, {
                    reply_markup: keyboard
                });
                setUserState(userId, { ...state, step: 'main', editingKey: null, lastActivity: Date.now() });
                await bot.answerCallbackQuery(query.id, { text: '✅ 设置已更新' });
            } else {
                await bot.answerCallbackQuery(query.id, { text: '❌ 不支持的类型' });
            }
        } catch (err) {
            logger.error(`更新设置失败: ${err.message}`);
            await bot.answerCallbackQuery(query.id, { text: '❌ 更新失败' });
        }
        return true;
    }
    return false;
}

async function handleSettingMessage(msg, state) {
    if (state.step === 'editing') {
        const text = msg.text;
        if (!text) return true;
        await handleNumberInput(msg.from.id, text, state);
        return true;
    }
    return false;
}

module.exports = {
    showSettings,
    refreshSettings,
    handleCallback,
    handleSettingMessage
};