// handlers/modes/collectionMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const {
    createCollection, getCollectionsByType, getCollectionById, updateCollection, deleteCollection,
    createSubCollection, getSubCollectionsByCollectionId, getSubCollectionById, updateSubCollection, deleteSubCollection
} = require('../../db/collectionsDb');
const { setUserState, getRawUserState, deleteUserState } = require('../../states');
const { paginationRow, safeEditText } = require('../../utils/reply');
const { escapeHTML } = require('../../utils/sanitize');

const MODE_NAME = 'collection';
const PAGE_SIZE = 50;
const TYPE_LABELS = { collection: '合集', misc: '杂集' };

// ==================== 主菜单 ====================

async function showMainMenu(userId, messageId) {
    const keyboard = {
        inline_keyboard: [
            [{ text: '📚 合集', callback_data: 'collection:list:collection' }],
            [{ text: '📦 杂集', callback_data: 'collection:list:misc' }],
            [{ text: '🚪 退出', callback_data: 'collection:exit' }]
        ]
    };

    setUserState(userId, {
        mode: MODE_NAME, step: 'main', mainMsgId: messageId, lastActivity: Date.now()
    });

    await safeEditText(bot, userId, messageId, '📚 请选择要管理的类型：', { reply_markup: keyboard });
}

// ==================== 合集/杂集 列表 ====================

