// healthServer.js
const http = require('http');
const logger = require('./logger');

function startHealthServer(port = 9699, getDbStatus) {
    const server = http.createServer(async (req, res) => {
        if (req.url === '/health') {
            const dbStatus = getDbStatus ? getDbStatus() : 'unknown';
            const status = {
                status: 'ok',
                db: dbStatus,
                uptime: process.uptime()
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status));
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    server.listen(port, () => {
        logger.info(`健康检查服务已启动，端口: ${port}`);
    });

    return server;
}

module.exports = { startHealthServer };