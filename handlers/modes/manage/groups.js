// handlers/modes/manage/groups.js
const bot = require('../../../bot');
const logger = require('../../../logger');
const { getRawUserState, setUserState } = require('../../../states');
const {
    getAllChannelGroups,
    upsertChannelGroup,
    updateChannelGroup,
    deleteChannelGroup
} = require('../../../db/channelGroup');
const { extractChatInfo } = require('../../../db/transport');
const { escapeHTML } = require('../../../utils/sanitize');

async function showGroupList(userId, messageId) {
    const groups = await getAllChannelGroups();
    let text = '📊 频道 / 群组列表：\n';
    if (groups.length === 0) {
        text += '暂无记录';
    } else {
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const number = (i + 1).toString().padStart(2, '0');
            const typeIcon = g.type === 'channel' ? '📢' : '👥';
            text += `${typeIcon} ${number} - ${escapeHTML(g.name)} (${g.id})\n`;
        }
    }

    const keyboard = {
        inline_keyboard: [
            [{ text: '➕ 添加', callback_data: 'manage:add_group' }],
            [{ text: '📋 管理', callback_data: 'manage:manage_view' }],
            [{ text: '🔙 返回', callback_data: 'manage:back' }]
        ]
    };

    await bot.editMessageText(text, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: keyboard,
        parse_mode: 'HTML'
    });

    setUserState(userId, {
        mode: 'manage',
        step: 'group_list',
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function showGroupManageView(userId, messageId, page = 1) {
    const groups = await getAllChannelGroups();
    const pageSize = 30;
    const totalPages = Math.ceil(groups.length / pageSize) || 1;
    const start = (page - 1) * pageSize;
    const pageItems = groups.slice(start, start + pageSize);

    let text = '📋 请选择要管理的频道：\n';
    if (pageItems.length === 0) {
        text += '暂无记录';
    } else {
        for (let i = 0; i < pageItems.length; i++) {
            const g = pageItems[i];
            const number = (start + i + 1).toString().padStart(2, '0');
            const typeIcon = g.type === 'channel' ? '📢' : '👥';
            text += `${typeIcon} ${number} - ${escapeHTML(g.name)}\n`;
        }
    }

    const keyboard = [];
    const buttonsPerRow = 5;
    for (let i = 0; i < pageItems.length; i += buttonsPerRow) {
        const row = [];
        for (let j = i; j < i + buttonsPerRow && j < pageItems.length; j++) {
            const globalIndex = start + j + 1;
            row.push({
                text: globalIndex.toString(),
                callback_data: `manage:item:${globalIndex}`
            });
        }
        keyboard.push(row);
    }

    if (totalPages > 1) {
        const navRow = [];
        if (page > 1) {
            navRow.push({ text: '◀ 上一页', callback_data: `manage:manage_page:${page - 1}` });
        }
        navRow.push({ text: `${page} / ${totalPages}`, callback_data: 'noop' });
        if (page < totalPages) {
            navRow.push({ text: '下一页 ▶', callback_data: `manage:manage_page:${page + 1}` });
        }
        keyboard.push(navRow);
    }
    keyboard.push([{ text: '🔙 返回列表', callback_data: 'manage:groups' }]);

    await bot.editMessageText(text, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard },
        parse_mode: 'HTML'
    });

    setUserState(userId, {
        mode: 'manage',
        step: 'group_manage',
        page: page,
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function showGroupDetail(userId, messageId, groupIndex) {
    const groups = await getAllChannelGroups();
    if (groupIndex < 1 || groupIndex > groups.length) {
        await bot.editMessageText('❌ 无效的序号', { chat_id: userId, message_id: messageId });
        return;
    }
    const g = groups[groupIndex - 1];
    const bindInfo = g.bind_id ? `已绑定：${g.bind_id}` : '未绑定';
    const text = `📌 ${escapeHTML(g.name)}\n类型：${g.type}\n${bindInfo}`;
    const keyboard = {
        inline_keyboard: [
            [{ text: '✏️ 编辑名称', callback_data: `manage:edit_name:${groupIndex}` }],
            [{ text: '🔗 关联群组', callback_data: `manage:bind:${groupIndex}` }],
            [{ text: '🗑️ 删除', callback_data: `manage:delete_group:${groupIndex}` }],
            [{ text: '🔙 返回列表', callback_data: 'manage:groups' }]
        ]
    };
    await bot.editMessageText(text, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: keyboard,
        parse_mode: 'HTML'
    });
    setUserState(userId, {
        mode: 'manage',
        step: 'group_detail',
        groupIndex: groupIndex,
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function promptAddGroup(userId, messageId) {
    await bot.editMessageText('♻️ 请输入频道/群组链接（如 https://t.me/xxx 或频道ID）', {
        chat_id: userId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 返回', callback_data: 'manage:groups' }]] }
    });
    setUserState(userId, {
        mode: 'manage',
        step: 'waiting_group_link',
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function verifyAndAddGroup(userId, input, state, msg) {
    try {
        const chatInfo = await extractChatInfo(input, bot);
        await upsertChannelGroup({
            id: chatInfo.chat_id,
            name: chatInfo.chat_name || `Group ${chatInfo.chat_id}`,
            type: chatInfo.chat_id.toString().startsWith('-100') ? 'channel' : 'group',
            bind_id: null,
            is_bound: false
        });

        const keyboard = {
            inline_keyboard: [
                [{ text: '🔗 添加关联群组', callback_data: `manage:bind_new:${chatInfo.chat_id}` }],
                [{ text: '🔙 返回列表', callback_data: 'manage:groups' }]
            ]
        };
        await bot.sendMessage(userId, '✅ 添加成功', {
            reply_to_message_id: msg.message_id,
            reply_markup: keyboard
        });
        setUserState(userId, {
            mode: 'manage',
            step: 'group_list',
            mainMsgId: state.mainMsgId,
            lastActivity: Date.now()
        });
    } catch (err) {
        logger.error(`解析链接添加群组失败: ${err.message}`);
        await bot.sendMessage(userId, `❌ 无法识别该链接，请确认机器人已加入且为管理员，或链接格式正确`, { reply_to_message_id: msg.message_id });
    }
}

async function promptBindGroup(userId, messageId, groupIndex, newGroupId = null) {
    await bot.editMessageText('♻️ 请输入关联频道/群组链接', {
        chat_id: userId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 返回', callback_data: 'manage:groups' }]] }
    });
    setUserState(userId, {
        mode: 'manage',
        step: 'waiting_bind_input',
        groupIndex: groupIndex || null,
        newGroupId: newGroupId || null,
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function verifyAndBind(userId, input, state, msg) {
    try {
        const chatInfo = await extractChatInfo(input, bot);
        const bindId = chatInfo.chat_id;
        if (state.newGroupId) {
            await updateChannelGroup(state.newGroupId, { bind_id: bindId });
        } else {
            const groups = await getAllChannelGroups();
            const g = groups[state.groupIndex - 1];
            await updateChannelGroup(g.id, { bind_id: bindId });
        }
        await bot.sendMessage(userId, '✅ 关联成功', { reply_to_message_id: msg.message_id });
        await showGroupList(userId, state.mainMsgId);
    } catch (err) {
        logger.error(`关联群组失败: ${err.message}`);
        await bot.sendMessage(userId, `❌ 无法识别该链接，请确认机器人已加入且为管理员`, { reply_to_message_id: msg.message_id });
    }
}

async function promptEditName(userId, messageId, groupIndex) {
    const groups = await getAllChannelGroups();
    const g = groups[groupIndex - 1];
    await bot.editMessageText(`✏️ 当前名称：${g.name}\n请输入新名称：`, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: '🔙 返回', callback_data: 'manage:groups' }]] }
    });
    setUserState(userId, {
        mode: 'manage',
        step: 'waiting_edit_name',
        groupIndex: groupIndex,
        mainMsgId: messageId,
        lastActivity: Date.now()
    });
}

async function saveEditName(userId, newName, state, msg) {
    const groups = await getAllChannelGroups();
    const g = groups[state.groupIndex - 1];
    await updateChannelGroup(g.id, { name: newName });
    await bot.sendMessage(userId, `✅ 名称已更新为 ${newName}`, { reply_to_message_id: msg.message_id });
    await showGroupList(userId, state.mainMsgId);
}

async function confirmDeleteGroup(userId, messageId, groupIndex) {
    const groups = await getAllChannelGroups();
    const g = groups[groupIndex - 1];
    const keyboard = {
        inline_keyboard: [
            [{ text: '✅ 确认删除', callback_data: `manage:delete_confirm:${groupIndex}` }],
            [{ text: '🔙 取消', callback_data: 'manage:groups' }]
        ]
    };
    await bot.editMessageText(`⚠️ 确定要删除 ${g.name} 吗？`, {
        chat_id: userId,
        message_id: messageId,
        reply_markup: keyboard
    });
}

async function executeDelete(userId, messageId, groupIndex) {
    const groups = await getAllChannelGroups();
    const g = groups[groupIndex - 1];
    await deleteChannelGroup(g.id);
    await bot.editMessageText('✅ 已删除', { chat_id: userId, message_id: messageId });
    await showGroupList(userId, messageId);
}

module.exports = {
    showGroupList, showGroupManageView, showGroupDetail,
    promptAddGroup, verifyAndAddGroup,
    promptBindGroup, verifyAndBind,
    promptEditName, saveEditName,
    confirmDeleteGroup, executeDelete
};