async function showList(userId, messageId, type, page = 1, viewMode = 'fold') {
    const items = await getCollectionsByType(type);
    const totalPages = Math.ceil(items.length / PAGE_SIZE) || 1;
    const start = (page - 1) * PAGE_SIZE;
    const pageItems = items.slice(start, start + PAGE_SIZE);
    const typeLabel = TYPE_LABELS[type] || type;

    let text = `📋 ${typeLabel}列表（共 ${items.length} 个）：\n`;
    if (pageItems.length === 0) {
        text += '暂无内容';
    } else {
        for (let i = 0; i < pageItems.length; i++) {
            const idx = start + i + 1;
            text += `${idx}. ${escapeHTML(pageItems[i].name)}\n`;
        }
    }

    const keyboard = [];

    // 展开模式才显示编号按钮矩阵
    if (viewMode === 'number' && pageItems.length > 0) {
        for (let i = 0; i < pageItems.length; i += 5) {
            const row = [];
            for (let j = i; j < i + 5 && j < pageItems.length; j++) {
                row.push({
                    text: String(start + j + 1),
                    callback_data: `collection:item:${type}:${pageItems[j].id}`
                });
            }
            keyboard.push(row);
        }
    }

    // 翻页行 + 折叠切换
    if (totalPages > 1) {
        const navRow = paginationRow(page, totalPages, (p) => `collection:list_page:${type}:${p}`, `collection:toggle:${type}:${page}`);
        keyboard.push(navRow);
    } else if (pageItems.length > 0 && viewMode === 'fold') {
        // 只有一页时默认展开
        return showList(userId, messageId, type, page, 'number');
    }

    keyboard.push([
        { text: '➕ 添加', callback_data: `collection:add:${type}` },
        { text: '🔙 返回', callback_data: 'collection:menu' }
    ]);

    setUserState(userId, {
        mode: MODE_NAME, step: 'list', listType: type, page, viewMode,
        mainMsgId: messageId, lastActivity: Date.now()
    });

    await safeEditText(bot, userId, messageId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ==================== 子合集列表 ====================

async function showSubList(userId, messageId, type, collectionId, page = 1, viewMode = 'fold') {
    const parent = await getCollectionById(collectionId);
    if (!parent) { await safeEditText(bot, userId, messageId, '❌ 不存在'); return; }

    const subs = await getSubCollectionsByCollectionId(collectionId);
    const totalPages = Math.ceil(subs.length / PAGE_SIZE) || 1;
    const start = (page - 1) * PAGE_SIZE;
    const pageItems = subs.slice(start, start + PAGE_SIZE);

    let text = `📌 ${escapeHTML(parent.name)}\n\n📎 子合集（${subs.length} 个）：\n`;
    if (pageItems.length === 0) {
        text += '暂无子合集';
    } else {
        for (let i = 0; i < pageItems.length; i++) {
            const idx = start + i + 1;
            text += `${idx}. <a href="${escapeHTML(pageItems[i].link)}">${escapeHTML(pageItems[i].name)}</a>\n`;
        }
    }

    const keyboard = [];

    if (viewMode === 'number' && pageItems.length > 0) {
        for (let i = 0; i < pageItems.length; i += 5) {
            const row = [];
            for (let j = i; j < i + 5 && j < pageItems.length; j++) {
                row.push({
                    text: String(start + j + 1),
                    callback_data: `collection:sub_item:${type}:${collectionId}:${pageItems[j].id}`
                });
            }
            keyboard.push(row);
        }
    }

    if (totalPages > 1) {
        const navRow = paginationRow(page, totalPages,
            (p) => `collection:item_page:${type}:${collectionId}:${p}`,
            `collection:item_toggle:${type}:${collectionId}:${page}`
        );
        keyboard.push(navRow);
    } else if (pageItems.length > 0 && viewMode === 'fold') {
        return showSubList(userId, messageId, type, collectionId, page, 'number');
    }

    keyboard.push([
        { text: '➕ 添加子合集', callback_data: `collection:add_sub:${type}:${collectionId}` },
        { text: '✏️ 修改', callback_data: `collection:edit:${type}:${collectionId}` }
    ]);
    keyboard.push([{ text: '🔙 返回列表', callback_data: `collection:list:${type}` }]);

    setUserState(userId, {
        mode: MODE_NAME, step: 'sub_list', listType: type, collectionId, page, viewMode,
        mainMsgId: messageId, lastActivity: Date.now()
    });

    await safeEditText(bot, userId, messageId, text, {
        reply_markup: { inline_keyboard: keyboard }, parse_mode: 'HTML', disable_web_page_preview: true
    });
}

// ==================== 修改菜单 ====================

async function showEditMenu(userId, messageId, type, collectionId) {
    const item = await getCollectionById(collectionId);
    if (!item) { await safeEditText(bot, userId, messageId, '❌ 不存在'); return; }

    const keyboard = {
        inline_keyboard: [
            [{ text: '✏️ 修改名称', callback_data: `collection:edit_name:${type}:${item.id}` }],
            [{ text: '🗑️ 删除', callback_data: `collection:delete:${type}:${item.id}` }],
            [{ text: '🔙 返回', callback_data: `collection:item:${type}:${item.id}` }]
        ]
    };

    await safeEditText(bot, userId, messageId, `✏️ 修改：${item.name}`, { reply_markup: keyboard });
}

// ==================== 子合集编辑 ====================

async function showSubEdit(userId, messageId, type, collectionId, subId) {
    const sub = await getSubCollectionById(subId);
    if (!sub) { await safeEditText(bot, userId, messageId, '❌ 不存在'); return; }

    const text = `📄 <a href="${escapeHTML(sub.link)}">${escapeHTML(sub.name)}</a>`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '✏️ 修改名称', callback_data: `collection:sub_edit_name:${type}:${collectionId}:${sub.id}` }],
            [{ text: '🔗 修改链接', callback_data: `collection:sub_edit_link:${type}:${collectionId}:${sub.id}` }],
            [{ text: '🗑️ 删除', callback_data: `collection:sub_delete:${type}:${collectionId}:${sub.id}` }],
            [{ text: '🔙 返回', callback_data: `collection:item:${type}:${collectionId}` }]
        ]
    };

    setUserState(userId, {
        mode: MODE_NAME, step: 'sub_edit', listType: type, collectionId, subId: sub.id,
        mainMsgId: messageId, lastActivity: Date.now()
    });

    await safeEditText(bot, userId, messageId, text, {
        reply_markup: keyboard, parse_mode: 'HTML', disable_web_page_preview: true
    });
}

// ==================== 发送新消息 ====================

async function sendNew(chatId, text, keyboard) {
    return await bot.sendMessage(chatId, text, {
        reply_markup: keyboard || { inline_keyboard: [] },
        parse_mode: 'HTML', disable_web_page_preview: true
    });
}

// ==================== Callback 处理 ====================

