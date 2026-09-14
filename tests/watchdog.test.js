// tests/watchdog.test.js
/**
 * 看门狗（watchdog.js）行为测试
 *
 * 覆盖用户明确要求的语义：
 *   - 「按用户的启动方式重启」：`node watchdog.js webui` → 崩了还是用 webui 重启
 *   - 崩溃后「30 秒」重启
 *   - 崩溃后通知管理员
 *   - 优雅退出（看门狗自己收到停机信号）时不重启，避免把人工关闭当成崩溃
 *   - 重启风暴保护：连崩超过上限则停止自动重启
 *
 * 这里用可注入的假依赖驱动，不真的 spawn 进程、不真的发 Telegram。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { buildConfig, normalizeBotArgs, describeMode } = require('../watchdog/config');
const notify = require('../watchdog/notify');

// ---------------- 启动参数透传（「按用户的启动方式重启」的核心） ----------------

test('启动参数原样透传：node watchdog.js webui -> node index.js webui', () => {
    assert.deepStrictEqual(normalizeBotArgs(['webui']), ['webui']);
    assert.deepStrictEqual(normalizeBotArgs(['test']), ['test']);
    assert.deepStrictEqual(normalizeBotArgs(['--test']), ['--test']);
    assert.deepStrictEqual(normalizeBotArgs([]), []);
});

test('describeMode 识别三种启动方式', () => {
    assert.strictEqual(describeMode([]), 'normal');
    assert.strictEqual(describeMode(['webui']), 'webui');
    assert.strictEqual(describeMode(['test']), 'test');
    assert.strictEqual(describeMode(['--test']), 'test');
});

test('buildConfig：botArgs / mode / entry 正确，重启延迟默认 30 秒', () => {
    const webui = buildConfig(['webui']);
    assert.deepStrictEqual(webui.botArgs, ['webui'], '重启时要用同一份参数');
    assert.strictEqual(webui.mode, 'webui');
    assert.strictEqual(path.basename(webui.entry), 'index.js');
    assert.strictEqual(webui.restartDelayMs, 30000, '默认崩溃后 30 秒重启');

    const normal = buildConfig([]);
    assert.deepStrictEqual(normal.botArgs, []);
    assert.strictEqual(normal.mode, 'normal');

    const t = buildConfig(['test']);
    assert.deepStrictEqual(t.botArgs, ['test']);
    assert.strictEqual(t.mode, 'test');
});

test('buildConfig：环境变量可覆盖默认值（含非法值回退）', () => {
    const cfg = buildConfig(['webui'], { platform: 'linux' });
    assert.strictEqual(cfg.platform, 'linux');
    assert.ok(cfg.maxRestarts > 0, '重启上限应为正数');
    assert.ok(cfg.healthFailThreshold > 0);
    // 通知模式只接受已知取值，默认 crash
    assert.ok(['crash', 'after_restart', 'off'].includes(cfg.notifyMode));
});

// ---------------- 重启决策（直接用 watchdog.js 导出的真实实现） ----------------

const { nextRestartState, decideAfterExit } = require('../watchdog');
const { RESTART_EXIT_CODE } = require('../shutdown');

test('人工关闭（看门狗主动请求退出）不触发重启', () => {
    assert.strictEqual(decideAfterExit({ exitCode: 0, signal: null, intentionalStop: true, exited: false }), 'stop');
});

test('看门狗自身正在退出时不重启', () => {
    assert.strictEqual(decideAfterExit({ exitCode: 0, signal: null, intentionalStop: false, exited: true }), 'stop');
});

test('非人工退出一律视为崩溃（含 exitCode=0 的意外退出）', () => {
    assert.strictEqual(decideAfterExit({ exitCode: 0, signal: null, intentionalStop: false, exited: false }), 'crash');
    assert.strictEqual(decideAfterExit({ exitCode: 1, signal: null, intentionalStop: false, exited: false }), 'crash');
    assert.strictEqual(decideAfterExit({ exitCode: null, signal: 'SIGKILL', intentionalStop: false, exited: false }), 'crash');
});

test('/restart 的退出码 → 立即按原启动方式重启（不当崩溃、不等待）', () => {
    assert.strictEqual(
        decideAfterExit({ exitCode: RESTART_EXIT_CODE, signal: null, intentionalStop: false, exited: false }),
        'restart'
    );
    // 即使同时被标记为"主动停"，/restart 也必须重启（用户明确要求重启）
    assert.strictEqual(
        decideAfterExit({ exitCode: RESTART_EXIT_CODE, signal: null, intentionalStop: true, exited: false }),
        'restart'
    );
    assert.strictEqual(RESTART_EXIT_CODE, 75, '退出码取 75，避免与 128+signal 区间冲突');
});

// ---------------- 重启风暴保护（真实实现） ----------------

/** 按时间顺序喂给 nextRestartState，返回每步结果 */
function runRestartSequence(times, cfg) {
    let count = 0;
    let windowStart = null;
    return times.map(t => {
        const next = nextRestartState(count, windowStart, t, cfg);
        count = next.count;
        windowStart = next.windowStart;
        return next;
    });
}

