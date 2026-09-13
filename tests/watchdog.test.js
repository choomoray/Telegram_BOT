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

test('人工关闭（看门狗主动请求退出）不触发重启', () => {
    assert.strictEqual(decideAfterExit({ intentionalStop: true, exited: false }), 'stop');
});

test('看门狗自身正在退出时不重启', () => {
    assert.strictEqual(decideAfterExit({ intentionalStop: false, exited: true }), 'stop');
});

test('非人工退出一律视为崩溃并重启（含 exitCode=0 的意外退出）', () => {
    assert.strictEqual(decideAfterExit({ intentionalStop: false, exited: false }), 'restart');
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

// ---------------- 通知文案 ----------------

test('崩溃通知包含启动方式、原因、重启延迟与最后日志', () => {
    const text = notify.formatCrashReport({
        botArgs: ['webui'], mode: 'webui', timeText: '2026-09-13 21:30:00',
        reason: '进程异常退出（exitCode=1）', uptimeText: '2 小时 5 分',
        consecutive: 1, maxRestarts: 5, restartDelayMs: 30000,
        tail: ['[21:29:59] [ERRO] boom']
    });
    assert.match(text, /Bot 崩溃/);
    assert.match(text, /30 秒后自动重启/);
    assert.match(text, /node index\.js webui/, '要显示按哪种方式重启');
    assert.match(text, /exitCode=1/);
    assert.match(text, /boom/, '要带上最后日志');
    assert.match(text, /连续崩溃：1\/5/);
});

test('重启失败与停止重试的通知文案', () => {
    const failed = notify.formatRestartFailedReport({
        botArgs: ['test'], mode: 'test', timeText: '2026-09-13 21:30:00',
        reason: '进程异常退出（exitCode=1）', consecutive: 3, maxRestarts: 5, tail: []
    });
    assert.match(failed, /重启后未能就绪/);
    assert.match(failed, /node index\.js test/);

    const giveUp = notify.formatGiveUpReport({
        botArgs: ['webui'], mode: 'webui', consecutive: 6, maxRestarts: 5,
        restartWindowMs: 600000, reason: 'boom'
    });
    assert.match(giveUp, /停止自动重启/);
    assert.match(giveUp, /10 分钟内崩溃 6 次/);
    assert.match(giveUp, /node watchdog\.js webui/, '要告诉用户怎么重新启动看门狗');
});

test('缺少 token 时通知不抛错，而是返回错误说明', async () => {
    const res = await notify.sendToAdmins({ telegramToken: '', adminChatIds: [] }, 'hi');
    assert.strictEqual(res.sent, 0);
    assert.ok(res.errors.length > 0);
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

test('重启播报文案包含「已自动重启」与启动方式', () => {
    const crashNotify = require('../utils/crashNotify');
    const text = crashNotify.formatRestartReport({
        botArgs: ['webui'], mode: 'webui', timeText: '2026-09-13 21:30:00',
        reason: '进程异常退出（exitCode=1）', uptimeText: '1 分 2 秒',
        consecutive: 2, maxRestarts: 5, tail: ['[ERRO] boom']
    });
    assert.match(text, /已自动重启/);
    assert.match(text, /node index\.js webui/);
    assert.match(text, /连续崩溃：2\/5/);
    assert.match(text, /boom/);
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
