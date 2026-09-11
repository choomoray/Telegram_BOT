// handlers/modes/transportMode.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getRawUserState, setUserState, deleteUserState } = require('../../states');
const { escapeHTML } = require('../../utils/sanitize');
const {
    getAllTransports,
    upsertTransport,
    deleteTransport,
    updateTransportStatus,
    extractChatInfo
} = require('../../db/transport');
const {
    checkTransportLink,
    checkAllTransports,
    formatDeadReport
} = require('../../utils/linkHealth');
const { logOperation } = require('../../utils/opLog');

const STALE_CHECK_MS = 6 * 60 * 60 * 1000; // 距上次检查超过 6 小时视为过期，进入列表时自动补查
const STALE_CHECK_LIMIT = 8;               // 单次进入最多补查条数（避免阻塞/触发限流）

/** 活性徽标：✅ 有效 / ❌ 失效 / ❔ 未检查 */
function healthIcon(item) {
    if (item && item.alive === true) return '✅';
    if (item && item.alive === false) return '❌';
    return '❔';
}

function formatCheckTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 详情页的活性描述行（HTML 安全） */
function healthLine(item) {
    const when = item.last_check_at ? `（${formatCheckTime(item.last_check_at)} 检查）` : '';
    if (item.alive === true) return `活性：✅ 链接有效${when}`;
    if (item.alive === false) return `活性：❌ 已失效${when}\n原因：${escapeHTML(item.last_check_error || '不可访问')}`;
    return '活性：❔ 尚未检查（点下方按钮立即检查）';
}

async function sendWithBackButton(userId, text, replyToMessageId = null, backData = 'transport:back') {
    const keyboard = { inline_keyboard: [[{ text: '🔙 返回', callback_data: backData }]] };
    return await bot.sendMessage(userId, text, {
        reply_to_message_id: replyToMessageId,
        reply_markup: keyboard,
        disable_web_page_preview: true
    });
}

function buildMainKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🔍 检查链接活性', callback_data: 'transport:check' }],
            [{ text: '🔄 更新', callback_data: 'transport:update' }],
            [{ text: '📋 管理', callback_data: 'transport:manage' }]
        ]
    };
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
    const link = item.url ? `<a href="${item.url}">${item.url}</a>` : '（无）';
    const text = `📌 项目 ${index}\n名称：${escapeHTML(item.chat_name)}\nID：<code>${item.chat_id}</code>\n链接：${link}\n更新次数：${item.num || 0}\n${healthLine(item)}`;
    const keyboard = {
        inline_keyboard: [
            [{ text: '🔍 检查该链接活性', callback_data: `transport:check_item:${index}` }],
            [{ text: '✏️ 编辑名字', callback_data: `transport:edit_name:${index}` }],
            [{ text: '🆔 编辑ID', callback_data: `transport:edit_id:${index}` }],
            [{ text: '🗑️ 删除', callback_data: `transport:delete:${index}` }],
            [{ text: '🔙 返回', callback_data: 'transport:back' }]
        ]
    };
    return { text, keyboard };
}

/** 列表头部统计行：✅ 有效 / ❌ 失效 / ❔ 未检查 */
function healthSummary(transports) {
    const alive = transports.filter(t => t.alive === true).length;
    const dead = transports.filter(t => t.alive === false).length;
    const unchecked = transports.length - alive - dead;
    return `共 ${transports.length} 条：✅ 有效 ${alive} ／ ❌ 失效 ${dead} ／ ❔ 未检查 ${unchecked}`;
}

/** 列表文本（含活性徽标与失效提示） */
function buildListText(transports) {
    if (transports.length === 0) return '📊 下面是搬运列表\n暂无记录';
    const lines = transports.map((item, i) => {
        const number = (i + 1).toString().padStart(2, '0');
        const link = item.url ? `<a href="${item.url}">${number} ${escapeHTML(item.chat_name)}</a>` : `${number} ${escapeHTML(item.chat_name)}`;
        return `${healthIcon(item)} ${link}`;
    });
    let text = `📊 下面是搬运列表\n${lines.join('\n')}\n\n${healthSummary(transports)}`;
    const dead = transports.filter(t => t.alive === false);
    if (dead.length) {
        text += `\n\n⚠️ 失效链接（编辑或删除）：\n${dead.slice(0, 5).map(d =>
            `• ${escapeHTML(d.chat_name)}：${escapeHTML(d.last_check_error || '不可访问')}`).join('\n')}`;
        if (dead.length > 5) text += `\n…另有 ${dead.length - 5} 条`;
    }
    return text;
}

/**
 * 进入列表时自动补查（不阻塞渲染）：挑出过期/从未检查的记录，最多 STALE_CHECK_LIMIT 条
 * 检查完若列表消息仍在，刷新列表；发现失效链接则私聊提醒
 */