test('窗口内连续崩溃超过上限 → 停止自动重启', () => {
    const cfg = { maxRestarts: 5, windowMs: 600000 };
    // count = 窗口内已发生的崩溃（已重启）次数，每次调用累加 1
    const results = runRestartSequence([0, 1000, 2000, 3000, 4000, 5000, 6000], cfg);
    assert.deepStrictEqual(results.map(r => r.count), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepStrictEqual(results.map(r => r.giveUp), [false, false, false, false, false, true, true],
        '前 5 次照常重启，第 6 次（超过上限 5）起停止');
});

test('恰好第 5 次崩溃仍会重启（上限语义：允许 maxRestarts 次自动重启）', () => {
    const cfg = { maxRestarts: 5, windowMs: 600000 };
    const results = runRestartSequence([0, 1000, 2000, 3000, 4000], cfg);
    assert.deepStrictEqual(results.map(r => r.count), [1, 2, 3, 4, 5]);
    assert.ok(results.every(r => r.giveUp === false), '前 5 次都不应放弃');
});

test('超出时间窗口后重新计数（避免"很久崩一次"累积到上限）', () => {
    const cfg = { maxRestarts: 5, windowMs: 600000 };
    runRestartSequence([0, 1000, 2000, 3000, 4000, 5000], cfg);
    const after = nextRestartState(5, 5000, 700000, cfg);
    assert.strictEqual(after.count, 1, '新窗口从 1 重新开始');
    assert.strictEqual(after.giveUp, false);
});

// ---------------- 通知文案（简化格式：只报最近的 warn / erro） ----------------

/** 构造一条带颜色与时间戳的 bot 输出行（模拟真实终端输出） */
const outLine = (level, text) =>
    `\u001b[90m[2026-09-13 21:29:59]\u001b[39m \u001b[33m[${level}]\u001b[39m ${text} `;

test('崩溃通知：固定标题 + 只列 warn/erro，且去掉时间戳与颜色', () => {
    const text = notify.formatCrashReport({
        tail: [
            outLine('INFO', '正在连接数据库'),
            outLine('SUCC', 'MongoDB 连接成功'),
            outLine('WARN', '会话超时'),
            outLine('ERRO', 'ETELEGRAM: 400 Bad Request: chat not found'),
            outLine('INFO', '这条不该出现')
        ]
    });

    assert.match(text, /⚠️ BOT出现意外崩溃，稍后尝试重启/, '使用约定的标题');
    assert.match(text, /崩溃信息：/);
    assert.match(text, /\[warn\] 会话超时/);
    assert.match(text, /\[erro\] ETELEGRAM: 400 Bad Request: chat not found/);
    // 只报问题：info / succ 不进报告
    assert.ok(!/正在连接数据库/.test(text), 'info 不应出现');
    assert.ok(!/MongoDB 连接成功/.test(text), 'succ 不应出现');
    assert.ok(!/这条不该出现/.test(text), 'info 不应出现');
    // 不保留日志时间戳（用户要求的格式是 [warn] XXX）
    assert.ok(!/2026-09-13 21:29:59/.test(text), '不应带原始时间戳');
    assert.ok(!/\u001b\[/.test(text), '不应残留 ANSI 颜色码');
});

test('崩溃通知：没有 warn/erro 时给出明确说明而不是空白', () => {
    const text = notify.formatCrashReport({ tail: [outLine('INFO', '一切正常')] });
    assert.match(text, /⚠️ BOT出现意外崩溃/);
    assert.match(text, /没有 warn \/ erro 日志/);
});

test('崩溃通知：同一错误连续刷屏只保留一条', () => {
    const text = notify.formatCrashReport({
        tail: [outLine('ERRO', 'boom'), outLine('ERRO', 'boom'), outLine('ERRO', 'boom')]
    });
    assert.strictEqual((text.match(/\[erro\] boom/g) || []).length, 1);
});

test('崩溃通知：最多列 reportTailLimit 条（默认 10），取最近的', () => {
    const tail = [];
    for (let i = 1; i <= 15; i++) tail.push(outLine('WARN', `warn-${i}`));
    const text = notify.formatCrashReport({ tail, limit: 10 });
    assert.ok(!/warn-1\b/.test(text), '应丢弃较早的条目');
    assert.match(text, /warn-15/, '应保留最新的条目');
    assert.strictEqual((text.match(/\[warn\]/g) || []).length, 10);
});

test('重启通知：成功 / 未就绪两种标题，带同样的 warn/erro 明细', () => {
    const ok = notify.formatRestartReport({ ok: true, tail: [outLine('WARN', '小警告')] });
    assert.match(ok, /♻️ BOT重启成功/);
    assert.match(ok, /\[warn\] 小警告/);

    const failed = notify.formatRestartReport({ ok: false, tail: [outLine('ERRO', '又崩了')] });
    assert.match(failed, /🚨 BOT重启后仍未就绪/);
    assert.match(failed, /\[erro\] 又崩了/);
});

test('停止重试通知：说明窗口、次数与如何重新启动', () => {
    const giveUp = notify.formatGiveUpReport({
        botArgs: ['webui'], mode: 'webui', consecutive: 6, maxRestarts: 5,
        restartWindowMs: 600000, tail: [outLine('ERRO', 'boom')]
    });
    assert.match(giveUp, /停止自动重启/);
    assert.match(giveUp, /10 分钟内崩溃 6 次/);
    assert.match(giveUp, /\[erro\] boom/);
    assert.match(giveUp, /node watchdog\.js webui/, '要告诉用户怎么重新启动看门狗');
});

test('pickWarnErrorLines：解析各种级别写法，忽略非日志行', () => {
    const picked = notify.pickWarnErrorLines([
        '普通输出行',
        outLine('WARN', 'a'),
        '[2026-09-13 21:00:00] [ERRO] b',
        '[2026-09-13 21:00:01] [ERROR] c',   // ERROR 全写也要认
        ''
    ]);
    assert.deepStrictEqual(picked, ['[warn] a', '[erro] b', '[erro] c']);
});

test('缺少 token 时通知不抛错，而是返回错误说明', async () => {
    const res = await notify.sendToAdmins({ telegramToken: '', adminChatIds: [] }, 'hi');
    assert.strictEqual(res.sent, 0);
    assert.ok(res.errors.length > 0);
});

test('spawnNotifier：缺 token / 无文本时不启动进程（返回 null）', () => {
    assert.strictEqual(notify.spawnNotifier({ text: 'x', token: '', adminChatIds: [1], root: process.cwd() }), null);
    assert.strictEqual(notify.spawnNotifier({ text: '', token: 't', adminChatIds: [1], root: process.cwd() }), null);
    assert.strictEqual(notify.spawnNotifier({ text: 'x', token: 't', adminChatIds: [], root: process.cwd() }), null);
});

// ---------------- 崩溃标记（bot 侧播报依赖它） ----------------

test('崩溃标记：读取后即删除，保证同一次崩溃只播报一次', () => {
    const fs = require('fs');
    const crashNotify = require('../utils/crashNotify');
    const marker = crashNotify.MARKER_FILE;
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({
        reason: '进程异常退出（exitCode=1）', mode: 'webui', botArgs: ['webui'],
        timeText: '2026-09-13 21:30:00', consecutive: 1, maxRestarts: 5, tail: ['x']
    }));

    try {
        const first = crashNotify.consumeCrashMarker();
        assert.ok(first, '第一次应读到标记');
        assert.strictEqual(first.mode, 'webui');
        const second = crashNotify.consumeCrashMarker();
        assert.strictEqual(second, null, '第二次应为空（标记已删除）');
        assert.ok(!fs.existsSync(marker), '标记文件应已被删除');
    } finally {
        try { fs.unlinkSync(marker); } catch { }
    }
});

test('崩溃标记：内容损坏时不抛错，返回 null', () => {
    const fs = require('fs');
    const crashNotify = require('../utils/crashNotify');
    const marker = crashNotify.MARKER_FILE;
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '{ 这不是 JSON');
    try {
        assert.strictEqual(crashNotify.consumeCrashMarker(), null);
    } finally {
        try { fs.unlinkSync(marker); } catch { }
    }
});

