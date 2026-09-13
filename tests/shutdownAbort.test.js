// tests/shutdownAbort.test.js
/**
 * 启动阶段 Ctrl+C 必须能立即退出（回归测试）
 *
 * 曾经的 bug：`index.js` 的 SIGINT handler 是在 `start()` **之后**才注册的，
 * 而 `connectDB()` 的 6 次重试 × 5 秒里没有任何取消检查 —— 数据库连不上时
 * 按 Ctrl+C 会被 Node 静默吞掉（只要存在 SIGINT listener，默认退出行为就被取消），
 * 用户只能干等约 30 秒重试跑完。
 *
 * 修复分两层，本文件分别覆盖：
 *   1. `shutdown.js` 在 require 时就接管 SIGINT/SIGTERM，并区分启动期 / 启动完成后 / 关机中；
 *   2. `connectDB(retries, delay, signal)` 响应中止信号，能立刻停下来。
 *
 * 关于 Windows：`process.kill(pid, 'SIGINT')` 在 Windows 上走 TerminateProcess，
 * **不是** Ctrl+C 事件，因此无法在测试里真实投递 SIGINT。所以：
 *   - 决策规则用纯函数 `decideOnSignal` 确定性验证；
 *   - 中止契约用独立的 AbortController 验证（不依赖模块级状态）；
 *   - "真实信号投递"的集成用例只在 POSIX 上运行。
 *   这不影响被测逻辑：Ctrl+C 在 Windows 终端里同样会被 Node 转成 'SIGINT' 事件。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const shutdown = require('../shutdown');

// ---------------- 1. 信号决策规则（纯函数，跨平台确定性） ----------------

test('启动期收到信号 → abort（立即退出，不等重试跑完）', () => {
    assert.strictEqual(shutdown.decideOnSignal(false, false), 'abort');
});

test('启动完成后收到信号 → graceful（交给优雅关闭）', () => {
    assert.strictEqual(shutdown.decideOnSignal(false, true), 'graceful');
});

test('关机过程中再收到信号 → force（立即强制退出，避免关机卡住永久挂着）', () => {
    assert.strictEqual(shutdown.decideOnSignal(true, false), 'force');
    assert.strictEqual(shutdown.decideOnSignal(true, true), 'force');
});

test('SIGINT 与 SIGTERM 共用同一套决策（watchdog 用 SIGTERM 也能生效）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'shutdown.js'), 'utf8');
    assert.match(src, /process\.on\('SIGINT',\s*\(\)\s*=>\s*onSignal\('SIGINT'\)\)/, '注册 SIGINT');
    assert.match(src, /process\.on\('SIGTERM',\s*\(\)\s*=>\s*onSignal\('SIGTERM'\)\)/, '注册 SIGTERM');
});

// ---------------- 2. 中止信号契约（用独立 controller，不依赖模块级状态） ----------------

test('connectDB 传入已中止的信号时立即抛错，不发起连接', async () => {
    const { connectDB } = require('../database');
    const controller = new AbortController();
    controller.abort();

    const startedAt = Date.now();
    await assert.rejects(
        () => connectDB(20, 5000, controller.signal),
        (err) => {
            assert.strictEqual(err.aborted, true, '错误应带 aborted 标记（供调用方区分中止与真失败）');
            assert.match(err.message, /启动过程已中止/, '错误信息应说明是启动被中止');
            return true;
        }
    );
    assert.ok(Date.now() - startedAt < 2000, '应立即抛错，不应进入重试循环');
});

test('不传信号时 connectDB 保持旧行为（不受停机逻辑影响）', async () => {
    const { connectDB } = require('../database');
    const controller = new AbortController(); // 永不 abort：走完整重试后按普通失败抛出
    let error = null;
    try {
        // 用 0 次重试：只验证"没有信号 → 走到普通失败分支"，不触碰网络等待
        await connectDB(0, 10, controller.signal);
    } catch (err) {
        error = err;
    }
    assert.ok(error, '应抛出连接失败错误');
    assert.ok(!error.aborted, '未中止时应是普通错误');
    assert.match(error.message, /MongoDB 连接失败/, '应是普通连接失败信息');
});

test('停机信号能提前打断重试等待（sleepOrAbort 语义）', async () => {
    const { sleepOrAbort } = require('../database');

    // 1) 正常等待：约等于请求时长
    const t1 = Date.now();
    await sleepOrAbort(200, null);
    assert.ok(Date.now() - t1 >= 180, '无信号时应等满时长');

    // 2) 中途中止：应远早于请求的 5 秒
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const t2 = Date.now();
    await sleepOrAbort(5000, controller.signal);
    const elapsed = Date.now() - t2;
    assert.ok(elapsed < 1500, `中止应立刻结束等待，实际 ${elapsed}ms`);

    // 3) 已经是中止状态：立即返回，不等
    const aborted = new AbortController();
    aborted.abort();
    const t3 = Date.now();
    await sleepOrAbort(5000, aborted.signal);
    assert.ok(Date.now() - t3 < 100, '信号已中止时应立即返回');
});

// ---------------- 3. index.js / healthServer 接线（防止回归成"注册太晚"） ----------------

test('index.js 在启动前就 require shutdown 并把中止信号传给 connectDB', () => {
    const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    assert.match(src, /require\('\.\/shutdown'\)/, 'index.js 应引入 shutdown 模块（require 即接管信号）');
    assert.match(src, /connectDB\(6,\s*5000,\s*getAbortSignal\(\)\)/, 'connectDB 应传入中止信号');
    assert.match(src, /if \(isShuttingDown\(\)\)/, '中止时不应重复报"启动失败"');
    assert.match(src, /markStartupComplete\(\)/, '启动完成应标记（切换为优雅关闭）');
    // shutdown 的 require 必须早于 start() 调用
    const shutdownIdx = src.indexOf("require('./shutdown')");
    const startCallIdx = src.indexOf('\nstart();');
    assert.ok(shutdownIdx !== -1 && startCallIdx !== -1 && shutdownIdx < startCallIdx,
        'shutdown 必须在 start() 之前加载，否则启动期 Ctrl+C 仍会被吞掉');
});

test('healthServer 在端口监听成功后回调 onReady（用于标记启动完成）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'healthServer.js'), 'utf8');
    assert.match(src, /function startHealthServer\(port\s*=\s*9699,\s*getDbStatus,\s*opts\s*=\s*\{\}\)/, '需要 opts 参数');
    assert.match(src, /const \{ onReady, onShutdown, token = '' \} = opts/, 'opts 里解构 onReady/onShutdown/token');
    assert.match(src, /server\.listen\(port,\s*\(\)\s*=>\s*\{[\s\S]*?onReady\(\)/, 'listen 成功后才调 onReady');
    // DB 探测抛错也要有响应，否则外部监控会把"DB 挂了"误判成"进程卡死"
    assert.match(src, /catch\s*(?:\([^)]*\))?\s*\{[\s\S]*?dbStatus = 'disconnected'/, 'DB 探测异常时仍返回 disconnected');
});

// ---------------- 4. 真实信号投递（仅 POSIX；Windows 无法程序化投递 Ctrl+C） ----------------

test('真实 SIGINT：connectDB 立即中止并以 130 退出', {
    skip: process.platform === 'win32'
        ? 'Windows 无法在测试中投递真实 SIGINT（process.kill 走 TerminateProcess，非 Ctrl+C）'
        : false
}, async () => {
    const { spawn } = require('child_process');
    const script = `
        const shutdown = require('./shutdown');
        const { connectDB } = require('./database');
        const t0 = Date.now();
        process.stdout.write('START\\n');
        setTimeout(() => {
            process.stdout.write('SIGNAL_SENT\\n');
            process.kill(process.pid, 'SIGINT');
        }, 1200);
        connectDB(20, 5000, shutdown.getAbortSignal()).catch(err => {
            process.stdout.write('ABORTED ' + (Date.now() - t0) + ' aborted=' + !!err.aborted + '\\n');
        });
    `;
    const result = await new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', script], {
            cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                MONGODB_URI: 'mongodb://127.0.0.1:1/nope?serverSelectionTimeoutMS=500',
                TELEGRAM_BOT_TOKEN: 'x', ADMIN_CHAT_ID: '1'
            }
        });
        let out = '';
        child.stdout.on('data', d => { out += d.toString(); });
        child.on('close', (code) => resolve({ code, out }));
    });

    assert.match(result.out, /ABORTED \d+ aborted=true/, 'connectDB 应以中止形式结束');
    assert.strictEqual(result.code, 130, '启动期 Ctrl+C 应以 130 退出');
});
