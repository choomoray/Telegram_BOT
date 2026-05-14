// handlers/modes/chatMode/processAIReply.js
const logger = require('../../../logger');
const { updateSetting } = require('../../../db/settings');
const { executeCommand } = require('../../commands');
const { safeEditMessage, cleanReply, parseAIReply } = require('./utils');
const { executeQuery } = require('./dbOperations');
const { callModel } = require('./modelCall');
const extractCommands = require('./extractCommands');
const fs = require('fs').promises;
const path = require('path');
const bot = require('../../../bot');

/**
 * 递归处理 AI 回复块
 * @param {Array} blocks - parseAIReply 返回的块
 * @param {Array} currentMsgList - 当前消息列表（可能包含 system）
 * @param {Object} context - 包含 userId, currentModel, streamOutput, thinking, thinkingMsg 等
 * @param {number} retryCount - 重试计数
 * @returns {Promise<string>} 最终用户消息
 */
async function processAIReply(blocks, currentMsgList, context, retryCount = 0) {
    const MAX_RETRIES = 3;
    const { userId, currentModel, streamOutput, thinking, thinkingMsg, history, messageText, state, setState, deleteState } = context;
    let finalUserMessage = null;

    for (const block of blocks) {
        if (block.type === 'bot') {
            const round = block.round;
            const content = block.content;
            const { text: cleanText, buttons, commands, loads, dbs, queries, gets } = extractCommands(content);

            // ========== 处理 GET 指令 ==========
            if (gets.length > 0) {
                const getResults = [];
                for (const get of gets) {
                    if (get === 'user_id') {
                        getResults.push(`用户ID: ${userId}`);
                    } else {
                        getResults.push(`未知的GET参数: ${get}`);
                    }
                }
                const resultMsg = `@ai:${round} ${getResults.join('\n')}`;
                const historyWithoutSystem = currentMsgList.filter(m => m.role !== 'system');
                const newMessages = [...historyWithoutSystem, { role: 'user', content: resultMsg }];
                let newAccumulated = '';
                const onChunk = (chunk) => { newAccumulated += chunk; };
                await callModel(currentModel, newMessages, streamOutput, thinking, onChunk);
                const cleanedNew = cleanReply(newAccumulated);
                await safeEditMessage(thinkingMsg, userId, cleanedNew);
                const newBlocks = parseAIReply(cleanedNew);
                if (retryCount < MAX_RETRIES) {
                    const recursiveResult = await processAIReply(newBlocks, newMessages, context, retryCount + 1);
                    if (recursiveResult) finalUserMessage = recursiveResult;
                } else {
                    logger.warn(`用户 ${userId} GET指令处理达到最大重试次数`);
                }
                continue;
            }

            // ========== 处理 LOAD 指令 ==========
            if (loads.length > 0) {
                let loadedContent = '';
                for (const loadFile of loads) {
                    try {
                        const filePath = path.join(__dirname, '../../../ai/AI Read', loadFile);
                        const fileContent = await fs.readFile(filePath, 'utf8');
                        if (fileContent && fileContent.trim()) {
                            loadedContent += `\n\n--- 知识库：${loadFile} ---\n${fileContent.trim()}`;
                            logger.info(`[聊天模式] 用户 ${userId} 加载知识库: ${loadFile}`);
                        } else {
                            loadedContent += `\n\n❌ 知识库文件 ${loadFile} 为空`;
                        }
                    } catch (err) {
                        logger.error(`加载知识库失败: ${loadFile}, ${err.message}`);
                        loadedContent += `\n\n❌ 知识库文件 ${loadFile} 不存在或无法读取。可用文件：01-commands.md, 02-database.md`;
                    }
                }
                const resultMsg = `@ai:${round} ${loadedContent}`;
                const historyWithoutSystem = currentMsgList.filter(m => m.role !== 'system');
                const newMessages = [...historyWithoutSystem, { role: 'user', content: resultMsg }];
                let newAccumulated = '';
                const onChunk = (chunk) => { newAccumulated += chunk; };
                await callModel(currentModel, newMessages, streamOutput, thinking, onChunk);
                const cleanedNew = cleanReply(newAccumulated);
                await safeEditMessage(thinkingMsg, userId, cleanedNew);
                const newBlocks = parseAIReply(cleanedNew);
                if (retryCount < MAX_RETRIES) {
                    const recursiveResult = await processAIReply(newBlocks, newMessages, context, retryCount + 1);
                    if (recursiveResult) finalUserMessage = recursiveResult;
                } else {
                    logger.warn(`用户 ${userId} LOAD指令处理达到最大重试次数`);
                }
                continue;
            }

            // ========== 处理 DB 指令 ==========
            if (dbs.length > 0) {
                const dbResults = [];
                for (const db of dbs) {
                    const collection = db.collection;
                    const field = db.field.toUpperCase();
                    const value = db.value;

                    if (collection === 'settings') {
                        const allowedFields = ['STREAM_OUTPUT', 'STREAM_UPDATE_INTERVAL'];
                        if (allowedFields.includes(field)) {
                            let parsedValue;
                            if (field === 'STREAM_OUTPUT') {
                                parsedValue = value === 'true' ? true : false;
                            } else if (field === 'STREAM_UPDATE_INTERVAL') {
                                parsedValue = parseInt(value);
                                if (isNaN(parsedValue)) {
                                    dbResults.push(`无效的更新间隔: ${value}`);
                                    continue;
                                }
                            }
                            try {
                                await updateSetting({}, field, parsedValue);
                                dbResults.push(`✅ 设置 ${field} 已更新为 ${parsedValue}`);
                                logger.info(`用户 ${userId} 通过 AI 更新设置: ${field}=${parsedValue}`);
                            } catch (err) {
                                logger.error(`更新设置失败: ${err.message}`);
                                dbResults.push(`❌ 更新设置失败: ${err.message}`);
                            }
                        } else {
                            dbResults.push(`字段 "${field}" 无效，允许的字段: STREAM_OUTPUT, STREAM_UPDATE_INTERVAL。请加载 [LOAD:02-database.md] 获取完整规范。`);
                        }
                    } else if (collection === 'user_setting') {
                        // 用户设置已合并为全局设置，AI 不允许修改
                        dbResults.push(`❌ 用户设置已不再支持单独修改，所有设置已统一为全局设置，请通过 /setting 命令修改。`);
                    } else {
                        dbResults.push(`不允许更新集合 "${collection}"，仅支持 settings。`);
                    }
                }
                const resultMsg = `@ai:${round} ${dbResults.join('\n')}`;
                const historyWithoutSystem = currentMsgList.filter(m => m.role !== 'system');
                const newMessages = [...historyWithoutSystem, { role: 'user', content: resultMsg }];
                let newAccumulated = '';
                const onChunk = (chunk) => { newAccumulated += chunk; };
                await callModel(currentModel, newMessages, streamOutput, thinking, onChunk);
                const cleanedNew = cleanReply(newAccumulated);
                await safeEditMessage(thinkingMsg, userId, cleanedNew);
                const newBlocks = parseAIReply(cleanedNew);
                if (retryCount < MAX_RETRIES) {
                    const recursiveResult = await processAIReply(newBlocks, newMessages, context, retryCount + 1);
                    if (recursiveResult) finalUserMessage = recursiveResult;
                } else {
                    logger.warn(`用户 ${userId} DB指令处理达到最大重试次数`);
                }
                continue;
            }

            // ========== 处理 QUERY 指令 ==========
            if (queries.length > 0) {
                let queryResults = '';
                for (const q of queries) {
                    const result = await executeQuery(q.collection, q.query);
                    queryResults += `\n\n查询集合 ${q.collection} 条件 ${q.query} 的结果：\n${result}`;
                }
                const resultMsg = `@ai:${round} ${queryResults}`;
                const historyWithoutSystem = currentMsgList.filter(m => m.role !== 'system');
                const newMessages = [...historyWithoutSystem, { role: 'user', content: resultMsg }];
                let newAccumulated = '';
                const onChunk = (chunk) => { newAccumulated += chunk; };
                await callModel(currentModel, newMessages, streamOutput, thinking, onChunk);
                const cleanedNew = cleanReply(newAccumulated);
                await safeEditMessage(thinkingMsg, userId, cleanedNew);
                const newBlocks = parseAIReply(cleanedNew);
                if (retryCount < MAX_RETRIES) {
                    const recursiveResult = await processAIReply(newBlocks, newMessages, context, retryCount + 1);
                    if (recursiveResult) finalUserMessage = recursiveResult;
                } else {
                    logger.warn(`用户 ${userId} QUERY指令处理达到最大重试次数`);
                }
                continue;
            }

            // ========== 处理 CMD 指令 ==========
            for (const cmd of commands) {
                logger.info(`[聊天模式] 执行AI指令: ${cmd}`);
                const fakeMsg = {
                    from: { id: userId },
                    chat: { id: userId },
                    message_id: thinkingMsg.message_id,
                    text: cmd
                };
                try {
                    await executeCommand(cmd, userId, fakeMsg);
                    finalUserMessage = `✅ 已执行命令：${cmd}`;
                } catch (err) {
                    logger.error(`执行AI指令失败: ${cmd}, ${err.message}`);
                    finalUserMessage = `❌ 执行命令 ${cmd} 失败`;
                }
            }

            // ========== 处理 BUTTON 指令 ==========
            if (buttons.length > 0) {
                const keyboard = {
                    inline_keyboard: buttons.map(btn => ([{
                        text: btn.text,
                        callback_data: `exec_cmd:${encodeURIComponent(btn.command)}`
                    }]))
                };
                await safeEditMessage(thinkingMsg, userId, cleanText || '请选择操作：', keyboard);
                finalUserMessage = cleanText || '请选择操作：';
            }

        } else if (block.type === 'user') {
            finalUserMessage = block.content;
        }
    }

    if (!finalUserMessage) {
        finalUserMessage = '✅ 指令已处理';
    }
    return finalUserMessage;
}

module.exports = { processAIReply };