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
    isTestMode,
    TEST_MONGODB_URI: process.env.TEST_MONGODB_URI || null
};