// handlers/modes/articleMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');
const { getSettings } = require('../../db/settings');
const {
    createArticle, getAllArticles, getArticleById, updateArticle, deleteArticle,
    createSubArticle, getSubArticlesByArticleId, getSubArticleById, updateSubArticle, deleteSubArticle
} = require('../../db/articles');
const { setUserState, getRawUserState, deleteUserState } = require('../../states');
const { paginationRow, safeEditText } = require('../../utils/reply');
const { escapeHTML } = require('../../utils/sanitize');

const MODE_NAME = 'article';
const PAGE_SIZE = 20;
const SUB_PER_PAGE = 50;

// ==================== 主菜单 ====================

async function showMainMenu(userId, messageId) {
    const sort = (await getSettings()).article_sort || 'recent';
    const articles = await getAllArticles(sort);
    const recent = articles.slice(0, 5);

    let text = '📄 最近修改的文章：\n';
    if (recent.length === 0) {
        text += '（暂无文章）\n\n';
    } else {
        for (let i = 0; i < recent.length; i++) {
            text += `${i + 1}. <a href="${escapeHTML(recent[i].link)}">${escapeHTML(recent[i].title)}</a>\n`;
        }
        text += '\n';
    }

    const keyboard = {
        inline_keyboard: [
            [{ text: '✏️ 写文章', url: 'https://telegra.ph/' }],
            [{ text: '📋 管理文章', callback_data: 'article:list' }],
            [{ text: '🚪 退出', callback_data: 'article:exit' }]
        ]
    };

    setUserState(userId, {
        mode: MODE_NAME, step: 'main', mainMsgId: messageId, lastActivity: Date.now()
    });

    await safeEditText(bot, userId, messageId, text, {
        reply_markup: keyboard, parse_mode: 'HTML', disable_web_page_preview: true
    });
}

// ==================== 文章列表 ====================

async function showArticleList(userId, messageId, page = 1, viewMode = 'fold') {
    const sort = (await getSettings()).article_sort || 'recent';
    const articles = await getAllArticles(sort);
    const totalPages = Math.ceil(articles.length / PAGE_SIZE) || 1;
    const start = (page - 1) * PAGE_SIZE;
    const pageItems = articles.slice(start, start + PAGE_SIZE);

    let text = `📋 文章列表（共 ${articles.length} 篇）：\n`;
    if (pageItems.length === 0) {
        text += '暂无文章';
    } else {
        for (let i = 0; i < pageItems.length; i++) {
            const idx = start + i + 1;
            text += `${idx}. <a href="${escapeHTML(pageItems[i].link)}">${escapeHTML(pageItems[i].title)}</a>\n`;
        }
    }

    const keyboard = [];
    if (viewMode === 'number' && pageItems.length > 0) {
        for (let i = 0; i < pageItems.length; i += 5) {
            const row = [];
            for (let j = i; j < i + 5 && j < pageItems.length; j++) {
                row.push({
                    text: String(start + j + 1),
                    callback_data: `article:item:${pageItems[j].id}`
                });
            }
            keyboard.push(row);
        }
    }

    if (totalPages > 1) {
        keyboard.push(paginationRow(page, totalPages, (p) => `article:list_page:${p}`, `article:toggle:${page}`));
    } else if (pageItems.length > 0 && viewMode === 'fold') {
        return showArticleList(userId, messageId, page, 'number');
    }

    keyboard.push([
        { text: '➕ 新建文章', callback_data: 'article:new' },
        { text: '🔙 返回', callback_data: 'article:menu' }
    ]);

    setUserState(userId, {
        mode: MODE_NAME, step: viewMode === 'number' ? 'list_number' : 'list', page, viewMode, mainMsgId: messageId, lastActivity: Date.now()
    });

    await safeEditText(bot, userId, messageId, text, {
        reply_markup: { inline_keyboard: keyboard }, parse_mode: 'HTML', disable_web_page_preview: true
    });
}

// ==================== 文章详情 ====================

