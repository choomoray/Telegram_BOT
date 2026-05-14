// config.js
const fs = require('fs');
const path = require('path');

function loadEnvSync() {
    const envPath = path.join(__dirname, '.env');
    try {
        if (fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf8');
            const lines = envContent.split(/\r?\n/);
            for (const line of lines) {
                if (!line || line.startsWith('#')) continue;
                const [key, ...valArr] = line.split('=');
                const trimmedKey = key.trim();
                if (trimmedKey) {
                    const value = valArr.join('=').trim();
                    process.env[trimmedKey] = value.replace(/^['"]|['"]$/g, '');
                }
            }
        }
    } catch (err) { }
}
loadEnvSync();

const isTestMode = process.argv.includes('--test');

const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'MONGODB_URI'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

const ADMIN_CHAT_ID_RAW = process.env.ADMIN_CHAT_ID || '';
const ADMIN_CHAT_IDS = ADMIN_CHAT_ID_RAW.split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0)
    .map(id => Number(id));

const STREAM_OUTPUT = process.env.STREAM_OUTPUT === 'true' || process.env.STREAM_OUTPUT === undefined;
const STREAM_UPDATE_INTERVAL = parseInt(process.env.STREAM_UPDATE_INTERVAL) || 500;

module.exports = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    MONGODB_URI: process.env.MONGODB_URI,
    DB_NAME: 'telegram_bot',
    COLLECTION_NAME: 'private_messages',
    INACTIVE_TIMEOUT: 10 * 60 * 1000,
    ADMIN_CHAT_ID: ADMIN_CHAT_ID_RAW,
    ADMIN_CHAT_IDS: ADMIN_CHAT_IDS,
    missingEnvVars: missingVars,
    envFileExists: fs.existsSync(path.join(__dirname, '.env')),
    HELP_SYSTEM_PROMPT: process.env.HELP_SYSTEM_PROMPT || '你是一个帮助智能体，负责解答用户问题。当用户请求需要机器人执行时，回复以 @bot 结尾的命令；否则回复以 @user 结尾的普通消息。',
    isTestMode,
    TEST_MONGODB_URI: process.env.TEST_MONGODB_URI || null,
    // LM Studio 配置
    LMSTUDIO_API_URL: process.env.LMSTUDIO_API_URL || 'http://localhost:1234/v1/chat/completions',
    LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || 'qwen2.5-0.5b',
    LMSTUDIO_API_TIMEOUT: parseInt(process.env.LMSTUDIO_API_TIMEOUT) || 60000,
    // DeepSeek 配置（实际指向本地自定义模型）
    DEEPSEEK_API_URL: process.env.DEEPSEEK_API_URL || 'http://127.0.0.1:55555/v1/chat/completions',
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || 'sk-any',
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    DEEPSEEK_API_TIMEOUT: parseInt(process.env.DEEPSEEK_API_TIMEOUT) || 60000,
    // 连接池配置
    CONNECTION_POOL: {
        maxSockets: parseInt(process.env.CONNECTION_POOL_MAX_SOCKETS) || 10
    },
    // 流式输出配置（会被数据库覆盖）
    STREAM_OUTPUT: STREAM_OUTPUT,
    STREAM_UPDATE_INTERVAL: STREAM_UPDATE_INTERVAL
};