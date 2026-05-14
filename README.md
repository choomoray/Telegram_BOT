# Telegram 媒体管理机器人

一个功能丰富的 Telegram Bot，基于 Node.js 开发，用于群组/频道媒体消息的自动收录、检索、回复与管理，并集成 AI 聊天智能体、群组管理和用户权限控制。

**版本:** 0.4.2 | **运行环境:** Node.js | **数据库:** MongoDB Atlas | **AI 接口:** DeepSeek API / LM Studio

---

## 目录

- [整体架构](#整体架构)
- [核心模块详解](#核心模块详解)
  - [入口与生命周期 — index.js](#1-入口与生命周期--indexjs)
  - [Bot 实例 — bot.js](#2-bot-实例--botjs)
  - [配置管理 — config.js](#3-配置管理--configjs)
  - [数据库连接 — database.js](#4-数据库连接--databasejs)
  - [日志系统 — logger.js](#5-日志系统--loggerjs)
  - [媒体处理 — media.js](#6-媒体处理--mediajs)
  - [用户状态 — states.js](#7-用户状态--statesjs)
  - [健康检查 — healthServer.js](#8-健康检查--healthserverjs)
  - [工具函数层 — utils/](#9-工具函数层--utils)
  - [数据库操作层 — db/](#10-数据库操作层--db)
  - [AI 集成层 — ai/](#11-ai-集成层--ai)
  - [业务处理层 — handlers/](#12-业务处理层--handlers)
- [数据流详解](#数据流详解)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [指令列表](#指令列表)
- [数据库设计](#数据库设计)
- [管理权限](#管理权限)

---

## 整体架构

项目采用经典的分层架构，自底向上分为五层：

```
┌─────────────────────────────────────────────────────┐
│                    Telegram API                       │
└───────────────────┬─────────────────────────────────┘
                    │ polling
┌───────────────────▼─────────────────────────────────┐
│                  bot.js                               │
│            (node-telegram-bot-api 实例)               │
└───────────────────┬─────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│                  index.js                             │
│          (事件监听注册、启动编排)                       │
└──┬──────────┬──────────┬──────────┬─────────────────┘
   │          │          │          │
   ▼          ▼          ▼          ▼
┌──────┐ ┌────────┐ ┌────────┐ ┌──────────┐
│私聊  │ │群组消息│ │回调查询│ │成员事件  │
│处理器│ │处理器  │ │处理器  │ │处理器    │
└──┬───┘ └──┬─────┘ └──┬─────┘ └──────────┘
   │        │          │
   ▼        ▼          ▼
┌─────────────────────────────────────────────────────┐
│               handlers/  业务逻辑层                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │commands/ │  │ modes/   │  │callbacks/│          │
│  │ 命令处理  │  │ 模式处理  │  │ 回调处理  │          │
│  └──────────┘  └──────────┘  └──────────┘          │
└─────────────────────────────────────────────────────┘
   │        │          │
   ▼        ▼          ▼
┌────────┐ ┌────────┐ ┌──────────┐
│  db/   │ │  ai/   │ │ utils/   │
│数据库层│ │AI集成层│ │工具函数层│
└────────┘ └────────┘ └──────────┘
```

**设计要点：**
- **单例模式：** bot.js 导出唯一的 Bot 实例，database.js 维护唯一的 MongoClient 连接，全局共享
- **事件驱动：** index.js 注册 Telegram 事件监听，按消息来源（私聊/群组/回调）分发给不同处理器
- **命令自动加载：** commands/index.js 自动扫描目录注册所有 /command 处理器
- **模式系统：** modes/ 实现"模式"概念——用户进入某种模式后，后续消息由对应模式处理器接管，直到 /exit 退出
- **AI 智能体循环：** AI 回复支持嵌入式指令（数据库查询、设置更新、命令执行等），通过递归解析器实现多轮 Agent 调用

---

## 核心模块详解

### 1. 入口与生命周期 — index.js

**路径:** `index.js` **职责:** 系统启动编排、全局事件注册、优雅关闭

**启动流程 (`start()` 函数)：**

```
connectDB() ──► initCollections() ──► loadSettings() ──► 创建Bot实例
    │                                                                │
    └──────────── 注册事件处理器 ────────────────────────────────────┘
                            │
                            ▼
                    启动健康检查服务器
                            │
                            ▼
                    记录启动日志 ──► 系统就绪
```

**事件注册详情：**

| 事件 | 处理器 | 触发时机 |
|------|--------|----------|
| `message` | `handlePrivateMessage` / `handleGroupMessage` | 收到新消息 |
| `edited_message` | `handleGroupEditedMessage` | 消息被编辑 |
| `callback_query` | `handleCallbackQuery` | 点击内联按钮 |
| `chat_member` | 自动处理用户加入/离开 | 群组成员变更 |
| `my_chat_member` | 自动注册 Bot 加入的群组 | Bot 被添加为管理员 |
| `chat_join_request` | 自动审批入群请求 | 用户申请加群 |

**实现机制：**
- 数据库就绪前收到的消息会被暂存到 `pendingMessages` 数组，就绪后批量处理
- MongoDB 连接失败时最多重试 6 次（约 30 秒），全部失败则进程退出
- 收到 SIGINT 信号时执行优雅关闭：关闭 MongoDB 连接、停止 polling
- 启动时记录 `BOT_START` 类型日志

---

### 2. Bot 实例 — bot.js

**路径:** `bot.js` **职责:** 创建并导出 Telegram Bot 实例

**实现：**
```javascript
const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, {
  polling: {
    params: {
      allowed_updates: [
        'message', 'edited_message', 'callback_query',
        'chat_member', 'my_chat_member', 'chat_join_request'
      ]
    }
  }
});
```

- 使用 `node-telegram-bot-api` v0.67.0 库
- 采用 **Long Polling** 模式（非 Webhook），适合部署在内网或无公网 IP 的环境
- 通过 `allowed_updates` 精确订阅所需更新类型，减少无效请求
- 捕获 polling 错误并输出日志，防止无异常崩溃
- 导出为单例，所有模块复用同一实例

---

### 3. 配置管理 — config.js

**路径:** `config.js` **职责:** 解析 .env 文件，导出全局配置常量

**实现机制：**
- 使用自定义同步解析器逐行读取 .env 文件（而非 dotenv 库）
- 支持 `#` 注释行和 `KEY=VALUE` 格式
- 自动去除值的前后引号
- `ADMIN_CHAT_ID` 被解析为 `number[]` 数组
- `--test` 命令行参数通过 `process.argv.includes('--test')` 检测

**导出的关键配置：**

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `TELEGRAM_BOT_TOKEN` | string | Bot Token |
| `MONGODB_URI` | string | 主数据库连接串 |
| `TEST_MONGODB_URI` | string | 测试数据库连接串 |
| `ADMIN_CHAT_IDS` | number[] | 管理员用户 ID 列表 |
| `DEEPSEEK_API_URL` | string | DeepSeek API 地址 |
| `DEEPSEEK_API_KEY` | string | DeepSeek API 密钥 |
| `DEEPSEEK_MODEL` | string | 模型名称 |
| `LMSTUDIO_API_URL` | string | LM Studio API 地址 |
| `LMSTUDIO_MODEL` | string | 本地模型名称 |
| `CONNECTION_POOL_MAX_SOCKETS` | number | HTTP 连接池最大套接字数 |

---

### 4. 数据库连接 — database.js

**路径:** `database.js` **职责:** 管理 MongoDB 连接生命周期

**实现机制：**

- 使用原生 `mongodb` v6.21.0 驱动（非 Mongoose）
- `connectDB()` 实现带指数退避的重试逻辑：
  - 重试次数：6 次
  - 每次间隔递增：5s → 10s → 15s → 20s → 25s
  - 总计最长等待约 30 秒
- 测试模式（`--test` 标志）下：
  - 数据库名添加 `_test` 后缀
  - 使用 `TEST_MONGODB_URI` 连接
- 导出 `getDb()` / `getClient()` / `getDatabaseName()` 供全局访问
- 连接关闭绑定到 SIGINT 信号处理

---

### 5. 日志系统 — logger.js

**路径:** `logger.js` **职责:** 带颜色的控制台输出 + 异步文件写入

**实现机制：**

- 使用 `chalk` 库实现彩色输出：
  - `error` → 红色背景，写入 `logs/error.log`
  - `warn` → 黄色，写入 `logs/operation.log`
  - `success` → 绿色，写入 `logs/operation.log`
  - `info` → 蓝色，写入 `logs/operation.log`
- 使用 `async` 库的异步队列（`async.queue`）实现有序文件写入，避免并发写入错乱
- 每条日志包含时间戳、日志级别、消息内容
- 日志目录 `logs/` 在首次写入时自动创建

---

### 6. 媒体处理 — media.js

**路径:** `media.js` **职责:** 从消息中提取媒体、发送媒体、管理媒体收集状态

**核心函数：**

| 函数 | 功能 | 实现要点 |
|------|------|----------|
| `extractMediaFromMessage(msg)` | 从消息中提取媒体信息 | 检测 photo/video/audio/document 类型，返回标准化媒体对象 |
| `sendMediaAsReply(chatId, replyId, media)` | 回复发送单个媒体 | 按 media_type 调用不同的 send 方法，附带原文链接按钮 |
| `sendMediaGroupAsReply(chatId, replyId, items, size)` | 批量发送媒体组 | 按 subgroup 分组发送，每批最多 10 条 |
| `clearMediaGroupState(userId, send, state)` | 清理收集状态并发送 | 将 `mediaCollection` 中的暂存媒体分批发出后清空 |
| `sendMediaSubgroup(chatId, groupId, subgroup)` | 发送指定子组 | 直接查询数据库获取指定 subgroup 的媒体列表 |
| `sendMediaGroup(chatId, groupId)` | 发送完整媒体组 | 遍历所有 subgroup 逐批发送 |

**媒体收集流程（mediaCollection）：**
1. 用户进入 `media_group` / `media_hide` / `media_unhide` 模式
2. 后续发送的媒体文件暂存到 `states.mediaCollection` 数组
3. 调用 `clearMediaGroupState()` 将收集的媒体批量发送到目标群组
4. 发送完成后清空收集状态

---

### 7. 用户状态 — states.js

**路径:** `states.js` **职责:** 管理用户的内存状态（模式、活动时间、临时数据）

**实现机制：**

```javascript
const states = new Map();  // key: userId (number), value: state object
```

**状态对象结构：**
```javascript
{
  mode: 'chat' | 'media_group' | 'search' | 'delete' | ...,  // 当前模式
  lastActivity: Date.now(),     // 最后活动时间戳
  ...data                      // 模式相关的任意数据（由各模式自行定义）
}
```

**超时机制：**
- `getUserState(userId)` 检测到 `lastActivity` 超过 10 分钟时自动删除状态并返回 `null`
- `updateUserActivity(userId)` 手动刷新活动时间
- 超时检测仅在访问状态时触发，无后台定时扫描

**状态管理函数：**

| 函数 | 说明 |
|------|------|
| `getUserState(userId)` | 获取状态，超时自动清理 |
| `getRawUserState(userId)` | 获取原始状态，不检测超时 |
| `setUserState(userId, state)` | 设置/覆盖状态 |
| `deleteUserState(userId)` | 删除状态 |
| `updateUserActivity(userId)` | 更新最后活动时间 |

> **注意：** 状态存储在内存中，Bot 重启后所有状态丢失。这是有意设计——用户状态不需要持久化。

---

### 8. 健康检查 — healthServer.js

**路径:** `healthServer.js` **职责:** 提供 HTTP 健康检查端点

**实现：**
- 监听端口 `9699`
- `GET /health` 返回 JSON：
```json
{
  "status": "ok",
  "db": "connected",
  "uptime": 12345
}
```
- 用于 Docker/K8s 健康检查或外部监控
- 服务器启动失败不阻塞 Bot 主流程

---

### 9. 工具函数层 — utils/

**路径:** `utils/` **职责:** 提供各模块共享的通用工具函数

#### queryParser.js — 查询条件解析

将用户输入的查询字符串解析为结构化查询条件。

**语法支持：**
```
-V         排除视频
-P         排除图片
+S         仅搜索 #S 等级
A+/B+/...  搜索指定等级及以上的内容
关键字      文本模糊搜索
```

**实现：**
```javascript
// 输出结构
{
  text: '关键字',
  excludeVideo: true,
  excludePhoto: false,
  level: 'S',
  levelDirection: 'up'  // 'exact' | 'up' | 'down'
}
```

#### queryFormatter.js — 查询结果格式化

将数据库查询结果格式化为分页显示的消息文本和内联键盘。

**实现要点：**
- 生成带编号的媒体列表文本（标题、类型、等级、日期）
- 构建翻页键盘（`buildFoldKeyboard`）：`◀ 1/5 ▶` 格式
- 构建编号键盘（`buildNumberKeyboard`）：1-10 编号按钮，用于精确定位
- 结果过多时自动截断并提示

#### queryCache.js — 查询结果分页缓存

**实现机制：**
- 每个查询会话用 `Map<sessionId, {results, totalPages, createdAt}>` 存储
- TTL（生存时间）：60 秒，过期自动清理
- `createSession(userId, results)` → 返回 `sessionId`
- `getPageResults(sessionId, page)` → 返回指定页的结果切片

#### chatIdConverter.js — chat_id 链接转换

将 Telegram 的 `chat_id`（如 `-100123456789`）转换为可点击的 `t.me` 链接格式：
- 私聊：`t.me/c/chat_id/message_id`
- 公开群组/频道：`t.me/username/message_id`

#### groupGenerator.js — group_id 生成

```javascript
// 消息体格式：-100123456789_123（chat_id_message_id）
// 媒体组格式：-100123456789_mediaGroupId
function generateGroupIdFromMessage(msg) { ... }
```

#### levelExtractor.js — 等级标记提取

从消息文本中提取等级标签并移除：
- 支持标签：`#S` `#A` `#B` `#C` `#D`
- 提取后从文本中移除标签后缀
- 无标签时默认 `#D`

#### sanitize.js — HTML 转义

对 Telegram API 支持的 HTML 格式进行安全转义：
- `&` → `&amp;`
- `<` → `&lt;`
- `>` → `&gt;`

#### sendMedia.js — 通用媒体组发送

封装 `bot.sendMediaGroup()`，处理媒体组发送的边界情况：
- 分批发送（Telegram 限制每批最多 10 条）
- 错误重试

#### modeNames.js — 模式名称映射

维护模式标识符到中文名称的映射表：
```javascript
module.exports = {
  'chat': 'AI 聊天',
  'media_group': '媒体合并',
  'search': '搜索',
  // ...
};
```

#### loadSystemPrompt.js — AI 系统提示加载

从 `ai/AI Read/` 目录读取 Markdown 文件，拼接为 AI 系统提示词。

#### enterMode.js — 模式切换清理

切换模式前的通用清理逻辑：
1. 获取当前状态（如果存在）
2. 调用旧模式的退出处理（如有需要）
3. 清理状态数据
4. 设置新模式

#### safeApiCall.js — API 自动重试

**重试策略：**
- 触发条件：HTTP 429（请求过多）或 5xx（服务器错误）
- 重试次数：3 次
- 间隔：1 秒
- 超出重试次数后抛出最终错误

---

### 10. 数据库操作层 — db/

**路径:** `db/` **职责:** 封装 MongoDB 集合操作，提供 CRUD 接口

#### db/index.js — 索引初始化

在 `connectDB()` 后调用，为每个集合创建必要索引：

| 集合 | 索引 | 用途 |
|------|------|------|
| `message` | `file_unique_id` (唯一) | 去重 |
| `message` | `group_id` | 按组查询 |
| `message` | `{media_type, level, text}` | 全文搜索 |
| `media` | `file_unique_id` (唯一) | 去重 |
| `media` | `{group_id, message_id}` | 按组查询 |
| `media` | `media_type` | 类型筛选 |
| `media` | `video_time` | 视频时长筛选 |
| `group_list` | `group_id` (唯一) | 组汇总 |
| `channel_group` | `id` (唯一) | 群组标识 |
| `users` | `id` (唯一) | 用户标识 |
| `users` | `group` | 所在群组查询 |
| `users` | `{state, white}` | 权限筛选 |
| `log` | `time` (倒序) | 时间排序 |
| `transport` | `chat_id` (唯一) | 搬运记录 |

#### db/settings.js — 全局设置（含缓存）

**实现要点：**
- 使用固定 `_id: "app_settings"` 的单文档存储
- `getSettings()` 带 5 秒内存缓存，减少数据库请求
- `loadSettings(config)` 启动时将 DB 中的设置注入 config 对象
- `updateSetting(config, key, value)` 更新后主动刷新缓存
- 所有设置项有合理的默认值

**可配置项：**

| 键 | 类型 | 默认值 | 说明 |
|----|------|--------|------|
| `STREAM_OUTPUT` | boolean | true | AI 是否流式输出 |
| `STREAM_UPDATE_INTERVAL` | number | 500 | 流式刷新间隔(ms) |
| `search_level` | boolean | false | 搜索是否按等级显示 |
| `search_random` | boolean | false | 是否随机搜索结果 |
| `random_pictures` | boolean | false | 随机图片功能开关 |
| `random_pictures_num` | number | 9 | 随机图片数量 |
| `random_videos` | boolean | false | 随机视频功能开关 |
| `random_videos_time` | string | "<1min" | 视频时长筛选条件 |
| `random_videos_num_text` | number | 15 | 随机视频文字列表数 |
| `random_videos_num_video` | number | 10 | 随机视频实际发送数 |
| `media_group_num` | number | 10 | 媒体合并默认数量 |

#### db/media.js — 媒体文件记录

核心数据操作：

| 函数 | 功能 |
|------|------|
| `insertMedia(mediaRecord)` | 插入新的媒体记录 |
| `findMediaByFileUniqueId(fileUniqueId)` | 按 file_unique_id 精确查询 |
| `findMediaByGroupId(groupId)` | 按 group_id 查询所有媒体 |
| `getMaxSubgroup(groupId)` | 获取指定组的最大子组编号 |
| `deleteMediaByFileUniqueId(fileUniqueId)` | 按 file_unique_id 删除 |
| `updateMediaPassword(fileUniqueId, pwd)` | 更新媒体密码 |

#### db/message.js — 消息记录

| 函数 | 功能 |
|------|------|
| `upsertMessage(messageRecord)` | 插入或更新消息记录 |
| `findMessageByFileUniqueId(fileUniqueId)` | 按 file_unique_id 查询 |
| `deleteMessageByFileUniqueId(fileUniqueId)` | 删除消息 |
| `findMessagesByGroupId(groupId)` | 按组查询所有消息 |

#### db/groupList.js — 媒体组汇总

| 函数 | 功能 |
|------|------|
| `upsertGroupList(groupId, increment)` | 原子增加 `is_group` 计数（$inc） |
| `setGroupDelete(groupId, timestamp)` | 设置删除标记 |
| `findGroupList(groupId)` | 查询组信息 |
| `deleteGroupList(groupId)` | 删除组记录 |

#### db/channelGroup.js — 频道/群组

| 函数 | 功能 |
|------|------|
| `upsertChannelGroup(channelGroup)` | 插入或更新 |
| `getAllChannelGroups()` | 获取所有管理的群组/频道 |
| `getChannelGroupById(id)` | 按 chat_id 查询 |
| `updateChannelGroup(id, updates)` | 单字段更新 |
| `deleteChannelGroup(id)` | 删除记录 |

#### db/users.js — 用户管理

**权限模型：**
- `state: 1` = 正常, `state: 0` = 封禁
- `white: 1` = 白名单, `white: 0` = 未白名单
- 用户同时满足 `state: 1` 且 `white: 1` 才可使用私聊功能

**封禁机制：**
- `banUserFully(userId)` 不仅设置数据库状态，还主动将用户从所有管理群组中踢出
- `removeUserFromGroup()` 在用户离开群组时触发自动封禁（用于防撤回退群）

#### db/transport.js — 搬运链接

| 函数 | 功能 |
|------|------|
| `upsertTransport(transport)` | 插入或更新搬运记录 |
| `getAllTransports()` | 获取所有搬运源 |
| `getTransportByChatId(chatId)` | 按 chat_id 查询 |
| `deleteTransport(chatId)` | 删除搬运记录 |
| `extractChatInfo(url, bot)` | 从 t.me 链接解析出群组 chat_id 和名称 |

#### db/log.js — 操作日志

通过 `insertLog(type, userId, extra)` 记录 25 种操作类型：

| 类型 | 值 | 说明 |
|------|----|------|
| BOT_START | 0 | 机器人启动 |
| MEDIA_SAVE | 1 | 媒体入库 |
| MEDIA_EDIT | 2 | 媒体编辑 |
| MEDIA_DELETE | 3 | 媒体删除 |
| ... | ... | 共 25 种类型 |

---

### 11. AI 集成层 — ai/

**路径:** `ai/` **职责:** 封装 AI 模型的 API 调用

#### ai/deepseek.js — DeepSeek API 客户端

**实现要点：**
- 使用 `axios` 发起 HTTP 请求，连接池配置 keep-alive
- 支持两种模式：
  - `callDeepSeekStream(messages, onChunk, onDone)` — SSE 流式解析，逐块回调
  - `callDeepSeek(messages)` — 非流式，等待完整响应
- 兼容标准 OpenAI Chat Completions API 格式
- 可通过环境变量配置 API 地址、密钥和模型名
- 支持 `thinking` 模式（temperature 设为 0.2，适用于推理任务）

#### ai/lmstudio.js — LM Studio API 客户端

**实现要点：**
- 与 deepseek.js 相同的接口签名，方便切换
- 默认连接 `http://localhost:1234/v1/chat/completions`
- 无 API 密钥（本地部署）
- 支持流式和非流式两种模式

#### ai/AI Read/ — AI 知识库

三个 Markdown 文件构成 AI 助手的系统提示知识库：

| 文件 | 内容 |
|------|------|
| `00-core.md` | 核心规则：AI 的身份定位、行为准则、交互格式 |
| `01-commands.md` | 命令文档：所有 Telegram 命令的用途和用法 |
| `02-database.md` | 数据库模式：集合结构、字段说明、查询示例 |

AI 可以通过 `[LOAD 文件名]` 指令动态加载这些知识库文件。

---

### 12. 业务处理层 — handlers/

**路径:** `handlers/` **职责:** 实现具体的业务逻辑

#### handlers/messageHandlers.js — 私聊消息入口

**处理流程：**
```
收到私聊消息
    │
    ├── 管理员检查 (isAdmin)
    │   ├── 是 → 继续处理
    │   └── 否 → 检查白名单/封禁状态
    │       ├── 允许 → 继续
    │       └── 拒绝 → 回复权限错误
    │
    ├── 命令检查 (以 / 开头)
    │   ├── 是 → executeCommand() → commands/index.js
    │   └── 否 → 检查当前模式
    │       ├── 有模式 → handleModeMessage() → modes/index.js
    │       └── 无模式 → handleQuery() 按文本搜索
```

**权限判定顺序：** 管理员 > 白名单用户 > 被封禁用户

#### handlers/groupMessageHandlers.js — 群组消息处理

**媒体收录流程 (`handleNewMediaMessage`)：**
```
收到群组媒体消息
    │
    ├── 提取媒体信息 (extractMediaFromMessage)
    ├── 提取等级标记 (extractLevel)
    ├── 生成 group_id (generateGroupIdFromMessage)
    │
    ├── 去重检查
    │   ├── 已存在 → 回复 "已收录"
    │   └── 不存在 → 继续
    │
    ├── 数据库操作（三步写入）
    │   ├── upsertGroupList (组汇总，$inc)
    │   ├── insertMedia (媒体记录)
    │   └── upsertMessage (消息记录)
    │
    └── 失败时逆序回滚 (rollback)
```

**编辑同步：**
- `handleGroupEditedMessage` 检测消息编辑事件
- 文本编辑 → 更新数据库中对应的 message 记录
- 媒体删除 → 同步删除数据库记录

**文本消息处理：**
- 管理员文本 → 检测命令 → 检测模式 → 关键字搜索
- 非管理员文本 → 忽略

#### handlers/callbackHandler.js — 回调查询入口

将 Telegram 的 `callback_query` 事件转发到 `callbacks/index.js` 处理。

#### handlers/queryHandler.js — 关键字查询

**处理流程：**
```
用户输入查询文本
    │
    ├── queryParser.parseQuery(text) → 结构化条件
    ├── 数据库模糊查询 (按 media_type, level, text 筛选)
    ├── queryCache.createSession() → 缓存结果
    ├── queryFormatter.formatQueryResults() → 格式化为分页文本
    └── 发送带翻页键盘的消息
```

**分页机制：**
- 每页默认 10 条结果
- 翻页通过 `pageCallback.js` 处理
- 结果缓存 60 秒 TTL
- 支持类型筛选、等级筛选、随机排序

#### handlers/commands/ — 命令处理

**自动加载机制（commands/index.js）：**
```javascript
// 自动扫描 commands 目录，将每个 .js 文件注册为命令
const commandFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && f !== 'index.js');
const commandMap = {};
for (const file of commandFiles) {
  const commandName = path.basename(file, '.js');  // chat.js → 'chat'
  commandMap[commandName] = require(`./${file}`);
}
```

**命令列表：**

| 命令 | 文件 | 功能 | 实现要点 |
|------|------|------|----------|
| `/chat` | chat.js | AI 聊天模式 | 设置 mode=chat，后续消息转发到 chatMode |
| `/clean` | clean.js | 数据库清理模式 | 扫描空数据的 group_list，批量删除 |
| `/delete` | delete.js | 删除单一媒体 | 进入 delete 模式，等待用户发送媒体或链接 |
| `/delete_group` | deleteGroup.js | 删除整个媒体组 | 进入 deleteGroup 模式，等待用户操作 |
| `/edit` | edit.js | 编辑消息文本 | 进入 edit 模式，等待用户选择要编辑的消息 |
| `/exit` | exit.js | 退出当前模式 | 调用 deleteUserState 清理状态 |
| `/help` | help.js | 显示命令按钮 | 发送带所有命令的内联键盘 |
| `/log` | log.js | 操作统计 | 从 log 集合聚合统计并展示 |
| `/manage` | manage.js | 管理面板 | 进入 manage 模式，显示管理主菜单 |
| `/mark` | mark.js | 标记模式 | 增加 group_list 的 mark 计数 |
| `/media_group` | mediaGroup.js | 媒体合并模式 | 进入 mediaCollect 模式，type=media_group |
| `/media_hide` | mediaHide.js | 媒体遮罩模式 | 进入 mediaCollect 模式，type=media_hide |
| `/media_unhide` | mediaUnhide.js | 去遮罩模式 | 进入 mediaCollect 模式，type=media_unhide |
| `/message_reply` | messageReply.js | 消息回复 | 进入 messageReply 模式，按编号选择消息回复 |
| `/password` | password.js | 媒体密码 | 进入 password 模式，设置/更新媒体访问密码 |
| `/random_pictures` | randomPictures.js | 随机图片 | 查询 media_type=photo 的随机结果 |
| `/random_videos` | randomVideos.js | 随机视频 | 可按时长筛选，支持文字列表和实际视频发送 |
| `/search` | search.js | 搜索模式 | 进入 search 模式，后续消息全部作为查询 |
| `/setting` | setting.js | 全局设置 | 进入 setting 模式，显示设置面板内联键盘 |
| `/transport` | transport.js | 搬运管理 | 进入 transport 模式，管理搬运链接的 CRUD |

#### handlers/modes/ — 模式系统

**模式分发（modes/index.js）：**
```javascript
function handleModeMessage(userId, msgText, msg, userName) {
  const state = getUserState(userId);
  switch (state.mode) {
    case 'chat': return handleChatMode(userId, msgText, msg, userName);
    case 'search': return handleSearchMode(userId, msgText, msg);
    case 'media_group':
    case 'media_hide':
    case 'media_unhide':
      return handleMediaCollectMode(userId, msg, state);
    // ... 其他模式
  }
}
```

**chatMode/ — AI 聊天模式（最复杂的子系统）**

```
用户发送消息
    │
    ├── aiQueue.enqueue(userId, task)  → 串行化请求
    │
    ├── chatMode/index.js
    │   ├── 构建消息上下文 (系统提示 + 历史消息)
    │   ├── callModel() → 模型调用 (带自动故障切换)
    │   │   ├── DeepSeek (流式/非流式)
    │   │   └── LM Studio (流式/非流式)
    │   │
    │   ├── 流式输出: 每 500ms 更新一次消息文本
    │   │
    │   └── processAIReply() → AI 回复处理
    │       │
    │       ├── parseAIReply() → 拆分为 @bot, @ai, @user 块
    │       │
    │       ├── extractCommands() → 提取嵌入式指令
    │       │   ├── [CMD /xxx] → 执行 Telegram 命令
    │       │   ├── [LOAD file] → 加载知识库文件
    │       │   ├── [DB query] → 执行数据库查询
    │       │   ├── [DB:update ...] → 执行数据库更新
    │       │   ├── [QUERY ...] → 关键字搜索
    │       │   ├── [GET ...] → 获取媒体信息
    │       │   └── [BUTTON ...] → 模拟按钮点击
    │       │
    │       └── 结果反馈给 AI → 继续递归处理 (最多 3 轮)
    │
    └── 最终 @user 块显示给用户
```

**AI 请求队列 (aiQueue.js)：**
- 每个用户独立队列，保证同一用户的 AI 请求顺序执行
- 正在处理中的请求不会被新请求打断
- 使用 `async/await` 实现，非传统的 callback 队列

**模型自动故障切换 (modelCall.js)：**
- 优先使用 DeepSeek（远程 API）
- DeepSeek 失败 → 自动回退到 LM Studio（本地模型）
- 用户可通过内联按钮手动选择/切换模型

**manage/ — 管理面板**

```
manage/index.js
    │
    ├── showMainMenu() → 显示管理主菜单按钮
    │   ├── 群组管理 → manage/groups.js
    │   ├── 用户管理 → manage/users.js
    │   ├── 白名单管理 → manage/whitelist.js
    │   └── 系统概览 → manage/dashboard.js
    │
    ├── groups.js: 群组 CRUD（添加、编辑、绑定、删除）
    ├── users.js: 用户封禁/解封（支持全平台封禁）
    ├── whitelist.js: 白名单添加/移除
    └── dashboard.js: 系统统计概览（群组数、媒体数、用户数等）
```

#### handlers/callbacks/ — 回调处理

**回调分发（callbacks/index.js）：**
```javascript
// 静态前缀映射
const callbackMap = {
  'media_': mediaCallback,
  'direct_': directCallback,
  'direct_confirm_': directConfirmCallback,
  'page_': pageCallback,
  'toggle_': toggleCallback,
  'random_show_': randomShowCallback,
  'clean_': cleanCallback,
  'clean_continue_': cleanContinueCallback,
  'select_model': selectModel,
  'switch_model_': switchModel,
  'toggle_thinking': toggleThinking,
  'retry_model_': retryModel,
  'exec_cmd_': execCmd,
};

// 动态前缀检测（格式: prefix_data）
const dynamicPrefixes = ['manage_', 'set_', 'pwd_'];
```

**各回调处理器：**

| 回调 | 功能 |
|------|------|
| `mediaCallback.js` | 显示指定媒体（按编号从缓存中获取） |
| `directCallback.js` | 快捷查看（直接从查询结果获取） |
| `directConfirmCallback.js` | 确认快捷查看 |
| `pageCallback.js` | 翻页操作（上一页/下一页/指定页） |
| `toggleCallback.js` | 切换查询设置（显示模式/排序方式） |
| `randomShowCallback.js` | 随机结果显示切换 |
| `cleanCallback.js` | 清理模式确认/取消 |
| `cleanContinueCallback.js` | 清理完成后继续/退出 |
| `selectModel.js` | AI 模型选择 |
| `switchModel.js` | AI 模型切换 |
| `toggleThinking.js` | AI 思考模式开关 |
| `retryModel.js` | AI 重试（切换模型重试） |
| `execCmd.js` | 执行指定命令 |

---

## 数据流详解

### 场景一：媒体入库（群组消息 → 数据库）

```
用户发送图片到群组
    │
    ▼
bot.on('message')
    │
    ▼
handleGroupMessage()
    │
    ├── 判断消息包含媒体 ──► handleNewMediaMessage()
    │   │
    │   ├── extractMediaFromMessage(msg)    → { file_id, file_unique_id, media_type }
    │   ├── extractLevel(text)              → { level, cleanText }
    │   ├── generateGroupIdFromMessage(msg) → group_id
    │   │
    │   ├── 查重: findMediaByFileUniqueId(file_unique_id)
    │   │   ├── 已存在 → 回复 "已收录" + 原文链接
    │   │   └── 不存在 → 继续
    │   │
    │   ├── upsertGroupList(group_id, 1)    → 组计数 +1
    │   ├── insertMedia({...})              → 写入媒体记录
    │   ├── upsertMessage({...})            → 写入消息记录
    │   ├── insertLog(MEDIA_SAVE, ...)      → 记录操作日志
    │   │
    │   └── 回复 "收录成功"
    │
    └── 判断消息为文本 ──► 管理员检查
        ├── 是 → 命令/模式/查询
        └── 否 → 忽略
```

### 场景二：用户私聊搜索（关键字 → 分页结果）

```
用户在私聊中发送 "关键词"
    │
    ▼
handlePrivateMessage()
    │
    ├── 管理员检查 ✓
    ├── 非命令、非模式 → handleQuery(userId, text)
    │
    ▼
handleQuery()
    │
    ├── queryParser.parseQuery(text)
    │   → { text: '关键词', excludeVideo: false, level: null }
    │
    ├── 数据库查询（模糊匹配 text, media_type, level）
    │
    ├── queryCache.createSession(userId, results)
    │   → sessionId
    │
    ├── queryFormatter.formatQueryResults(results, page=1)
    │   → { text, keyboard }
    │
    └── bot.sendMessage(chatId, text, { reply_markup: keyboard })
        │
        └── 用户点击翻页
            │
            ▼
            pageCallback → getPageResults(sessionId, 2)
                         → formatQueryResults(results, page=2)
                         → bot.editMessageReplyMarkup(...)
```

### 场景三：AI 聊天（用户消息 → 模型调用 → 嵌入式指令执行）

```
用户在聊天模式发送消息
    │
    ▼
handleChatMode()
    │
    ├── aiQueue.enqueue(userId, async () => {
    │   ├── 构建 messages 数组
    │   │   ├── system prompt (loadSystemPrompt + 知识库)
    │   │   └── 对话历史 (最近 N 轮)
    │   │
    │   ├── callModel(messages, onChunk)
    │   │   ├── 尝试 DeepSeek (流式)
    │   │   ├── 失败 → 回退 LM Studio (流式)
    │   │   ├── onChunk: 每 500ms 更新消息文本
    │   │   └── onDone: 返回完整文本
    │   │
    │   └── processAIReply(fullText)
    │       │
    │       ├── parseAIReply → @bot, @ai, @user 块
    │       │
    │       ├── @bot 块 → extractCommands()
    │       │   ├── [QUERY xxx] → handleQuery(xxx) → 结果回填
    │       │   ├── [DB:query xxx] → dbOperations.query(xxx) → 结果回填
    │       │   ├── [CMD /xxx] → executeCommand(xxx)
    │       │   └── [LOAD xxx] → 读取知识库 → 回填
    │       │
    │       ├── @ai 块 → 继续递归 (最多 3 轮)
    │       │
    │       └── @user 块 → 最终显示给用户
    │   })
    └──
```

### 场景四：群组消息编辑同步

```
用户在群组中编辑了一条已收录的消息
    │
    ▼
handleGroupEditedMessage()
    │
    ├── 提取 file_unique_id
    ├── 检测文本变化
    │   ├── 文本更新 → extractLevel → upsertMessage (更新文本)
    │   └── 文本清空 → upsertMessage (清空文本)
    │
    ├── 检测媒体变化
    │   ├── 原媒体被删除 → deleteMessageByFileUniqueId
    │   │                  → 联动处理 group_list 计数
    │   └── 新媒体替换 → 插入新记录
    │
    └── 记录 MEDIA_EDIT 日志
```

---

## 快速开始

1. **克隆项目并安装依赖：**
   ```bash
   npm install
   ```

2. **创建 `.env` 文件：**
   ```
   TELEGRAM_BOT_TOKEN=your_bot_token
   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net
   ADMIN_CHAT_ID=123456789,987654321
   ```

3. **启动机器人：**
   ```bash
   node index.js          # 正常模式
   node index.js --test   # 测试模式（使用测试数据库）
   ```

---

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | 是 | BotFather 获取的 Token |
| `MONGODB_URI` | 是 | MongoDB Atlas 连接串 |
| `TEST_MONGODB_URI` | 否 | 测试数据库连接串 |
| `ADMIN_CHAT_ID` | 是 | 管理员 Telegram 用户 ID，多个用逗号分隔 |
| `DEEPSEEK_API_URL` | 否 | DeepSeek API 地址 |
| `DEEPSEEK_API_KEY` | 否 | DeepSeek API 密钥 |
| `DEEPSEEK_MODEL` | 否 | DeepSeek 模型名 |
| `LMSTUDIO_API_URL` | 否 | LM Studio API 地址 |
| `LMSTUDIO_MODEL` | 否 | LM Studio 模型名 |
| `CONNECTION_POOL_MAX_SOCKETS` | 否 | HTTP 连接池最大套接字数 |

---

## 指令列表

### 私聊命令（仅管理员可用）

| 命令 | 功能 | 所属模块 |
|------|------|----------|
| `/chat` | AI 聊天模式（支持模型选择/切换） | modes/chatMode/ |
| `/media_group` | 媒体合并模式 | modes/mediaCollectMode.js |
| `/media_hide` | 媒体遮罩模式（Spoiler） | modes/mediaCollectMode.js |
| `/media_unhide` | 媒体去遮罩模式 | modes/mediaCollectMode.js |
| `/message_reply` | 在群组中回复指定消息 | modes/messageReplyMode.js |
| `/search` | 进入搜索模式 | modes/searchMode.js |
| `/delete` | 删除单一媒体 | modes/deleteMode.js |
| `/delete_group` | 删除整个媒体组 | modes/deleteGroupMode.js |
| `/clean` | 数据库清理模式 | modes/cleanMode.js |
| `/random_videos` | 随机获取视频 | commands/randomVideos.js |
| `/random_pictures` | 随机获取图片 | commands/randomPictures.js |
| `/mark` | 标记模式（增加 mark 计数） | modes/markMode.js |
| `/edit` | 编辑消息文本或清空 | modes/editMode.js |
| `/log` | 查看操作统计 | commands/log.js |
| `/help` | 显示命令列表按钮 | commands/help.js |
| `/setting` | 全局设置面板 | modes/settingMode.js |
| `/transport` | 搬运链接管理 | modes/transportMode.js |
| `/password` | 媒体文件密码设置 | modes/passwordMode.js |
| `/manage` | 管理面板（群组/用户/白名单） | modes/manage/ |
| `/exit` | 退出当前模式 | commands/exit.js |

### 群组/频道自动功能

| 功能 | 说明 |
|------|------|
| 媒体自动收录 | 带等级标记的消息自动入库，支持去重 |
| 编辑同步 | 消息编辑/删除后自动同步数据库 |
| 关键字查询 | 管理员在群组中发送文本自动搜索 |
| 成员记录 | 加入/退出自动记录，可配置封禁策略 |
| 入群审批 | 关联频道的用户自动通过加群申请 |

---

## 数据库设计

### 集合总览

| 集合 | 存储内容 | 文档数 |
|------|----------|--------|
| `message` | 消息元数据（文本、类型、等级） | 与媒体一一对应 |
| `media` | 媒体文件记录（file_id、密码） | 每条媒体一条记录 |
| `group_list` | 媒体组汇总信息 | 每组一条 |
| `channel_group` | 管理的群组/频道 | 每个群组/频道一条 |
| `users` | 用户信息及权限 | 每个用户一条 |
| `log` | 操作审计日志 | 每次操作一条 |
| `transport` | 搬运源链接 | 每个搬运源一条 |
| `settings` | 全局设置（单文档） | 固定1条 |

详情参见 `ai/AI Read/02-database.md`。

---

## 管理权限

### 权限层级

```
管理员 (ADMIN_CHAT_IDS)
  ├── 所有私聊命令
  ├── 所有群组管理操作
  └── 管理面板
       │
白名单用户 (white: 1)
  ├── 私聊搜索
  └── 基础查询功能
       │
普通用户 (state: 1)
  └── 群组内自动收录（无管理权限）
       │
被封禁用户 (state: 0)
  └── 无法加入任何管理群组
       │
未授权用户
  └── 私聊收到 "权限错误" 提示
```

### 群组审批逻辑

用户申请加群时：
1. 检查是否被封禁 → 是则拒绝
2. 检查是否已加入关联频道 → 否则拒绝
3. 通过 → 自动批准入群