async function showArticleDetail(userId, messageId, articleId) {
    const article = await getArticleById(parseInt(articleId));
    if (!article) {
        await safeEditText(bot, userId, messageId, '❌ 文章不存在');
        return;
    }

    const sort = (await getSettings()).sub_article_sort || 'time_desc';
    const subArticles = await getSubArticlesByArticleId(article.id, sort);
    const totalSubs = subArticles.length;
    const subTotalPages = Math.ceil(totalSubs / SUB_PER_PAGE) || 1;
    const firstSubs = subArticles.slice(0, SUB_PER_PAGE);

    let text = `📌 <a href="${escapeHTML(article.link)}">${escapeHTML(article.title)}</a>\n\n`;
    text += `📎 子文章（${totalSubs} 个）：\n`;
    if (firstSubs.length === 0) {
        text += '（暂无子文章）';
    } else {
        for (let i = 0; i < firstSubs.length; i++) {
            text += `${i + 1}. <a href="${escapeHTML(firstSubs[i].link)}">${escapeHTML(firstSubs[i].title)}</a>\n`;
        }
    }

    const keyboard = [];
    if (firstSubs.length > 0) {
        for (let i = 0; i < firstSubs.length; i += 5) {
            const row = [];
            for (let j = i; j < i + 5 && j < firstSubs.length; j++) {
                row.push({
                    text: String(i + j + 1),
                    callback_data: `article:sub_item:${article.id}:${firstSubs[j].id}`
                });
            }
            keyboard.push(row);
        }
        if (subTotalPages > 1) {
            keyboard.push(paginationRow(1, subTotalPages, (p) => `article:item_page:${article.id}:${p}`));
        }
    }
    keyboard.push([
        { text: '➕ 添加子文章', callback_data: `article:add_sub:${article.id}` },
        { text: '✏️ 修改', callback_data: `article:edit:${article.id}` }
    ]);
    keyboard.push([{ text: '🔙 返回列表', callback_data: 'article:back' }]);

    setUserState(userId, {
        mode: MODE_NAME, step: 'detail', articleId: article.id, subPage: 1,
        mainMsgId: messageId, lastActivity: Date.now()
    });

    await safeEditText(bot, userId, messageId, text, {
        reply_markup: { inline_keyboard: keyboard }, parse_mode: 'HTML', disable_web_page_preview: true
    });
}

// ==================== 文章详情（子文章翻页） ====================

async function showArticleDetailPage(userId, messageId, articleId, page) {
    const article = await getArticleById(parseInt(articleId));
    if (!article) { await safeEditText(bot, userId, messageId, '❌ 文章不存在'); return; }

    const sort = (await getSettings()).sub_article_sort || 'time_desc';
    const subArticles = await getSubArticlesByArticleId(article.id, sort);
    const totalSubs = subArticles.length;
    const subTotalPages = Math.ceil(totalSubs / SUB_PER_PAGE) || 1;
    const start = (page - 1) * SUB_PER_PAGE;
    const pageItems = subArticles.slice(start, start + SUB_PER_PAGE);

    let text = `📌 <a href="${escapeHTML(article.link)}">${escapeHTML(article.title)}</a>\n\n`;
    text += `📎 子文章（第${page}页，共${totalSubs}个）：\n`;
    for (let i = 0; i < pageItems.length; i++) {
        const idx = start + i + 1;
        text += `${idx}. <a href="${escapeHTML(pageItems[i].link)}">${escapeHTML(pageItems[i].title)}</a>\n`;
    }

    const keyboard = [];
    for (let i = 0; i < pageItems.length; i += 5) {
        const row = [];
        for (let j = i; j < i + 5 && j < pageItems.length; j++) {
            row.push({
                text: String(start + j + 1),
                callback_data: `article:sub_item:${article.id}:${pageItems[j].id}`
            });
        }
        keyboard.push(row);
    }
    if (subTotalPages > 1) {
        keyboard.push(paginationRow(page, subTotalPages, (p) => `article:item_page:${article.id}:${p}`));
    }
    keyboard.push([
        { text: '➕ 添加子文章', callback_data: `article:add_sub:${article.id}` },
        { text: '✏️ 修改', callback_data: `article:edit:${article.id}` }
    ]);
    keyboard.push([{ text: '🔙 返回列表', callback_data: 'article:back' }]);

    setUserState(userId, {
        mode: MODE_NAME, step: 'detail', articleId: article.id, subPage: page,
        mainMsgId: messageId, lastActivity: Date.now()
    });

    await safeEditText(bot, userId, messageId, text, {
        reply_markup: { inline_keyboard: keyboard }, parse_mode: 'HTML', disable_web_page_preview: true
    });
}

