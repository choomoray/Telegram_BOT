const fs = require('fs').promises;
const path = require('path');
const chalk = require('chalk');
const async = require('async');

// 日志级别缩写映射（统一为4字符）
const LEVEL_ABBR = {
    error: 'ERRO',
    warn: 'WARN',
    success: 'SUCC',
    info: 'INFO',
};

// 日志级别与颜色映射
const LEVEL_COLOR = {
    error: chalk.red,
    warn: chalk.yellow,
    success: chalk.green,
    info: chalk.cyanBright,
};

// 日志级别与文件名映射（保持原样）
const LOG_FILES = {
    error: 'error.log',
    warn: 'operation.log',
    success: 'operation.log',
    info: 'operation.log',
};

// 确保 logs 目录存在
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdir(LOG_DIR, { recursive: true }).catch(() => { });

/**
 * 文件写入队列（并发数1，保证顺序写入）
 * key: 文件路径, value: async队列
 */
const fileQueues = new Map();

function getQueue(filePath) {
    if (!fileQueues.has(filePath)) {
        const queue = async.queue(async (task) => {
            try {
                await fs.appendFile(task.path, task.content);
            } catch (err) {
                // 文件写入失败仅控制台警告，不抛出异常
                console.error(chalk.red('[LOG_WRITE_ERROR]'), err.message);
            }
        }, 1);
        fileQueues.set(filePath, queue);
    }
    return fileQueues.get(filePath);
}

/**
 * 通用日志函数
 * @param {string} level - error / warn / success / info
 * @param {string} message - 日志内容
 * @param {...any} args - 额外参数（仅控制台显示）
 */
async function log(level, message, ...args) {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const abbr = LEVEL_ABBR[level] || level.toUpperCase().slice(0, 4); // 后备截断
    const color = LEVEL_COLOR[level] || chalk.white;

    // 控制台输出（彩色，带缩写级别）
    const consoleMsg = `${chalk.gray(`[${timestamp}]`)} ${color(`[${abbr}]`)} ${message} ${args.length ? args.join(' ') : ''}`;
    console.log(consoleMsg);

    // 文件输出（无颜色，同样使用缩写）
    const fileMsg = `[${timestamp}] [${abbr}] ${message} ${args.join(' ')}\n`;
    const fileName = LOG_FILES[level] || 'operation.log';
    const filePath = path.join(LOG_DIR, fileName);

    // 将写入任务推入队列
    const queue = getQueue(filePath);
    queue.push({ path: filePath, content: fileMsg });
}

// 便捷方法
module.exports = {
    error: (msg, ...args) => log('error', msg, ...args),
    warn: (msg, ...args) => log('warn', msg, ...args),
    success: (msg, ...args) => log('success', msg, ...args),
    info: (msg, ...args) => log('info', msg, ...args),
};