async function handleCallback(query) {
    const data = query.data;
    const userId = query.from.id;
    const messageId = query.message.message_id;
    const chatId = query.message.chat.id;
    const state = getRawUserState(userId);
    if (!state || state.mode !== MODE_NAME) return false;

    const parts = data.split(':');

    // 主菜单
    if (data === 'collection:menu') {
        await showMainMenu(userId, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'collection:exit') {
        deleteUserState(userId);
        await safeEditText(bot, userId, messageId, '✅ 已退出合集模式');
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 按类型查看列表
    if (data.startsWith('collection:list:')) {
        const type = parts[2];
        await showList(userId, messageId, type, 1);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 列表翻页
    if (data.startsWith('collection:list_page:')) {
        const type = parts[2];
        const page = parseInt(parts[3]);
        await showList(userId, messageId, type, page, state.viewMode || 'fold');
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 折叠切换
    if (data.startsWith('collection:toggle:')) {
        const type = parts[2];
        const page = parseInt(parts[3]);
        const newView = (state.viewMode === 'number' || state.step === 'list_number') ? 'fold' : 'number';
        await showList(userId, messageId, type, page, newView);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 查看子合集列表
    if (data.startsWith('collection:item:')) {
        const type = parts[2];
        const cid = parts[3];
        await showSubList(userId, messageId, type, cid, 1);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 子合集翻页
    if (data.startsWith('collection:item_page:')) {
        const type = parts[2];
        const cid = parts[3];
        const page = parseInt(parts[4]);
        await showSubList(userId, messageId, type, cid, page, state.viewMode || 'fold');
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 子合集折叠切换
    if (data.startsWith('collection:item_toggle:')) {
        const type = parts[2];
        const cid = parts[3];
        const page = parseInt(parts[4]);
        const newView = (state.viewMode === 'number') ? 'fold' : 'number';
        await showSubList(userId, messageId, type, cid, page, newView);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 添加合集/杂集
    if (data.startsWith('collection:add:')) {
        const type = parts[2];
        const sent = await sendNew(chatId, `📝 请输入${TYPE_LABELS[type] || type}名称：`);
        setUserState(userId, { ...state, step: 'waiting_name', addType: type, inputMsgId: sent.message_id, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 添加子合集
    if (data.startsWith('collection:add_sub:')) {
        const type = parts[2];
        const cid = parseInt(parts[3]);
        const sent = await sendNew(chatId, '📝 请输入子合集名称：');
        setUserState(userId, { ...state, step: 'waiting_sub_name', listType: type, collectionId: cid, inputMsgId: sent.message_id, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 修改菜单
    if (data.startsWith('collection:edit:')) {
        const type = parts[2];
        const cid = parts[3];
        await showEditMenu(userId, messageId, type, cid);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 修改名称
    if (data.startsWith('collection:edit_name:')) {
        const type = parts[2];
        const cid = parseInt(parts[3]);
        const sent = await sendNew(chatId, '✏️ 请输入新名称：');
        setUserState(userId, { ...state, step: 'waiting_edit_name', addType: type, collectionId: cid, inputMsgId: sent.message_id, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 删除确认
    if (data.startsWith('collection:delete:')) {
        const type = parts[2];
        const cid = parseInt(parts[3]);
        const item = await getCollectionById(cid);
        if (!item) { await bot.answerCallbackQuery(query.id, { text: '❌ 不存在' }); return true; }
        const keyboard = { inline_keyboard: [[
            { text: '✅ 确认删除', callback_data: `collection:delete_confirm:${type}:${cid}` },
            { text: '❌ 取消', callback_data: `collection:item:${type}:${cid}` }
        ]]};
        await sendNew(chatId, `⚠️ 确定要删除「${escapeHTML(item.name)}」及其所有子合集吗？`, keyboard);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('collection:delete_confirm:')) {
        const cid = parseInt(parts[3]);
        await deleteCollection(cid);
        await sendNew(chatId, '✅ 已删除');
        await bot.answerCallbackQuery(query.id, { text: '已删除' });
        return true;
    }

    // 查看子合集（直接显示编辑按钮）
    if (data.startsWith('collection:sub_item:')) {
        const type = parts[2];
        const cid = parts[3];
        const sid = parts[4];
        await showSubEdit(userId, messageId, type, cid, sid);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 修改子合集名称
    if (data.startsWith('collection:sub_edit_name:')) {
        const type = parts[2];
        const cid = parseInt(parts[3]);
        const sid = parseInt(parts[4]);
        const sent = await sendNew(chatId, '✏️ 请输入新名称：');
        setUserState(userId, { ...state, step: 'waiting_sub_edit_name', addType: type, collectionId: cid, subId: sid, inputMsgId: sent.message_id, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 修改子合集链接
    if (data.startsWith('collection:sub_edit_link:')) {
        const cid = parseInt(parts[3]);
        const sid = parseInt(parts[4]);
        const sent = await sendNew(chatId, '🔗 请输入新链接：');
        setUserState(userId, { ...state, step: 'waiting_sub_edit_link', collectionId: cid, subId: sid, inputMsgId: sent.message_id, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 删除子合集确认
    if (data.startsWith('collection:sub_delete:')) {
        const type = parts[2];
        const cid = parseInt(parts[3]);
        const sid = parseInt(parts[4]);
        const sub = await getSubCollectionById(sid);
        if (!sub) { await bot.answerCallbackQuery(query.id, { text: '❌ 不存在' }); return true; }
        const keyboard = { inline_keyboard: [[
            { text: '✅ 确认删除', callback_data: `collection:sub_delete_confirm:${type}:${cid}:${sid}` },
            { text: '❌ 取消', callback_data: `collection:sub_item:${type}:${cid}:${sid}` }
        ]]};
        await sendNew(chatId, `⚠️ 确定要删除子合集「${escapeHTML(sub.name)}」吗？`, keyboard);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('collection:sub_delete_confirm:')) {
        const sid = parseInt(parts[4]);
        await deleteSubCollection(sid);
        await sendNew(chatId, '✅ 子合集已删除');
        await bot.answerCallbackQuery(query.id, { text: '已删除' });
        return true;
    }

    return false;
}

// ==================== 文本消息处理 ====================

async function handleCollectionMessage(msg, state) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text;
    const mainMsgId = state.mainMsgId;

    // 等待输入合集名称
    if (state.step === 'waiting_name') {
        if (!text) return true;
        await createCollection({ name: text, type: state.addType });
        const typeLabel = TYPE_LABELS[state.addType] || state.addType;
        await sendNew(chatId, `✅ ${typeLabel}已创建：${escapeHTML(text)}`);
        const newMenu = await bot.sendMessage(chatId, '⏳');
        await showList(userId, newMenu.message_id, state.addType);
        return true;
    }

    // 等待输入子合集名称
    if (state.step === 'waiting_sub_name') {
        if (!text) return true;
        setUserState(userId, { ...state, step: 'waiting_sub_link', subName: text, lastActivity: Date.now() });
        await sendNew(chatId, `📝 名称：${escapeHTML(text)}\n\n请输入链接：`);
        return true;
    }

    // 等待输入子合集链接
    if (state.step === 'waiting_sub_link') {
        if (!text) return true;
        await createSubCollection({ collection_id: state.collectionId, name: state.subName, link: text });
        await sendNew(chatId, '✅ 子合集已创建');
        const newMenu = await bot.sendMessage(chatId, '⏳');
        await showSubList(userId, newMenu.message_id, state.listType, state.collectionId);
        return true;
    }

    // 等待修改合集名称
    if (state.step === 'waiting_edit_name') {
        if (!text) return true;
        await updateCollection(state.collectionId, { name: text });
        await sendNew(chatId, `✅ 名称已更新：${escapeHTML(text)}`);
        const newMenu = await bot.sendMessage(chatId, '⏳');
        await showSubList(userId, newMenu.message_id, state.addType, state.collectionId);
        return true;
    }

    // 等待修改子合集名称
    if (state.step === 'waiting_sub_edit_name') {
        if (!text) return true;
        await updateSubCollection(state.subId, { name: text });
        await sendNew(chatId, `✅ 名称已更新：${escapeHTML(text)}`);
        const newMenu = await bot.sendMessage(chatId, '⏳');
        await showSubEdit(userId, newMenu.message_id, state.addType, state.collectionId, state.subId);
        return true;
    }

    // 等待修改子合集链接
    if (state.step === 'waiting_sub_edit_link') {
        if (!text) return true;
        await updateSubCollection(state.subId, { link: text });
        await sendNew(chatId, '✅ 链接已更新');
        const newMenu = await bot.sendMessage(chatId, '⏳');
        await showSubEdit(userId, newMenu.message_id, state.addType, state.collectionId, state.subId);
        return true;
    }

    return false;
}

module.exports = {
    handleCallback,
    handleCollectionMessage,
    showMainMenu
};