// ==================== 修改文章菜单（新消息） ====================

async function showArticleEdit(userId, messageId, articleId) {
    const article = await getArticleById(parseInt(articleId));
    if (!article) { await safeEditText(bot, userId, messageId, '❌ 文章不存在'); return; }

    const keyboard = {
        inline_keyboard: [
            [{ text: '✏️ 修改标题', callback_data: `article:edit_title:${article.id}` }],
            [{ text: '🔗 修改链接', callback_data: `article:edit_link:${article.id}` }],
            [{ text: '🗑️ 删除文章', callback_data: `article:delete:${article.id}` }],
            [{ text: '🔙 返回', callback_data: `article:item:${article.id}` }]
        ]
    };

    setUserState(userId, {
        mode: MODE_NAME, step: 'edit_menu', articleId: article.id,
        mainMsgId: messageId, lastActivity: Date.now()
    });

    await safeEditText(bot, userId, messageId, `✏️ 修改文章：${article.title}`, { reply_markup: keyboard });
}

// ==================== 子文章详情 + 修改（一步到位，新消息） ====================

async function showSubArticleEdit(userId, messageId, articleId, subId) {
    const sub = await getSubArticleById(parseInt(subId));
    if (!sub) { await safeEditText(bot, userId, messageId, '❌ 子文章不存在'); return; }

    const text = `📄 <a href="${escapeHTML(sub.link)}">${escapeHTML(sub.title)}</a>`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '✏️ 修改标题', callback_data: `article:sub_edit_title:${articleId}:${sub.id}` }],
            [{ text: '🔗 修改链接', callback_data: `article:sub_edit_link:${articleId}:${sub.id}` }],
            [{ text: '🗑️ 删除子文章', callback_data: `article:sub_delete:${articleId}:${sub.id}` }],
            [{ text: '🔙 返回', callback_data: `article:item:${articleId}` }]
        ]
    };

    setUserState(userId, {
        mode: MODE_NAME, step: 'sub_edit', articleId: parseInt(articleId), subId: sub.id,
        mainMsgId: messageId, lastActivity: Date.now()
    });

    await safeEditText(bot, userId, messageId, text, {
        reply_markup: keyboard, parse_mode: 'HTML', disable_web_page_preview: true
    });
}

// ==================== 发送新消息（输入提示 / 操作结果） ====================