async function autoCheckStale(userId, messageId) {
    try {
        const transports = await getAllTransports();
        const stale = transports
            .filter(t => !t.last_check_at || Date.now() - t.last_check_at > STALE_CHECK_MS)
            .slice(0, STALE_CHECK_LIMIT);
        if (!stale.length) return;
        const summary = await checkAllTransports({ records: stale, force: true, concurrency: 4 });
        if (summary.newlyDead.length) {
            await bot.sendMessage(userId, formatDeadReport(summary.newlyDead), { disable_web_page_preview: true }).catch(() => { });
        }
        const state = getRawUserState(userId);
        // 只有当前仍停在列表页时才回写刷新，避免覆盖"管理 / 明细 / 检查结果"界面
        const stillListing = state && state.mode === 'transport' && state.step === 'main'
            && (!state.mainMsgId || state.mainMsgId === messageId);
        if (messageId && stillListing) {
            await showTransportList(userId, messageId, null, { skipAutoCheck: true }).catch(() => { });
        }
    } catch (err) {
        logger.warn(`自动检查收录链接活性失败: ${err.message}`);
    }
}

async function showTransportList(userId, editMessageId = null, replyToMessageId = null, opts = {}) {
    const transports = await getAllTransports();
    const text = buildListText(transports);
    const keyboard = buildMainKeyboard();
    const options = { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true };
    let targetMessageId = editMessageId;
    if (editMessageId) {
        try {
            await bot.editMessageText(text, { chat_id: userId, message_id: editMessageId, ...options });
        } catch (err) {
            if (err.response?.body?.description === 'Bad Request: message is not modified') {
                if (!opts.skipAutoCheck) autoCheckStale(userId, editMessageId).catch(() => { });
                return null;
            }
            logger.error(`编辑主界面失败: ${err.message}`);
            const sent = await bot.sendMessage(userId, text, { reply_to_message_id: replyToMessageId, ...options });
            targetMessageId = sent && sent.message_id;
            if (!opts.skipAutoCheck) autoCheckStale(userId, targetMessageId).catch(() => { });
            return sent;
        }
        if (!opts.skipAutoCheck) autoCheckStale(userId, editMessageId).catch(() => { });
        return null;
    }
    const sent = await bot.sendMessage(userId, text, { reply_to_message_id: replyToMessageId, ...options });
    targetMessageId = sent && sent.message_id;
    if (!opts.skipAutoCheck) autoCheckStale(userId, targetMessageId).catch(() => { });
    return sent;
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

/** 写回并返回活性结论（新增/改链接/单条检查共用） */
async function checkAndSave(item) {
    try {
        const result = await checkTransportLink(item);
        await updateTransportStatus(item.chat_id, {
            status: result.status,
            error: result.error,
            chatName: result.chat_name,
            previousAlive: item.alive
        });
        return result;
    } catch (err) {
        logger.warn(`检查链接活性失败 chat_id=${item.chat_id}: ${err.message}`);
        return { status: 'unknown', error: err.message, chat_name: null };
    }
}

/** 活性结论 → 一行提示 */
function healthSuffix(result) {
    if (!result) return '';
    if (result.status === 'ok') return '\n活性检查：✅ 链接有效';
    if (result.status === 'dead') return `\n活性检查：❌ 链接已失效（${result.error || '不可访问'}）`;
    return `\n活性检查：❔ 暂时无法判定（${result.error || '未知原因'}）`;
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
            // 更新后立即实测一次活性，直接告诉用户这条链接还能不能用
            const result = await checkAndSave({ chat_id: chatInfo.chat_id, url, alive: existing.alive });
            logOperation({
                action: 'transport_save',
                source: 'private',
                userId,
                target: { type: 'chat', id: chatInfo.chat_id },
                counts: { chats: 1 },
                detail: { chat_name: existing.chat_name, url, updated: true, via: 'bot', alive: result.status }
            }).catch(() => { });
            await sendWithBackButton(userId, `✅ 频道：${existing.chat_name} 更新成功！${healthSuffix(result)}`, originalMsg.message_id);
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
        const result = await checkAndSave({ chat_id: pendingChatId, url: pendingUrl, alive: null });
        await sendWithBackButton(userId, `✅ 已添加：${finalName}${healthSuffix(result)}`, originalMsg.message_id);
        logOperation({
            action: 'transport_save',
            source: 'private',
            userId,
            target: { type: 'chat', id: pendingChatId },
            counts: { chats: 1 },
            detail: { chat_name: finalName, url: pendingUrl, created: true, via: 'bot', alive: result.status }
        }).catch(() => { });
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
            text += `${healthIcon(item)} <a href="${item.url}">${number} ${escapeHTML(item.chat_name)}</a>\n`;
        }
        text += `\n${healthSummary(transports)}`;
    }
    const keyboard = buildManageKeyboard(transports);
    await bot.editMessageText(text, {
        chat_id: userId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: keyboard, disable_web_page_preview: true
    });
    setUserState(userId, { ...state, step: 'manage', mainMsgId: state.mainMsgId, lastActivity: Date.now() });
}