test('重启播报已移交看门狗：bot 侧只留痕，不再自行发送通知', () => {
    const crashNotify = require('../utils/crashNotify');
    // bot 侧不再有 formatRestartReport（避免与看门狗重复发送）
    assert.strictEqual(typeof crashNotify.formatRestartReport, 'undefined', 'bot 侧不应再组装重启通知');
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'utils', 'crashNotify.js'), 'utf8');
    assert.match(src, /logOperation/, '仍要写一条 opLog 留痕');
    assert.ok(!/notifyAdmins/.test(src), '不应再调用 notifyAdmins（通知统一由看门狗发）');
});

// ---------------- 孤儿进程防护（看门狗被硬杀时 bot 要自己退出） ----------------

test('watchParentProcess：没有 BOT_PARENT_PID 时不做任何事（直接 node index.js 不受影响）', () => {
    const shutdown = require('../shutdown');
    const saved = process.env.BOT_PARENT_PID;
    delete process.env.BOT_PARENT_PID;
    try {
        assert.strictEqual(shutdown.watchParentProcess(), null, '无父进程信息应返回 null');
    } finally {
        if (saved !== undefined) process.env.BOT_PARENT_PID = saved;
    }
});

test('watchParentProcess：父进程存活时不触发退出', async () => {
    const shutdown = require('../shutdown');
    const saved = process.env.BOT_PARENT_PID;
    process.env.BOT_PARENT_PID = String(process.pid); // 自己一定活着
    let fired = false;
    const timer = shutdown.watchParentProcess({ intervalMs: 30, onParentGone: () => { fired = true; } });
    try {
        await new Promise(r => setTimeout(r, 150));
        assert.strictEqual(fired, false, '父进程（自己）还活着，不应触发');
    } finally {
        clearInterval(timer);
        if (saved !== undefined) process.env.BOT_PARENT_PID = saved;
        else delete process.env.BOT_PARENT_PID;
    }
});

