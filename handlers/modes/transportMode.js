// handlers/modes/transportMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getRawUserState, setUserState, deleteUserState } = require('../../states');
const { escapeHTML } = require('../../utils/sanitize');
const {
    getAllTransports,
    upsertTransport,
    deleteTransport,
    extractChatInfo
} = require('../../db/transport');

async function sendWithBackButton(userId, text, replyToMessageId = null, backData = 'transport:back') {
    const keyboard = { inline_keyboard: [[{ text: '🔙 返回', callback_data: backData }]] };
    return await bot.sendMessage(userId, text, {
        reply_to_message_id: replyToMessageId,
        reply_markup: keyboard,
        disable_web_page_preview: true
    });
}

function buildMainKeyboard() {
    return { inline_keyboard: [[{ text: '🔄 更新', callback_data: 'transport:update' }], [{ text: '📋 管理', callback_data: 'transport:manage' }]] };
}

function buildManageKeyboard(transports) {
    const keyboard = [[{ text: '➕ 添加', callback_data: 'transport:add' }]];
    const rows = [];
    for (let i = 0; i < transports.length; i++) {
        const btn = { text: `${i + 1}`, callback_data: `transport:item:${i + 1}` };
        const rowIndex = Math.floor(i / 5);
        if (!rows[rowIndex]) rows[rowIndex] = [];
        rows[rowIndex].push(btn);
    }
    keyboard.push(...rows);
    keyboard.push([{ text: '🔙 返回', callback_data: 'transport:back' }]);
    return { inline_keyboard: keyboard };
}

function buildItemEditInterface(item, index) {
    const text = `📌 项目 ${index}\n名称：${escapeHTML(item.chat_name)}\nID：<code>${item.chat_id}</code>\n链接：<a href="${item.url}">${item.url}</a>\n更新次数：${item.num || 0}`;
    const keyboard = {
        inline_keyboard: [
            [{ text: '✏️ 编辑名字', callback_data: `transport:edit_name:${index}` }],
            [{ text: '🆔 编辑ID', callback_data: `transport:edit_id:${index}` }],
            [{ text: '🗑️ 删除', callback_data: `transport:delete:${index}` }],
            [{ text: '🔙 返回', callback_data: 'transport:back' }]
        ]
    };
    return { text, keyboard };
}

async function showTransportList(userId, editMessageId = null, replyToMessageId = null) {
    const transports = await getAllTransports();
    let text = '📊 下面是搬运列表\n';
    if (transports.length === 0) text += '暂无记录';
    else {
        for (let i = 0; i < transports.length; i++) {
            const item = transports[i];
            const number = (i + 1).toString().padStart(2, '0');
            text += `<a href="${item.url}">${number} ${escapeHTML(item.chat_name)}</a>\n`;
        }
    }
    const keyboard = buildMainKeyboard();
    const options = { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true };
    if (editMessageId) {
        try {
            await bot.editMessageText(text, { chat_id: userId, message_id: editMessageId, ...options });
        } catch (err) {
            if (err.response?.body?.description === 'Bad Request: message is not modified') return;
            logger.error(`编辑主界面失败: ${err.message}`);
            const sent = await bot.sendMessage(userId, text, { reply_to_message_id: replyToMessageId, ...options });
            return sent;
        }
        return null;
    } else {
        return await bot.sendMessage(userId, text, { reply_to_message_id: replyToMessageId, ...options });
    }
}

async function handleUpdate(userId, msgId) {
    const state = getRawUserState(userId);
    if (!state) return;
    setUserState(userId, { ...state, step: 'waiting_url', lastActivity: Date.now() });
    await bot.editMessageText('♻️ 请输入需要更新的链接（支持公开链接、邀请链接或频道ID）', {
        chat_id: userId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 返回', callback_data: 'transport:back' }]] },
        disable_web_page_preview: true
    });
}

async function handleAdd(userId, msgId) {
    const state = getRawUserState(userId);
    if (!state) return;
    setUserState(userId, { ...state, step: 'waiting_url', lastActivity: Date.now() });
    await bot.editMessageText('➕ 请发送群组/频道的链接', {
        chat_id: userId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 返回', callback_data: 'transport:back' }]] },
        disable_web_page_preview: true
    });
}

