# ============================================================
# Telegram 媒体管理机器人 - Docker 镜像
# 构建：docker build -t telegram-bot:0.5.0 .
# ============================================================
FROM node:22-alpine

WORKDIR /app

# 1. 安装生产依赖（利用 Docker 层缓存，package.json 变更时才重装）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 2. 拷贝项目源码（.env 已被 .dockerignore 排除，配置全部走环境变量）
COPY . .

# 3. 非 root 用户运行（安全加固）
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /app/logs \
    && chown -R app:app /app
USER app

# 健康检查端口 9699，Web UI 面板端口 9700
EXPOSE 9699 9700

# 纯后端启动：node index.js
# 带 Web UI 启动：node index.js webui（docker-compose 默认使用 webui）
CMD ["node", "index.js"]