/** 渲染单个项目的编辑界面（不加 answerCallbackQuery，便于检查后原地刷新） */
async function showItemInterface(userId, msgId, index, state) {
    const transports = await getAllTransports();
    if (index < 1 || index > transports.length) return false;
    const item = transports[index - 1];
    const { text, keyboard } = buildItemEditInterface(item, index);
    await bot.editMessageText(text, {
        chat_id: userId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: keyboard, disable_web_page_preview: true
    });
    setUserState(userId, { ...state, step: 'editing_item', editingIndex: index, editingItem: item, mainMsgId: state.mainMsgId, lastActivity: Date.now() });
    return true;
}

async function handleItemSelect(userId, msgId, index, state, query) {
    await bot.answerCallbackQuery(query.id, { text: '加载中...' });
    if (!(await showItemInterface(userId, msgId, index, state))) {
        await bot.answerCallbackQuery(query.id, { text: '无效序号' });
    }
}

/** 检查单个项目：实测 → 写回 → 原地刷新详情 */
async function handleCheckItem(userId, msgId, index, state, query) {
    const transports = await getAllTransports();
    if (index < 1 || index > transports.length) {
        await bot.answerCallbackQuery(query.id, { text: '无效序号' });
        return;
    }
    const item = transports[index - 1];
    await bot.answerCallbackQuery(query.id, { text: '正在检查链接…' });
    const result = await checkAndSave(item);
    const toast = result.status === 'ok' ? '✅ 链接有效'
        : result.status === 'dead' ? '❌ 链接已失效' : '❔ 暂时无法判定';
    await bot.answerCallbackQuery(query.id, { text: toast }).catch(() => { });
    await showItemInterface(userId, msgId, index, state);
}

/** 检查全部链接：实测 → 汇总 → 失效提醒 */
async function handleCheckAll(userId, msgId, state, query) {
    await bot.answerCallbackQuery(query.id, { text: '正在检查全部链接…' });
    await bot.editMessageText('🔍 正在检查全部收录链接的活性，请稍候…', {
        chat_id: userId, message_id: msgId, disable_web_page_preview: true
    }).catch(() => { });
    const summary = await checkAllTransports({ force: true, concurrency: 4 });
    let text = `🔍 活性检查完成（共 ${summary.total} 条，本次检查 ${summary.checked} 条）\n✅ 有效 ${summary.ok} ／ ❌ 失效 ${summary.dead.length} ／ ❔ 未知 ${summary.unknown.length}`;
    const report = formatDeadReport(summary.dead);
    if (report) text += `\n\n${report}`;
    if (summary.recovered.length) text += `\n\n♻️ ${summary.recovered.length} 条链接已恢复可访问`;
    logOperation({
        action: 'transport_check',
        source: 'private',
        userId,
        target: { type: 'collection', id: 'transport' },
        counts: { chats: summary.checked },
        detail: { total: summary.total, ok: summary.ok, dead: summary.dead.length, unknown: summary.unknown.length, via: 'bot' }
    }).catch(() => { });
    await bot.editMessageText(text, {
        chat_id: userId, message_id: msgId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 返回列表', callback_data: 'transport:back' }]] },
        disable_web_page_preview: true
    }).catch(async () => {
        await bot.sendMessage(userId, text, { disable_web_page_preview: true }).catch(() => { });
    });
    setUserState(userId, { ...state, step: 'check_result', mainMsgId: msgId, lastActivity: Date.now() });
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
    logOperation({
        action: 'transport_delete',
        source: 'private',
        userId,
        target: { type: 'chat', id: item.chat_id },
        counts: { chats: 1 },
        detail: { chat_name: item.chat_name, url: item.url, via: 'bot' }
    }).catch(() => { });
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
    if (data === 'transport:check') {
        await handleCheckAll(userId, messageId, state, query);
        return true;
    }
    if (data.startsWith('transport:check_item:')) {
        const index = parseInt(data.split(':')[2]);
        await handleCheckItem(userId, messageId, index, state, query);
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
        // 换了 chat_id 等于换了目标，立即实测一次活性
        const result = await checkAndSave({ chat_id: newId, url: item.url, alive: null });
        await sendWithBackButton(userId, `✅ 已更新 chat_id 为：${newId}${healthSuffix(result)}`, msg.message_id);
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