async function processUrl(userId, url, state, originalMsg) {
    try {
        const chatInfo = await extractChatInfo(url, bot);
        const transports = await getAllTransports();
        const existing = transports.find(t => t.chat_id === chatInfo.chat_id);
        if (existing) {
            // 已存在：直接更新链接并增加计数
            await upsertTransport({
                chat_id: chatInfo.chat_id,
                chat_name: existing.chat_name,
                url: url
            });
            await sendWithBackButton(userId, `✅ 频道：${existing.chat_name} 更新成功！`, originalMsg.message_id);
            await showTransportList(userId, state.mainMsgId);
            setUserState(userId, { ...state, step: 'main', lastActivity: Date.now() });
        } else {
            // 新频道
            let promptText = `✅ 已识别：${chatInfo.chat_name}`;
            if (!chatInfo.is_verified) {
                promptText = `⚠️ 无法自动获取频道名称，请手动输入名称：`;
            } else {
                promptText += `\n请输入自定义名称（/skip 使用原名称）：`;
            }
            setUserState(userId, {
                ...state,
                step: 'waiting_name',
                pendingChatId: chatInfo.chat_id,
                pendingChatName: chatInfo.chat_name,
                pendingUrl: url,
                lastActivity: Date.now()
            });
            await sendWithBackButton(userId, promptText, originalMsg.message_id);
        }
    } catch (err) {
        logger.error(`识别链接失败: ${err.message}`);
        await sendWithBackButton(userId, `❌ 识别失败：${err.message}`, originalMsg.message_id);
        setUserState(userId, { ...state, step: 'main', lastActivity: Date.now() });
    }
}

async function processName(userId, name, state, originalMsg) {
    const { pendingChatId, pendingChatName, pendingUrl } = state;
    const finalName = (name === '/skip' || !name) ? pendingChatName : name;
    try {
        await upsertTransport({ chat_id: pendingChatId, chat_name: finalName, url: pendingUrl });
        await sendWithBackButton(userId, `✅ 已添加：${finalName}`, originalMsg.message_id);
        await showTransportList(userId, state.mainMsgId);
        setUserState(userId, { ...state, step: 'main', lastActivity: Date.now() });
    } catch (err) {
        logger.error(`添加失败: ${err.message}`);
        await sendWithBackButton(userId, `❌ 添加失败：${err.message}`, originalMsg.message_id);
        setUserState(userId, { ...state, step: 'main', lastActivity: Date.now() });
    }
}

async function showManageInterface(userId, msgId, state) {
    const transports = await getAllTransports();
    let text = '📋 请选择要管理的项目（按更新次数排序）：\n';
    if (transports.length === 0) text = '暂无记录\n';
    else {
        for (let i = 0; i < transports.length; i++) {
            const item = transports[i];
            const number = (i + 1).toString().padStart(2, '0');
            text += `<a href="${item.url}">${number} ${escapeHTML(item.chat_name)}</a>\n`;
        }
    }
    const keyboard = buildManageKeyboard(transports);
    await bot.editMessageText(text, {
        chat_id: userId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: keyboard, disable_web_page_preview: true
    });
    setUserState(userId, { ...state, step: 'manage', mainMsgId: state.mainMsgId, lastActivity: Date.now() });
}

async function handleItemSelect(userId, msgId, index, state, query) {
    await bot.answerCallbackQuery(query.id, { text: '加载中...' });
    const transports = await getAllTransports();
    if (index < 1 || index > transports.length) {
        await bot.answerCallbackQuery(query.id, { text: '无效序号' });
        return;
    }
    const item = transports[index - 1];
    const { text, keyboard } = buildItemEditInterface(item, index);
    await bot.editMessageText(text, {
        chat_id: userId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: keyboard, disable_web_page_preview: true
    });
    setUserState(userId, { ...state, step: 'editing_item', editingIndex: index, editingItem: item, mainMsgId: state.mainMsgId, lastActivity: Date.now() });
}

async function handleEditName(userId, msgId, index, state, query) {
    await bot.answerCallbackQuery(query.id, { text: '编辑名字' });
    const transports = await getAllTransports();
    if (index < 1 || index > transports.length) return;
    const item = transports[index - 1];
    setUserState(userId, { ...state, step: 'waiting_name_edit', editingIndex: index, lastActivity: Date.now() });
    await bot.editMessageText(`✏️ 当前名字：${item.chat_name}\n请输入新的名字：`, {
        chat_id: userId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 返回', callback_data: 'transport:back' }]] },
        disable_web_page_preview: true
    });
}

async function handleEditId(userId, msgId, index, state, query) {
    await bot.answerCallbackQuery(query.id, { text: '编辑ID' });
    const transports = await getAllTransports();
    if (index < 1 || index > transports.length) return;
    const item = transports[index - 1];
    setUserState(userId, { ...state, step: 'waiting_id_edit', editingIndex: index, lastActivity: Date.now() });
    await bot.editMessageText(`🆔 当前ID：${item.chat_id}\n请输入新的 chat_id（数字）：`, {
        chat_id: userId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 返回', callback_data: 'transport:back' }]] },
        disable_web_page_preview: true
    });
}

