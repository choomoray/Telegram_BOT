// handlers/commands/index.js
const fs = require('fs');
const path = require('path');
const logger = require('../../logger');
const { isAdmin } = require('../../utils/permissions');

const commandMap = new Map();

const commandFiles = fs.readdirSync(__dirname)
    .filter(file => file.endsWith('.js') && file !== 'index.js');

for (const file of commandFiles) {
    const commandName = path.basename(file, '.js');
    const handler = require(`./${file}`);

    // 特殊映射（带下划线的命令）
    if (commandName === 'deleteGroup') {
        commandMap.set('/delete_group', handler);
    } else if (commandName === 'mediaGroup') {
        commandMap.set('/media_group', handler);
    } else if (commandName === 'mediaHide') {
        commandMap.set('/media_hide', handler);
    } else if (commandName === 'mediaUnhide') {
        commandMap.set('/media_unhide', handler);
    } else if (commandName === 'randomVideos') {
        commandMap.set('/random_videos', handler);
    } else if (commandName === 'randomPictures') {
        commandMap.set('/random_pictures', handler);
    } else if (commandName === 'messageReply') {
        commandMap.set('/message_reply', handler);
    } else if (commandName === 'edit') {
        commandMap.set('/edit', handler);
    } else if (commandName === 'help') {
        commandMap.set('/help', handler);
    } else if (commandName === 'transport') {
        commandMap.set('/transport', handler);
    } else if (commandName === 'setting') {   // 新增
        commandMap.set('/setting', handler);
    } else if (commandName === 'password') {
        commandMap.set('/password', handler);
    } else {
        commandMap.set(`/${commandName}`, handler);
    }
}

/**
 * 白名单用户（非管理员）允许使用的命令
 * 与 README 权限模型一致：白名单用户仅可使用基础查询功能
 */
const WHITELIST_ALLOWED_COMMANDS = new Set(['/search', '/exit']);

/**
 * 执行命令（严格匹配完整命令，其次匹配短命令）
 * @param {string} fullCommandText - 用户输入的命令文本
 * @param {number} userId - 用户ID
 * @param {Object} msg - Telegram 消息对象
 * @returns {Promise<string>} 'executed' | 'forbidden' | 'not_found'
 */
async function executeCommand(fullCommandText, userId, msg) {
    const normalized = fullCommandText.trim();
    const shortCommand = normalized.split(' ')[0];

    // 精确匹配完整命令，降级匹配短命令（去掉参数）
    const handler = commandMap.get(normalized) || commandMap.get(shortCommand);
    if (!handler) {
        return 'not_found';
    }

    // 权限校验：非管理员只能执行白名单命令（防止通过 /help 按钮或 AI 指令越权）
    if (!isAdmin(userId) && !WHITELIST_ALLOWED_COMMANDS.has(shortCommand)) {
        logger.warn(`用户 ${userId} 尝试执行无权限命令: ${shortCommand}`);
        return 'forbidden';
    }

    await handler(userId, msg);
    return 'executed';
}

module.exports = {
    commandMap,
    executeCommand
};