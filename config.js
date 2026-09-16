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

// 注：`node index test` 只是"日志额外写一份到 logs/test-log"的模式（见 index.js / logger.js），
// 它**不**使用独立的测试数据库 —— 专用的 TEST_MONGODB_URI / `_test` 库已按用户要求移除。

const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'MONGODB_URI'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

const ADMIN_CHAT_ID_RAW = process.env.ADMIN_CHAT_ID || '';
const ADMIN_CHAT_IDS = ADMIN_CHAT_ID_RAW.split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0)
    .map(id => Number(id));

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
    // Web UI 配置
    WEBUI_PORT: parseInt(process.env.WEBUI_PORT) || 9700,
    // 登录密码不在此处配置：唯一来源是数据库 settings 集合的 webui_password 字段
    // （见 db/settings.js: getSettingPassword / webui/server.js）
    // 健康检查服务：看门狗轮询 /health、并用 POST /shutdown 请求优雅退出
    HEALTH_PORT: parseInt(process.env.HEALTH_PORT) || 9699,
    HEALTH_SHUTDOWN_TOKEN: process.env.HEALTH_SHUTDOWN_TOKEN || '',
    // Web UI AI 辅助（DeepSeek，用于数据库增删改查）
    DEEPSEEK_API_URL: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions',
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    DEEPSEEK_API_TIMEOUT: parseInt(process.env.DEEPSEEK_API_TIMEOUT) || 60000,

    // ---- MongoDB Atlas 白名单自动维护（见 utils/atlasAccessList.js） ----
    // 出口 IP 经常变（代理网络）时，连不上数据库就自动把当前 IP 以**临时条目**加进
    // 项目 Network Access（到期 Atlas 自动删除），见 .env.example 的说明。
    ATLAS_AUTO_WHITELIST: /^(1|true|yes|on)$/i.test(String(process.env.ATLAS_AUTO_WHITELIST || '')),
    ATLAS_PROJECT_ID: process.env.ATLAS_PROJECT_ID || '',
    ATLAS_PUBLIC_KEY: process.env.ATLAS_PUBLIC_KEY || '',
    ATLAS_PRIVATE_KEY: process.env.ATLAS_PRIVATE_KEY || '',
    ATLAS_API_BASE: (process.env.ATLAS_API_BASE || 'https://cloud.mongodb.com').replace(/\/+$/, ''),
    // Atlas Admin API 的版本日期（Accept: application/vnd.atlas.<日期>+json）
    ATLAS_API_VERSION: process.env.ATLAS_API_VERSION || '2024-08-05',
    // 临时条目有效期（天）：用户要求限期 1 周
    ATLAS_WHITELIST_TTL_DAYS: parseFloat(process.env.ATLAS_WHITELIST_TTL_DAYS) || 7,
    // 同一 IP / 短时间内的冷却，避免 Atlas 真的挂了时反复调 API
    ATLAS_WHITELIST_COOLDOWN_MS: parseInt(process.env.ATLAS_WHITELIST_COOLDOWN_MS) || 10 * 60 * 1000,
    // 出口 IP 回显服务（依次尝试，取第一个能解析出 IP 的）
    ATLAS_IP_LOOKUP_URLS: String(process.env.ATLAS_IP_LOOKUP_URLS ||
        'https://api.ipify.org,https://checkip.amazonaws.com,https://ifconfig.me/ip')
        .split(',').map(s => s.trim()).filter(Boolean),
    ATLAS_API_TIMEOUT_MS: parseInt(process.env.ATLAS_API_TIMEOUT_MS) || 15000,
    // 运行期数据库心跳间隔（掉线时触发同一套白名单维护）
    DB_GUARD_INTERVAL_MS: parseInt(process.env.DB_GUARD_INTERVAL_MS) || 60000
};