async function sendNewMessage(chatId, text, keyboard) {
    return await bot.sendMessage(chatId, text, {
        reply_markup: keyboard || { inline_keyboard: [] },
        parse_mode: 'HTML',
        disable_web_page_preview: true
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
    if (data === 'article:menu') {
        await showMainMenu(userId, messageId);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 退出
    if (data === 'article:exit') {
        deleteUserState(userId);
        await safeEditText(bot, userId, messageId, '✅ 已退出文章模式');
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 返回列表
    if (data === 'article:back' || data === 'article:list') {
        await showArticleList(userId, messageId, 1);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 文章列表翻页
    if (data.startsWith('article:list_page:')) {
        await showArticleList(userId, messageId, parseInt(parts[2]), state.viewMode || 'fold');
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 折叠/展开切换
    if (data.startsWith('article:toggle:')) {
        const page = parseInt(parts[2]);
        const newView = (state.viewMode === 'number' || state.step === 'list_number') ? 'fold' : 'number';
        await showArticleList(userId, messageId, page, newView);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 查看文章详情
    if (data.startsWith('article:item:')) {
        await showArticleDetail(userId, messageId, parts[2]);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 子文章翻页
    if (data.startsWith('article:item_page:')) {
        await showArticleDetailPage(userId, messageId, parts[2], parseInt(parts[3]));
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 新建文章（输入标题）
    if (data === 'article:new') {
        setUserState(userId, { ...state, step: 'waiting_title', mainMsgId: messageId, lastActivity: Date.now() });
        const sent = await sendNewMessage(chatId, '📝 请输入文章标题：');
        setUserState(userId, { ...state, step: 'waiting_title', inputMsgId: sent.message_id, mainMsgId: messageId, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 添加子文章（输入标题）
    if (data.startsWith('article:add_sub:')) {
        const articleId = parseInt(parts[2]);
        setUserState(userId, { ...state, step: 'waiting_sub_title', articleId, mainMsgId: messageId, lastActivity: Date.now() });
        const sent = await sendNewMessage(chatId, '📝 请输入子文章标题：');
        setUserState(userId, { ...state, step: 'waiting_sub_title', articleId, inputMsgId: sent.message_id, mainMsgId: messageId, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 修改文章菜单
    if (data.startsWith('article:edit:')) {
        await showArticleEdit(userId, messageId, parts[2]);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 修改文章标题
    if (data.startsWith('article:edit_title:')) {
        const articleId = parseInt(parts[2]);
        const sent = await sendNewMessage(chatId, '✏️ 请输入新的文章标题：');
        setUserState(userId, { ...state, step: 'waiting_edit_title', articleId, inputMsgId: sent.message_id, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 修改文章链接
    if (data.startsWith('article:edit_link:')) {
        const articleId = parseInt(parts[2]);
        const sent = await sendNewMessage(chatId, '🔗 请输入新的文章链接：');
        setUserState(userId, { ...state, step: 'waiting_edit_link', articleId, inputMsgId: sent.message_id, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 删除文章确认（新消息）
    if (data.startsWith('article:delete:')) {
        const articleId = parseInt(parts[2]);
        const article = await getArticleById(articleId);
        if (!article) {
            await bot.answerCallbackQuery(query.id, { text: '❌ 文章不存在' });
            return true;
        }
        const keyboard = {
            inline_keyboard: [[
                { text: '✅ 确认删除', callback_data: `article:delete_confirm:${articleId}` },
                { text: '❌ 取消', callback_data: `article:item:${articleId}` }
            ]]
        };
        await sendNewMessage(chatId, `⚠️ 确定要删除「${escapeHTML(article.title)}」及其所有子文章吗？`, keyboard);
        setUserState(userId, { ...state, step: 'delete_confirm', mainMsgId: messageId, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 确认删除文章
    if (data.startsWith('article:delete_confirm:')) {
        await deleteArticle(parseInt(parts[2]));
        await sendNewMessage(chatId, '✅ 文章已删除');
        await bot.answerCallbackQuery(query.id, { text: '已删除' });
        return true;
    }

    // 查看/编辑子文章（跳过中间菜单，直接显示编辑按钮）
    if (data.startsWith('article:sub_item:')) {
        await showSubArticleEdit(userId, messageId, parts[2], parts[3]);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 修改子文章标题
    if (data.startsWith('article:sub_edit_title:')) {
        const articleId = parseInt(parts[2]);
        const subId = parseInt(parts[3]);
        const sent = await sendNewMessage(chatId, '✏️ 请输入新的子文章标题：');
        setUserState(userId, { ...state, step: 'waiting_sub_edit_title', articleId, subId, inputMsgId: sent.message_id, mainMsgId: messageId, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 修改子文章链接
    if (data.startsWith('article:sub_edit_link:')) {
        const articleId = parseInt(parts[2]);
        const subId = parseInt(parts[3]);
        const sent = await sendNewMessage(chatId, '🔗 请输入新的子文章链接：');
        setUserState(userId, { ...state, step: 'waiting_sub_edit_link', articleId, subId, inputMsgId: sent.message_id, mainMsgId: messageId, lastActivity: Date.now() });
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 删除子文章确认（新消息）
    if (data.startsWith('article:sub_delete:')) {
        const articleId = parseInt(parts[2]);
        const subId = parseInt(parts[3]);
        const sub = await getSubArticleById(subId);
        if (!sub) {
            await bot.answerCallbackQuery(query.id, { text: '❌ 子文章不存在' });
            return true;
        }
        const keyboard = {
            inline_keyboard: [[
                { text: '✅ 确认删除', callback_data: `article:sub_delete_confirm:${articleId}:${subId}` },
                { text: '❌ 取消', callback_data: `article:sub_item:${articleId}:${subId}` }
            ]]
        };
        await sendNewMessage(chatId, `⚠️ 确定要删除子文章「${escapeHTML(sub.title)}」吗？`, keyboard);
        await bot.answerCallbackQuery(query.id);
        return true;
    }

    // 确认删除子文章
    if (data.startsWith('article:sub_delete_confirm:')) {
        await deleteSubArticle(parseInt(parts[3]));
        await sendNewMessage(chatId, '✅ 子文章已删除');
        await bot.answerCallbackQuery(query.id, { text: '已删除' });
        return true;
    }

    return false;
}

// ==================== 文本消息处理 ====================

async function handleArticleMessage(msg, state) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text;
    const mainMsgId = state.mainMsgId;

    // 等待输入文章标题
    if (state.step === 'waiting_title') {
        if (!text) { return true; }
        setUserState(userId, { ...state, step: 'waiting_link', title: text, lastActivity: Date.now() });
        await sendNewMessage(chatId, `📝 标题：${escapeHTML(text)}\n\n请输入文章链接：`);
        return true;
    }

    // 等待输入文章链接
    if (state.step === 'waiting_link') {
        if (!text) { return true; }
        const article = await createArticle({ title: state.title, link: text });
        await sendNewMessage(chatId, `✅ 文章已创建：<a href="${escapeHTML(article.link)}">${escapeHTML(article.title)}</a>`);
        const newMenu = await bot.sendMessage(chatId, '⏳');
        await showMainMenu(userId, newMenu.message_id);
        return true;
    }

    // 等待输入子文章标题
    if (state.step === 'waiting_sub_title') {
        if (!text) { return true; }
        setUserState(userId, { ...state, step: 'waiting_sub_link', title: text, lastActivity: Date.now() });
        await sendNewMessage(chatId, `📝 子文章标题：${escapeHTML(text)}\n\n请输入子文章链接：`);
        return true;
    }

    // 等待输入子文章链接
    if (state.step === 'waiting_sub_link') {
        if (!text) { return true; }
        await createSubArticle({ article_id: state.articleId, title: state.title, link: text });
        await sendNewMessage(chatId, '✅ 子文章已创建');
        const newMenu = await bot.sendMessage(chatId, '⏳');
        await showArticleDetail(userId, newMenu.message_id, state.articleId);
        return true;
    }

    // 等待修改文章标题
    if (state.step === 'waiting_edit_title') {
        if (!text) { return true; }
        await updateArticle(state.articleId, { title: text });
        await sendNewMessage(chatId, `✅ 标题已更新为：${escapeHTML(text)}`);
        const newMenu = await bot.sendMessage(chatId, '⏳');
        await showArticleDetail(userId, newMenu.message_id, state.articleId);
        return true;
    }

    // 等待修改文章链接
    if (state.step === 'waiting_edit_link') {
        if (!text) { return true; }
        await updateArticle(state.articleId, { link: text });
        await sendNewMessage(chatId, '✅ 链接已更新');
        const newMenu = await bot.sendMessage(chatId, '⏳');
        await showArticleDetail(userId, newMenu.message_id, state.articleId);
        return true;
    }

    // 等待修改子文章标题
    if (state.step === 'waiting_sub_edit_title') {
        if (!text) { return true; }
        await updateSubArticle(state.subId, { title: text });
        await sendNewMessage(chatId, `✅ 子文章标题已更新为：${escapeHTML(text)}`);
        const newMenu = await bot.sendMessage(chatId, '⏳');
        await showSubArticleEdit(userId, newMenu.message_id, state.articleId, state.subId);
        return true;
    }

    // 等待修改子文章链接
    if (state.step === 'waiting_sub_edit_link') {
        if (!text) { return true; }
        await updateSubArticle(state.subId, { link: text });
        await sendNewMessage(chatId, '✅ 子文章链接已更新');
        const newMenu = await bot.sendMessage(chatId, '⏳');
        await showSubArticleEdit(userId, newMenu.message_id, state.articleId, state.subId);
        return true;
    }

    return false;
}

module.exports = {
    handleCallback,
    handleArticleMessage,
    showMainMenu
};
