// handlers/modes/chatMode/extractCommands.js
function extractCommands(text) {
    const buttonMatches = [...text.matchAll(/\[BUTTON:(.*?):(.*?)\]/g)];
    const cmdMatches = [...text.matchAll(/\[CMD:(.*?)\]/g)];
    const loadMatches = [...text.matchAll(/\[LOAD:(.*?)\]/g)];
    const dbMatches = [...text.matchAll(/\[DB:update:(.*?):(.*?):(.*?)\]/g)];
    const queryMatches = [...text.matchAll(/\[QUERY:(.*?):(.*?)\]/g)];
    // 新增：提取 GET 指令
    const getMatches = [...text.matchAll(/\[GET:(.*?)\]/g)];

    const buttons = buttonMatches.map(m => ({ text: m[1], command: m[2].trim() }));
    const commands = cmdMatches.map(m => m[1].trim());
    const loads = loadMatches.map(m => m[1].trim());
    const dbs = dbMatches.map(m => ({ collection: m[1].trim(), field: m[2].trim(), value: m[3].trim() }));
    const queries = queryMatches.map(m => ({ collection: m[1].trim(), query: m[2].trim() }));
    const gets = getMatches.map(m => m[1].trim());

    // 清理文本（移除所有指令标记）
    let cleanedText = text;
    for (const match of buttonMatches) cleanedText = cleanedText.replace(match[0], '');
    for (const match of cmdMatches) cleanedText = cleanedText.replace(match[0], '');
    for (const match of loadMatches) cleanedText = cleanedText.replace(match[0], '');
    for (const match of dbMatches) cleanedText = cleanedText.replace(match[0], '');
    for (const match of queryMatches) cleanedText = cleanedText.replace(match[0], '');
    for (const match of getMatches) cleanedText = cleanedText.replace(match[0], '');
    cleanedText = cleanedText.replace(/\s*\n\s*/g, '\n').trim();

    return { text: cleanedText, buttons, commands, loads, dbs, queries, gets };
}

module.exports = extractCommands;