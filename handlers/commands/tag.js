// handlers/commands/tag.js
/**
 * /tag 指令：进入标签模式
 * 1. 修改消息标签（发送媒体 → 预览媒体组 → 添加/删除标签）
 * 2. 编辑标签（添加 / 修改名字 / 删除，同步 message 集合）
 */
const bot = require('../../bot');
const logger = require('../../logger');
const { setUserState, updateUserActivity } = require('../../states');
const { cleanPreviousMode } = require('../../utils/enterMode');
const { insertLog } = require('../../db/log');

async function handleTagCommand(userId, msg) {
    updateUserActivity(userId);

    await cleanPreviousMode(userId);

    setUserState(userId, {
        mode: 'tag',
        step: 'menu',               // menu / waiting_media / add_tag / rename_tag
        groupId: null,              // 当前操作的媒体组
        groupTagMode: null,         // 'add' | 'del'（修改消息标签时的操作模式）
        pendingRenameTag: null,     // 编辑标签改名时的旧标签名
        lastActivity: Date.now(),
        _onExit: async () => { }
    });

    logger.info(`用户 ${userId} 进入标签模式`);

    const { showTagMenu } = require('../modes/tagMode');
    await showTagMenu(userId, msg.message_id);

    insertLog(26, userId).catch(err => logger.error(`记录日志失败: ${err.message}`));
}

module.exports = handleTagCommand;
