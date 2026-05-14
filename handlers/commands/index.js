// handlers/commands/index.js
const fs = require('fs');
const path = require('path');

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
 * 执行命令（严格匹配完整命令）
 * @param {string} fullCommandText - 用户输入的命令文本
 * @param {number} userId - 用户ID
 * @param {Object} msg - Telegram 消息对象
 * @returns {Promise<boolean>} 是否成功执行
 */
async function executeCommand(fullCommandText, userId, msg) {
    const normalized = fullCommandText.trim();

    // 精确匹配完整命令
    let handler = commandMap.get(normalized);
    if (handler) {
        await handler(userId, msg);
        return true;
    }

    // 降级匹配短命令（去掉参数）
    const shortCommand = normalized.split(' ')[0];
    handler = commandMap.get(shortCommand);
    if (handler) {
        await handler(userId, msg);
        return true;
    }

    return false;
}

module.exports = {
    commandMap,
    executeCommand
};