async function handleDelete(userId, msgId, index, state, query) {
    await bot.answerCallbackQuery(query.id, { text: '正在删除...' });
    const transports = await getAllTransports();
    if (index < 1 || index > transports.length) return;
    const item = transports[index - 1];
    await deleteTransport(item.chat_id);
    await showManageInterface(userId, msgId, state);
}

async function handleCallback(query) {
    const data = query.data;
    const userId = query.from.id;
    const messageId = query.message.message_id;
    const state = getRawUserState(userId);
    if (!state || state.mode !== 'transport') return false;

    if (data === 'transport:update') {
        await bot.answerCallbackQuery(query.id);
        await handleUpdate(userId, messageId);
        return true;
    }
    if (data === 'transport:manage') {
        await bot.answerCallbackQuery(query.id);
        await showManageInterface(userId, messageId, state);
        return true;
    }
    if (data === 'transport:add') {
        await bot.answerCallbackQuery(query.id);
        await handleAdd(userId, messageId);
        return true;
    }
    if (data === 'transport:back') {
        await bot.answerCallbackQuery(query.id);
        await showTransportList(userId, messageId);
        setUserState(userId, { mode: 'transport', step: 'main', mainMsgId: messageId, lastActivity: Date.now() });
        return true;
    }
    if (data.startsWith('transport:item:')) {
        const index = parseInt(data.split(':')[2]);
        await handleItemSelect(userId, messageId, index, state, query);
        return true;
    }
    if (data.startsWith('transport:edit_name:')) {
        const index = parseInt(data.split(':')[2]);
        await handleEditName(userId, messageId, index, state, query);
        return true;
    }
    if (data.startsWith('transport:edit_id:')) {
        const index = parseInt(data.split(':')[2]);
        await handleEditId(userId, messageId, index, state, query);
        return true;
    }
    if (data.startsWith('transport:delete:')) {
        const index = parseInt(data.split(':')[2]);
        await handleDelete(userId, messageId, index, state, query);
        return true;
    }
    return false;
}

async function handleTransportMessage(msg, state) {
    const userId = msg.from.id;
    const text = msg.text;
    if (!text) return true;

    if (state.step === 'waiting_url') {
        if (text === '/skip') {
            await showTransportList(userId, state.mainMsgId);
            setUserState(userId, { ...state, step: 'main', lastActivity: Date.now() });
            await bot.sendMessage(userId, '✅ 已取消操作', { reply_to_message_id: msg.message_id });
            return true;
        }
        await processUrl(userId, text, state, msg);
        return true;
    }
    if (state.step === 'waiting_name') {
        await processName(userId, text, state, msg);
        return true;
    }
    if (state.step === 'waiting_name_edit') {
        const { editingIndex, mainMsgId } = state;
        const transports = await getAllTransports();
        if (editingIndex < 1 || editingIndex > transports.length) return true;
        const item = transports[editingIndex - 1];
        await upsertTransport({ chat_id: item.chat_id, chat_name: text, url: item.url });
        await sendWithBackButton(userId, `✅ 已更新名称为：${text}`, msg.message_id);
        try {
            await showTransportList(userId, mainMsgId);
        } catch (err) {
            if (err.response?.body?.description !== 'Bad Request: message is not modified') logger.error(`刷新主界面失败: ${err.message}`);
        }
        setUserState(userId, { ...state, step: 'main', editingIndex: null, editingItem: null, lastActivity: Date.now() });
        return true;
    }
    if (state.step === 'waiting_id_edit') {
        const { editingIndex, mainMsgId } = state;
        const newId = parseInt(text);
        if (isNaN(newId)) {
            await bot.sendMessage(userId, '❌ 请输入有效的数字ID', { reply_to_message_id: msg.message_id });
            return true;
        }
        const transports = await getAllTransports();
        if (editingIndex < 1 || editingIndex > transports.length) return true;
        const item = transports[editingIndex - 1];
        await deleteTransport(item.chat_id);
        await upsertTransport({ chat_id: newId, chat_name: item.chat_name, url: item.url });
        await sendWithBackButton(userId, `✅ 已更新 chat_id 为：${newId}`, msg.message_id);
        try {
            await showTransportList(userId, mainMsgId);
        } catch (err) {
            if (err.response?.body?.description !== 'Bad Request: message is not modified') logger.error(`刷新主界面失败: ${err.message}`);
        }
        setUserState(userId, { ...state, step: 'main', editingIndex: null, editingItem: null, lastActivity: Date.now() });
        return true;
    }
    return true;
}

module.exports = { showTransportList, handleCallback, handleTransportMessage };