test('watchParentProcess：父进程消失时触发回调（避免 bot 变成孤儿实例）', async () => {
    const shutdown = require('../shutdown');
    const saved = process.env.BOT_PARENT_PID;
    // 用一个几乎不可能存在的 pid：进程不存在时 process.kill(pid,0) 抛 ESRCH
    process.env.BOT_PARENT_PID = '999999';
    let gotSignal = null;
    const timer = shutdown.watchParentProcess({
        intervalMs: 30,
        onParentGone: (why) => { gotSignal = why; }
    });
    try {
        await new Promise(r => setTimeout(r, 200));
        assert.strictEqual(gotSignal, 'parent-gone', '应判定父进程消失并回调');
    } finally {
        clearInterval(timer);
        if (saved !== undefined) process.env.BOT_PARENT_PID = saved;
        else delete process.env.BOT_PARENT_PID;
    }
});

test('watchdog.js 给子进程注入 BOT_PARENT_PID；index.js 在启动后开启父进程看护', () => {
    const wdSrc = require('fs').readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8');
    assert.match(wdSrc, /BOT_PARENT_PID:\s*String\(process\.pid\)/, '看门狗要注入自己的 pid');
    const idxSrc = require('fs').readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(idxSrc, /watchParentProcess\(/, 'bot 侧要开启父进程看护');
    assert.match(idxSrc, /watchdog-gone/, '父进程消失时走优雅退出');
});

// ---------------- 接线检查 ----------------

test('watchdog.js：重启用的是同一份 botArgs，且默认走 30 秒延迟', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8');
    assert.match(src, /spawn\(process\.execPath,\s*args,/, '应 spawn 子进程');
    assert.match(src, /const args = cfg\.entry \? \[cfg\.entry, \.\.\.cfg\.botArgs\]/, '重启参数必须来自同一份 botArgs');
    assert.match(src, /cfg\.restartDelayMs/, '重启延迟应来自配置');
    assert.match(src, /taskkill/, 'Windows 下强杀进程树');
    assert.match(src, /requestShutdownEndpoint/, '重启前应先请求 /shutdown 优雅退出');
});

test('healthServer.js：/shutdown 仅允许本机调用，并支持共享密钥', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'healthServer.js'), 'utf8');
    assert.match(src, /'\/shutdown'/, '应有 /shutdown 端点');
    assert.match(src, /remote === '127\.0\.0\.1'/, '必须校验来源为本机');
    assert.match(src, /x-shutdown-token/i, '应支持共享密钥');
    assert.match(src, /仅允许本机调用/, '非本机请求要拒绝');
});

test('index.js：/shutdown 与信号共用同一个幂等 gracefulShutdown', () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(src, /onShutdown:\s*\(\)\s*=>\s*gracefulShutdown\('POST \/shutdown'\)/, '看门狗出口接 gracefulShutdown');
    assert.match(src, /gracefulShutdownStarted/, '优雅关闭必须幂等（避免重复执行）');
    assert.match(src, /reportRestartFromWatchdog/, '启动后应播报看门狗重启');
});
