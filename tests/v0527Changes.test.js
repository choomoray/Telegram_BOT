// tests/v0527Changes.test.js
/**
 * 本次改动的针对性测试：
 *   - /restart 指令（仅管理员、加入 /help、退出码 75 触发重启）
 *   - 搬运收录巡检改为按需触发（不再随启动跑）
 *   - 随机图片 / /log 的临时错误重试（这是它们"时好时坏"的根因）
 *   - 打标签面板只保留一个按钮界面、按钮只留已选与置顶
 *   - 回复汇报区分成功与被忽略数量
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------------- /restart 指令 ----------------

test('/restart 已注册为指令（文件名即命令名，会被自动装载）', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'handlers', 'commands', 'restart.js')), '缺少 restart.js');
    // commands/index.js 自动把 restart.js 映射成 /restart（无下划线的走 else 分支）
    const idx = read('handlers/commands/index.js');
    assert.match(idx, /commandMap\.set\(`\/\$\{commandName\}`, handler\)/, '自动注册机制仍在');
});

test('/restart 仅管理员可用：不在白名单命令里', () => {
    const idx = read('handlers/commands/index.js');
    const m = idx.match(/WHITELIST_ALLOWED_COMMANDS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    assert.ok(m, '缺少白名单集合');
    assert.ok(!/\/restart/.test(m[1]), '/restart 绝不能进白名单（否则非管理员可用）');
    assert.match(idx, /if \(!isAdmin\(userId\) && !WHITELIST_ALLOWED_COMMANDS\.has\(shortCommand\)\)/,
        '非管理员 + 非白名单 → 拒绝');
});

test('/help 已加入「♻️ 重启」按钮，走 exec_cmd:/restart', () => {
    const help = read('handlers/commands/help.js');
    assert.match(help, /text: '♻️ 重启', callback_data: 'exec_cmd:\/restart'/);
});

test('/restart 置位重启意图并以 75 退出；未托管时提示不会自动起来', () => {
    const src = read('handlers/commands/restart.js');
    assert.match(src, /requestRestart\(\)/, '要置位重启意图');
    assert.match(src, /process\.exit\(75\)/, '兜底也要用 75');
    assert.match(src, /runGracefulShutdown/, '优先走优雅关闭');
    assert.match(src, /BOT_PARENT_PID/, '要能判断是否被看门狗托管');
    assert.match(src, /没有\*\*看门狗托管|没有\*\*看门狗/, '未托管时要明确提示不会自动起来');
});

test('退出码承载停机意图：/restart=75 重启，/shutdown=0 不再拉起', () => {
    const idx = read('index.js');
    assert.match(idx, /getShutdownReason\(\) === 'restart' \? RESTART_EXIT_CODE : 0/);
    const shutdown = read('shutdown.js');
    assert.match(shutdown, /const RESTART_EXIT_CODE = 75/);
    assert.match(shutdown, /function requestRestart\(\)/);
});

// ---------------- 搬运收录：按需触发 ----------------

test('启动时不再自动跑搬运收录巡检', () => {
    const idx = read('index.js');
    assert.ok(!/startTransportHealthCheck\s*\(/.test(idx), '不应再调用启动期巡检');
    assert.ok(!/TRANSPORT_CHECK_INTERVAL/.test(idx), '定时巡检常量应已移除');
});

test('/transport 进入时触发一次按需检查；WebUI 列表接口同样触发', () => {
    assert.match(read('handlers/commands/transport.js'), /checkTransportOnDemand\(\)/);
    assert.match(read('webui/server.js'), /checkTransportOnDemand\(\)/);
});

test('按需检查有节流与并发去重（避免频繁点击打到限流）', () => {
    const src = read('utils/transportCheck.js');
    assert.match(src, /MIN_INTERVAL/, '应有最短间隔');
    assert.match(src, /if \(inFlight\) return inFlight/, '并发去重');
    assert.match(src, /if \(!force && isThrottled\(\)\) return null/, '未 force 时节流');
});

test('transportCheck：节流窗口内直接跳过，force 可绕过', async () => {
    // 用桩把 linkHealth 换成可控实现（transportCheck 是延迟 require 的）
    const linkPath = path.join(ROOT, 'utils', 'linkHealth.js');
    const original = require.cache[linkPath];
    let calls = 0;
    require.cache[linkPath] = {
        id: linkPath, filename: linkPath, loaded: true,
        exports: {
            checkAllTransports: async () => {
                calls++;
                return { total: 1, ok: 1, dead: [], unknown: [], newlyDead: [], recovered: [] };
            },
            formatDeadReport: () => '',
            notifyAdmins: async () => 0
        }
    };
    try {
        const mod = require('../utils/transportCheck');
        mod._resetForTest();
        assert.strictEqual(mod.getLastCheckedAt(), 0, '初始未检查过');
        assert.strictEqual(mod.isThrottled(), false, '从未检查过不算节流');

        const first = await mod.checkTransportOnDemand();
        assert.ok(first, '第一次应真正执行');
        assert.strictEqual(calls, 1);

        assert.strictEqual(await mod.checkTransportOnDemand(), null, '节流窗口内应跳过');
        assert.strictEqual(calls, 1, '跳过时不应再调用检查');

        assert.ok(await mod.checkTransportOnDemand({ force: true }), 'force 应绕过节流');
        assert.strictEqual(calls, 2);
        mod._resetForTest();
    } finally {
        if (original) require.cache[linkPath] = original; else delete require.cache[linkPath];
    }
});

// ---------------- 临时错误重试（随机图片 / /log 不稳定的根因） ----------------

test('isRetryableError：网络类错误与外网临时故障要重试', () => {
    const { isRetryableError } = require('../utils/safeApiCall');
    // 旧实现只看 code===429 / status>=500，这些网络错误全被漏掉 → 命令时好时坏
    for (const code of ['EFATAL', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND']) {
        assert.strictEqual(isRetryableError(Object.assign(new Error('x'), { code })), true, `${code} 应重试`);
    }
    assert.strictEqual(isRetryableError({ code: 'ETELEGRAM', response: { status: 429 } }), true);
    assert.strictEqual(isRetryableError({ code: 'ETELEGRAM', response: { status: 502 } }), true);
    assert.strictEqual(isRetryableError(new Error('ETELEGRAM: 429 Too Many Requests: retry after 5')), true);
});

test('isRetryableError：业务性错误不重试（重试也不会有不同结果）', () => {
    const { isRetryableError } = require('../utils/safeApiCall');
    assert.strictEqual(isRetryableError(new Error('ETELEGRAM: 400 Bad Request: message is not modified')), false);
    assert.strictEqual(isRetryableError(new Error("ETELEGRAM: 400 Bad Request: message can't be edited")), false);
    assert.strictEqual(isRetryableError(new Error('ETELEGRAM: 400 Bad Request: chat not found')), false);
    assert.strictEqual(isRetryableError(new Error('ETELEGRAM: 403 Forbidden: bot was blocked by the user')), false);
});

test('safeApiCall：可重试错误会重试，最终成功返回结果', async () => {
    const { safeApiCall } = require('../utils/safeApiCall');
    let n = 0;
    const result = await safeApiCall(async () => {
        n++;
        if (n < 3) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        return 'ok';
    }, 3, 1);
    assert.strictEqual(result, 'ok');
    assert.strictEqual(n, 3, '前两次失败后第三次成功');
});

test('safeApiCall：不可重试错误立即抛出，不做无意义重试', async () => {
    const { safeApiCall } = require('../utils/safeApiCall');
    let n = 0;
    await assert.rejects(
        () => safeApiCall(async () => { n++; throw new Error('ETELEGRAM: 400 Bad Request: chat not found'); }, 3, 1),
        /chat not found/
    );
    assert.strictEqual(n, 1, '只调用一次');
});

test('随机图片与 /log 已接入重试', () => {
    assert.match(read('handlers/commands/randomPictures.js'), /safeApiCall/, 'randomPictures 应使用 safeApiCall');
    assert.match(read('handlers/commands/log.js'), /safeApiCall/, '/log 应使用 safeApiCall');
});

test('随机图片：重复 file_id 会被去重（重复会让 sendMediaGroup 直接 400）', () => {
    const src = read('handlers/commands/randomPictures.js');
    assert.match(src, /const seen = new Set\(\)/, '应做 file_id 去重');
});

test('/log 取数改为按时间倒序，避免截断时丢掉最新记录', () => {
    const src = read('handlers/commands/log.js');
    assert.match(src, /\.sort\(\{ date: -1, time: -1 \}\)/, '应按时间倒序取数');
});

// ---------------- 打标签面板 ----------------

test('打标签面板：删旧发新，只保留一个按钮界面', () => {
    const src = read('utils/tagSession.js');
    assert.match(src, /deleteMessage/, '刷新时应删除旧面板');
    assert.match(src, /async function refreshPanel\(userId, statusLine = ''\)/);
    assert.match(src, /const oldPanelId = session\.panelMsgId;/, '先记住旧面板 id');
    // 不再用 editMessageText 原地刷新面板（会把媒体顶上去、按钮留在下面）
    const refreshBody = src.slice(src.indexOf('async function refreshPanel'), src.indexOf('async function sendPanel'));
    assert.ok(!/editMessageText/.test(refreshBody), 'refreshPanel 不应再原地编辑');
});

test('打标签面板：按钮只留已选与置顶标签', () => {
    const src = read('utils/tagSession.js');
    const fn = src.slice(src.indexOf('async function renderTagKeyboard'), src.indexOf('async function buildPanelText'));
    assert.match(fn, /const pinned = tags\.filter\(t => t && t\.pin > 0\)/, '下区只取置顶标签');
    assert.match(fn, /buildTagRegionKeyboard\(current, pinned/, '传入的是"已选 + 置顶"而不是整个标签库');
    assert.ok(!/sortTags\(await getTags\(\)\)\)\s*;?\s*return buildTagRegionKeyboard\(current, tags/.test(fn),
        '不应再把整个标签库铺进按钮');
});

test('手动输入标签后：结果并入面板，不再单独发确认消息', () => {
    const src = read('utils/tagSession.js');
    assert.match(src, /await refreshPanel\(userId, `✅ \$\{parts\.join\('；'\)\}`\)/, '结果应写进面板');
    // handleTagText 里不应再有"另外发一条确认"
    const fn = src.slice(src.indexOf('async function handleTagText'), src.indexOf('// ---------------- 回调处理'));
    assert.ok(!/bot\.sendMessage\(userId, `✅ \$\{parts/.test(fn), '不应再单独发确认消息');
});

// ---------------- 回复汇报：成功 / 忽略 ----------------

test('回复汇报：有忽略时说明数量，无忽略时只报数量', () => {
    const src = read('handlers/modes/messageReplyMode.js');
    assert.match(src, /✅ 已回复媒体组 \(成功 \$\{newItems\.length\} 个，忽略 \$\{ignoredCount\} 个）/, '有忽略的格式');
    assert.match(src, /`✅ 已回复媒体组 \(\$\{newItems\.length\} 个\)`/, '无忽略的格式');
    assert.match(src, /let ignoredCount = 0/, '要统计被忽略（已存在）的媒体');
});

// ---------------- 终端颜色：走看门狗后与直接启动一致 ----------------

test('看门狗把颜色能力传给子进程（否则 pipe 会让 chalk 误判非终端而关色）', () => {
    const src = read('watchdog.js');
    assert.match(src, /function shouldUseColor\(\)/, '要有颜色能力判断');
    assert.match(src, /process\.stdout\.isTTY/, '按自身是否终端判断');
    assert.match(src, /FORCE_COLOR: '1'/, '有颜色能力时强制子进程带色');
    assert.match(src, /FORCE_COLOR: '0'/, '无颜色能力时（重定向到文件）不要塞转义码');
    assert.match(src, /NO_COLOR/, '要尊重 NO_COLOR');
});

test('看门狗日志：两个 [] 都上色，格式与 bot 一致（文件里不带颜色）', () => {
    const src = read('watchdog.js');
    // 时间戳用 90（gray），级别按级别上色，看门狗标签用 35（洋红）
    assert.match(src, /paint\('90', `\[\$\{ts\}\]`\)/, '时间戳要上色');
    assert.match(src, /paint\('35', '\[看门狗\]'\)/, '看门狗标签要上色');
    assert.match(src, /LEVEL_PAINT\[lv\]\(`\[\$\{lv\}\]`\)/, '级别要上色');
    // 写文件的那一行不含 ANSI
    assert.match(src, /logStream\.write\(`\[\$\{ts\}\] \[看门狗\] \[\$\{lv\}\] \$\{message\}\\n`\)/,
        '文件写入不带颜色');
});

test('logger 本身两个 [] 都在染色范围内（时间灰 + 级别色）', () => {
    const src = read('logger.js');
    assert.match(src, /chalk\.gray\(`\[\$\{timestamp\}\]`\)/, '时间戳 gray');
    assert.match(src, /color\(`\[\$\{abbr\}\]`\)/, '级别用级别色');
    // 四个级别都要有颜色映射，不能漏
    for (const lv of ['error: chalk.red', 'warn: chalk.yellow', 'success: chalk.green', 'info: chalk.cyanBright']) {
        assert.ok(src.includes(lv), `缺少颜色映射 ${lv}`);
    }
});

// ---------------- 搬运失效链接：不通知管理员 ----------------

test('搬运巡检不再向管理员发消息（失效链接到 WebUI「搬运」页处理）', () => {
    const src = read('utils/transportCheck.js');
    assert.ok(!/notifyAdmins/.test(src), '不应再调用 notifyAdmins');
    assert.ok(!/formatDeadReport/.test(src), '不需要组装发给管理员的报告');
    assert.match(src, /WebUI 控制台「搬运」页/, '日志里要指引到 WebUI');
    // 仍要留痕，便于控制台排查历史
    assert.match(src, /action: 'transport_check'/);
});

test('搬运巡检：只写 opLog、不发通知（linkHealth 的 notifyAdmins 仅供其它流程使用）', () => {
    const link = read('utils/linkHealth.js');
    assert.match(link, /async function notifyAdmins/, 'linkHealth 仍保留通用通知能力');
    const src = read('utils/transportCheck.js');
    const callSites = src.match(/notifyAdmins|sendMessage/g) || [];
    assert.strictEqual(callSites.length, 0, '巡检路径里不应有任何发消息调用');
});


// ---------------- 回复模式：也能直接回复文本（保留格式） ----------------

test('回复模式：就绪状态收到文本 → 直接回复文本（不再被忽略）', () => {
    const src = read('handlers/modes/messageReplyMode.js');
    assert.match(src, /if \(!mediaInfo && msg\.text\)\s*\{[\s\S]*?replyTextToTarget\(/,
        '就绪状态的文本应走 replyTextToTarget');
    // 旧行为是直接 return（静默忽略），必须已改掉
    assert.ok(!/在就绪状态发送非媒体消息，已忽略/.test(src), '旧的"忽略文本"分支应已移除');
});

test('回复文本：带上 entities 保留格式，回复到定位到的那条消息', () => {
    const src = read('handlers/modes/messageReplyMode.js');
    const fn = src.slice(src.indexOf('async function replyTextToTarget'), src.indexOf('async function processSingleMediaReply'));
    assert.ok(fn.length > 0, '应找到 replyTextToTarget');
    assert.match(fn, /buildForwardTextOptions\(msg\)/, '要复用共享的文本转发选项');
    assert.match(fn, /reply_to_message_id: targetMessageId/, '要回复到定位到的那条消息');
    assert.match(fn, /allow_sending_without_reply: true/, '原消息被删也要能发出去');
    assert.ok(!/parse_mode/.test(fn), '不应使用 parse_mode');
    assert.match(fn, /action: 'reply_text'/, '要记 reply_text 操作日志');
    // 不写 message 集合、不进打标签
    assert.ok(!/upsertMessage|recordAndTag/.test(fn), '文本回复不应写 message / 进打标签');
});

test('回复文本失败时有明确提示（群组/频道权限）', () => {
    const src = read('handlers/modes/messageReplyMode.js');
    const fn = src.slice(src.indexOf('async function replyTextToTarget'), src.indexOf('async function processSingleMediaReply'));
    assert.match(fn, /回复文本失败/);
    assert.match(fn, /action: 'reply_fail'/);
});

test('forwardText：无 entities 时不下发该字段，有则原样带上', () => {
    const { buildForwardTextOptions, countEntities } = require('../utils/forwardText');
    assert.deepStrictEqual(buildForwardTextOptions({ text: '纯文本' }), {}, '无格式时不应塞 entities');
    assert.deepStrictEqual(buildForwardTextOptions(null), {});
    assert.deepStrictEqual(buildForwardTextOptions({ entities: [] }), {});

    const entities = [{ type: 'bold', offset: 0, length: 4 }];
    assert.deepStrictEqual(buildForwardTextOptions({ entities }), { entities });
    assert.strictEqual(countEntities({ entities }), 1);
    assert.strictEqual(countEntities({}), 0);
    assert.strictEqual(countEntities(null), 0);
});

test('/send 与回复共用同一套文本转发逻辑（不再各写一份）', () => {
    const send = read('handlers/modes/sendMode.js');
    assert.match(send, /require\('\.\.\/\.\.\/utils\/forwardText'\)/, '/send 应复用共享实现');
    assert.match(send, /buildForwardTextOptions\(msg\)/);
    // 不应再有自己拼 entities 的重复实现
    assert.ok(!/sendOpts\.entities = msg\.entities/.test(send), '不应重复实现 entities 逻辑');
});

test('/send 转发文本时带上 entities 以保留 Telegram 格式', () => {
    const src = read('handlers/modes/sendMode.js');
    assert.match(src, /require\('\.\.\/\.\.\/utils\/forwardText'\)/, '复用共享的文本转发实现');
    assert.match(src, /const sendOpts = buildForwardTextOptions\(msg\)/);
    assert.match(src, /bot\.sendMessage\(targetChatId, msg\.text, sendOpts\)/);
    // 行为细节（entities 透传 / 不用 parse_mode）在 forwardText 的单测与文本分支检查里覆盖
    const start = src.indexOf('// 文本消息');
    const end = src.indexOf('const mediaInfo = extractMediaFromMessage');
    assert.ok(start > 0 && end > start, '定位文本转发分支失败');
    const textBranch = src.slice(start, end);
    assert.ok(!/parse_mode\s*[:=]/.test(textBranch), '文本转发分支不应给发送选项设置 parse_mode');
});
