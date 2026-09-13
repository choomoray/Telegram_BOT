// healthServer.js
const http = require('http');
const logger = require('./logger');

/**
 * 启动健康检查 HTTP 服务
 *
 * 端点：
 *   GET  /health   - 健康状态 JSON（看门狗轮询用）
 *   POST /shutdown - 请求进程优雅退出（看门狗重启前调用；**仅本机**且需共享密钥）
 *
 * Windows 上无法从另一个进程发送 SIGTERM/SIGINT（`taskkill`/`Stop-Process` 都是
 * TerminateProcess 硬杀，Node 收不到信号），因此提供一个 HTTP 出口走 gracefulShutdown，
 * 让看门狗重启前能正常关轮询、落盘日志、关数据库连接。
 *
 * @param {number} port - 监听端口
 * @param {Function} [getDbStatus] - 返回 DB 状态字符串（'connected' / 'disconnected'）
 * @param {Object} [opts] - { onReady, onShutdown, token }
 * @returns {http.Server}
 */
function startHealthServer(port = 9699, getDbStatus, opts = {}) {
    const { onReady, onShutdown, token = '' } = opts;
    let startedAt = null;
    const dbStatusOf = typeof getDbStatus === 'function' ? getDbStatus : () => 'unknown';

    const server = http.createServer(async (req, res) => {
        const send = (code, obj) => {
            const body = JSON.stringify(obj);
            res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(body);
        };

        if (req.url === '/health' && req.method === 'GET') {
            let dbStatus = 'unknown';
            try {
                dbStatus = await dbStatusOf();
            } catch (err) {
                // DB 探测本身抛错（连接断了等）不应让 /health 无响应：
                // 否则看门狗会把它当成"卡死"而不是"DB 不可用"
                dbStatus = 'disconnected';
                logger.warn(`健康检查 DB 探测失败: ${err.message}`);
            }
            return send(200, {
                status: 'ok',
                db: dbStatus,
                uptime: process.uptime(),
                startedAt,
                pid: process.pid
            });
        }

        if (req.url === '/shutdown' && req.method === 'POST') {
            // 只允许本机调用（本服务默认绑 0.0.0.0，必须自己判断来源）
            const remote = req.socket.remoteAddress || '';
            const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
            if (!isLocal) {
                logger.warn(`拒绝来自 ${remote} 的 /shutdown 请求（非本机）`);
                return send(403, { error: '仅允许本机调用' });
            }
            if (token) {
                const provided = req.headers['x-shutdown-token'] || '';
                if (provided !== token) {
                    logger.warn('拒绝 /shutdown 请求：密钥不匹配');
                    return send(403, { error: '密钥不匹配' });
                }
            }
            send(200, { ok: true, message: '正在优雅退出' });
            logger.info('收到 /shutdown 请求，开始优雅退出');
            if (typeof onShutdown === 'function') {
                // 等响应真正发出后再触发退出，避免客户端拿不到回复
                setImmediate(() => {
                    try {
                        onShutdown();
                    } catch (err) {
                        logger.error(`/shutdown 处理异常: ${err.message}`);
                    }
                });
            }
            return;
        }

        res.writeHead(404);
        res.end();
    });

    server.listen(port, () => {
        startedAt = Date.now();
        logger.info(`健康检查服务已启动，端口: ${port}`);
        if (typeof onReady === 'function') {
            try {
                onReady();
            } catch (err) {
                logger.warn(`健康检查启动回调失败: ${err.message}`);
            }
        }
    });

    return server;
}

module.exports = { startHealthServer };
