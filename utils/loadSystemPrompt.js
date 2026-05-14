// utils/loadSystemPrompt.js
const fs = require('fs').promises;
const path = require('path');
const logger = require('../logger');

async function loadSystemPrompt() {
    try {
        const corePath = path.join(__dirname, '../ai/AI Read/00-core.md');
        const content = await fs.readFile(corePath, 'utf8');
        return content && content.trim() ? content : '你是一个智能聊天助手。';
    } catch (err) {
        logger.warn(`读取 00-core.md 失败: ${err.message}，使用默认系统提示`);
        return '你是一个智能聊天助手。';
    }
}

module.exports = { loadSystemPrompt };
