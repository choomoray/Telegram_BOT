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

// 日志实时订阅者（Web UI SSE 日志流使用）
const logListeners = new Set();

/**
 * 订阅日志输出（每次 log() 时回调）
 * @param {Function} cb - ({level, message, timestamp, text}) => void
 * @returns {Function} 取消订阅函数
 */
function onLog(cb) {
    logListeners.add(cb);
    return () => logListeners.delete(cb);
}

// 日志根目录
const LOG_ROOT = path.join(__dirname, 'logs');
fs.mkdir(LOG_ROOT, { recursive: true }).catch(() => { });

// ---------------- test 模式临时日志（node index test） ----------------
// test-log 与 logs 平级双根；test-log 下只有 log.log / error.log 两个扁平文件，
// 每次以 test 启动时重置（清空），关闭时不清理（仅启动时初始化）
const TEST_MODE = process.argv.includes('test');
const TEST_LOG_DIR = path.join(__dirname, 'test-log');
const TEST_LOG_FILES = {
    error: 'error.log',
    warn: 'log.log',
    success: 'log.log',
    info: 'log.log'
};

/**
 * 初始化 test 模式临时日志：重置 test-log/log.log 与 test-log/error.log
 * 每次以 test 启动时调用，清空上次运行内容
 */
async function initTestLog() {
    if (!TEST_MODE) return;
    try {
        await fs.mkdir(TEST_LOG_DIR, { recursive: true });
        await fs.writeFile(path.join(TEST_LOG_DIR, 'log.log'), '');
        await fs.writeFile(path.join(TEST_LOG_DIR, 'error.log'), '');
    } catch (err) {
        console.error(chalk.red('[TEST_LOG_INIT_ERROR]'), err.message);
    }
}

/**
 * ISO 8601 周号计算（周一为一周的开始）
 * 规则：一周从周一开始；包含当年第一个星期四的那一周为第 1 周
 * @param {Date} date
 * @returns {{year: number, week: number}} 返回 ISO 周所在的年份与周号
 */
function getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7; // 周一=1 ... 周日=7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum); // 移到本周周四（ISO 周锚点）
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return { year: d.getUTCFullYear(), week: weekNo };
}

// 当天日志路径缓存（跨天自动重算，避免每条日志都 mkdir）
let currentDayKey = null;
let currentDayPath = null;

/**
 * 计算今天的日志文件路径（logs/<年>/<月>/<ISO周>/<YYYY-MM-DD>.log）
 * 周目录格式如 2026-W36（带年份 ISO 周号，周一为周起始）
 * @returns {Promise<string>} 完整文件路径
 */
async function getTodayLogPath() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dayKey = `${year}-${month}-${day}`;
    if (currentDayKey === dayKey && currentDayPath) {
        return currentDayPath;
    }

    const { year: isoYear, week } = getISOWeek(now);
    const weekLabel = `${isoYear}-W${String(week).padStart(2, '0')}`;
    const dir = path.join(LOG_ROOT, String(year), month, weekLabel);
    await fs.mkdir(dir, { recursive: true }).catch(() => { });

    currentDayKey = dayKey;
    currentDayPath = path.join(dir, `${dayKey}.log`);
    return currentDayPath;
}

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

    // 文件输出（无颜色，同样使用缩写）：logs/<年>/<月>/<ISO周>/<YYYY-MM-DD>.log
    const fileMsg = `[${timestamp}] [${abbr}] ${message} ${args.join(' ')}\n`;
    const filePath = await getTodayLogPath();

    // 将写入任务推入队列
    const queue = getQueue(filePath);
    queue.push({ path: filePath, content: fileMsg });

    // test 模式：同一行日志复制一份到 test-log/log.log 或 test-log/error.log
    if (TEST_MODE) {
        const testFilePath = path.join(TEST_LOG_DIR, TEST_LOG_FILES[level] || 'log.log');
        const testQueue = getQueue(testFilePath);
        testQueue.push({ path: testFilePath, content: fileMsg });
    }

    // 广播给实时订阅者（Web UI 日志流）
    for (const listener of logListeners) {
        try {
            listener({ level, message: `${message} ${args.join(' ')}`.trim(), timestamp, text: fileMsg.trim() });
        } catch (err) {
            console.error(chalk.red('[LOG_LISTENER_ERROR]'), err.message);
        }
    }
}

/**
 * 等待所有日志写入队列清空（收到关闭信号时调用，保证日志不丢失）
 * @returns {Promise<void>}
 */
async function flushLogs() {
    const queues = [...fileQueues.values()];
    await Promise.all(queues.map(queue => {
        if (queue.idle()) return Promise.resolve();
        return new Promise(resolve => {
            queue.drain = resolve;
        });
    }));
}

// 便捷方法
module.exports = {
    error: (msg, ...args) => log('error', msg, ...args),
    warn: (msg, ...args) => log('warn', msg, ...args),
    success: (msg, ...args) => log('success', msg, ...args),
    info: (msg, ...args) => log('info', msg, ...args),
    onLog,
    getISOWeek,
    initTestLog,
    flushLogs,
    TEST_MODE
};
