# Telegram 媒体管理机器人

一个功能丰富的 Telegram Bot，基于 Node.js 开发，用于群组/频道媒体消息的自动收录、检索、回复与管理，并集成群组管理和用户权限控制。

**版本:** 0.5.9 | **运行环境:** Node.js | **数据库:** MongoDB Atlas

---

## 快速开始

1. **克隆项目并安装依赖：**

   ```bash
   npm install
   ```

2. **配置环境变量：**

   复制模板文件并填写自己的配置（所有变量说明见文件内注释）：

   ```bash
   cp .env.example .env
   ```

   或手动创建 `.env` 文件，最少需要以下三项：

   ```
   TELEGRAM_BOT_TOKEN=从 @BotFather 获取的 Token
   MONGODB_URI=mongodb+srv://用户:密码@集群.mongodb.net/
   ADMIN_CHAT_ID=向 @userinfobot 获取的 ID
   ```

3. **启动机器人：**

   ```bash
   node index.js          # 正常模式
   node index.js --test   # 测试模式（使用测试数据库 TEST_MONGODB_URI）
   node index.js test     # test-log 模式（额外生成 AI 可读临时日志，随 webui 启动）
   ```

4. **运行单元测试：**

   ```bash
   npm test               # 使用 node:test 内置框架
   ```

   - 工具函数层：`chatIdConverter` / `groupGenerator` / `helpers` / `levelExtractor` / `markFormatter` /
     `modeNames` / `queryParser` / `sanitize` / `tags`
   - 写库链路回归：`tests/recordMedia.test.js`（媒体收录 + `group_list.is_delete` 语义），
     借助 `tests/helpers/memoryDb.js`（内存 Mongo 桩 + bot/logger 打桩）离线驱动，无需真实数据库与 Telegram
   - Web UI API 与写操作：`tests/webui.test.js`（含标签筛选/改描述/改标签/用户与聊天增删改/操作日志/统计报表）
   - Web UI 前端静态一致性：`tests/uiStatic.test.js`（元素 id、`data-action` 处理分支、双主题令牌、既有文案）

   > 单文件直接跑（`node tests/recordMedia.test.js`）也可；`node --test` 需要能 spawn 子进程的环境。

5. **（可选）启动 Web UI 管理面板：**

   ```bash
   npm run start:webui    # 或 node index.js webui
   ```

   浏览器访问 `http://127.0.0.1:9700`，登录密码见启动日志（或在 `.env` 中配置 `WEBUI_PASSWORD`）。

6. **（可选）test-log 模式（AI 可读临时日志）：**

   ```bash
   npm run start:test     # 或 node index.js test
   ```

   在 webui 模式基础上，日志除正常写入 `logs/<年>/<月>/<周>/<日>.log` 外，额外复制一份到 `test-log/`（与 logs 平级，仅含 `log.log`、`error.log` 两个扁平文件），**供 AI 读取分析**。`test-log` 在**每次以 test 启动时初始化**（清空上次内容），关闭时不清理由 test 模式产生的数据。

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
  - [业务处理层 — handlers/](#11-业务处理层--handlers)
  - [Web UI 管理面板 — webui/](#12-web-ui-管理面板--webui)
- [数据流详解](#数据流详解)
- [环境变量](#环境变量)
- [指令列表](#指令列表)
- [数据库设计](#数据库设计)
- [管理权限](#管理权限)
- [版本历史](#版本历史)

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
┌────────┐ ┌──────────┐
│  db/   │ │ utils/   │
│数据库层│ │工具函数层│
└────────┘ └──────────┘
```

**设计要点：**
- **单例模式：** bot.js 导出唯一的 Bot 实例，database.js 维护唯一的 MongoClient 连接，全局共享
- **事件驱动：** index.js 注册 Telegram 事件监听，按消息来源（私聊/群组/回调）分发给不同处理器
- **命令自动加载：** commands/index.js 自动扫描目录注册所有 /command 处理器
- **模式系统：** modes/ 实现"模式"概念——用户进入某种模式后，后续消息由对应模式处理器接管，直到 /exit 退出

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
  - `error` → 红色背景
  - `warn` → 黄色
  - `success` → 绿色
  - `info` → 蓝色
- 使用 `async` 库的异步队列（`async.queue`）实现有序文件写入，避免并发写入错乱
- 每条日志包含时间戳、日志级别、消息内容
- 日志按 **年/月/周分级目录 + 按天拆文件** 存储：`logs/<年>/<月>/<ISO周>/<YYYY-MM-DD>.log`
  （如 `logs/2026/08/2026-W36/2026-08-31.log`，ISO 周号周一为一周开始；所有级别合在当天文件，
  每行自带 `[INFO]`/`[ERRO]` 级别标记）
- **test 模式**（`node index test`）：日志额外复制一份到 `test-log/log.log`、`test-log/error.log`
  （与 logs 平级的扁平临时日志，启动时重置，便于本次运行统一查看）
- **关闭清理**：收到关闭信号时立即删除"定时删除"的群组提示消息与消息回复模式遗留的"正在回复该消息"提示，
  并刷盘日志队列保证日志不丢失
- 日志目录在首次写入时自动创建

---

### 6. 媒体处理 — media.js

**路径:** `media.js` **职责:** 从消息中提取媒体、发送媒体、管理媒体收集状态

**核心函数：**

| 函数 | 功能 | 实现要点 |
|------|------|----------|
| `extractMediaFromMessage(msg)` | 从消息中提取媒体信息 | 检测 photo/video/audio/document 类型，返回标准化媒体对象 |
| `sendMediaAsReply(chatId, replyId, media)` | 回复发送单个媒体 | 按 media_type 调用不同的 send 方法，附带原文链接按钮 |
| `sendMediaGroupAsReply(chatId, replyId, items, size)` | 批量发送媒体组 | 按 subgroup 分组发送，每批最多 10 条；注释位置还原（Telegram 仅第一条可带注释，其余位置发送后二次编辑恢复） |
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
- 用于外部监控或云平台健康检查
- 服务器启动失败不阻塞 Bot 主流程

---

### 9. 工具函数层 — utils/

**路径:** `utils/` **职责:** 提供各模块共享的通用工具函数

#### queryParser.js — 查询条件解析

将用户输入的查询字符串解析为结构化查询条件。

**语法支持：**
```
关键字 -标签1 标签2       宽松标签（句尾最后出现的 - 即为标签标记，
                          命中任一标签即可，多个用空格或 、, 分隔，不区分大小写）
关键字 --标签1 标签2      严格标签（必须同时包含 -- 后所有标签）
关键字                    文本模糊搜索
```

**实现：**
```javascript
// 输出结构
{
  tags: ['图片', '教程'],   // 宽松标签数组（小写去重，任一命中）
  tagsAll: ['风光'],        // 严格标签数组（必须全部命中）
  keyword: '关键字'        // 移除标签部分后的纯文本
}
```

> 已移除媒体类型（-V/-P）与等级（+S 等）查询标记；等级字段不再写入 message。


#### queryFormatter.js — 查询结果格式化

将数据库查询结果格式化为分页显示的消息文本和内联键盘。

**实现要点：**
- 生成带编号的媒体列表文本（标题、类型、日期）
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

#### levelExtractor.js — 文本清理

等级标记已废弃，仅保留历史 `#X` 后缀清理：
- 移除文本末尾的等级后缀（兼容旧数据中的 `#S` `#A` 等）
- 等级字段不再写入 message 集合

#### sanitize.js — HTML 转义

对 Telegram API 支持的 HTML 格式进行安全转义：
- `&` → `&amp;`
- `<` → `&lt;`
- `>` → `&gt;`

#### opLog.js — 操作日志（schema v2）

| 导出 | 功能 |
|------|------|
| `logOperation(entry)` | **唯一写入入口**：规范化 `action`/`category`/`result`/`source`/`target`/`counts`/`detail`，写入 `date`+`time`，失败只记日志不抛错 |
| `insertLog(type, userId, extra)` | 兼容旧编号的包装（旧调用无需改动，自动映射成动作键） |
| `ACTIONS` / `CATEGORIES` / `ACTION_BY_TYPE` | 动作目录、大类名称、旧编号反查表 |
| `getCatalog()` | 动作目录（WebUI `/api/oplogs` 与 `/api/stats` 返回给前端做标签展示） |
| `actionLabel(action)` / `categoryLabel(category)` | 展示用中文名 |

详见 [db/log.js — 操作日志（schema v2）](#dblogjs--操作日志schema-v2)。

#### sendMedia.js — 通用媒体组发送

封装 `bot.sendMediaGroup()`，处理媒体组发送的边界情况：
- 分批发送（Telegram 限制每批最多 10 条）
- 错误重试

#### linkHealth.js — 收录链接活性检查

`/transport` 列表、控制台「搬运收录」与每 6 小时的巡检任务共用：

| 导出 | 功能 |
|------|------|
| `checkTransportLink(record)` | 实测单条：**优先按链接里的 `t.me/<username>` 探测**（机器人通常并不在搬运来源频道里，直接按 chat_id 查会得到 "chat not found"，早期实现因此把所有公开频道误报为失效）→ `ok`；公开用户名解析失败（频道已删除/改名/被封）→ `dead`；机器人能按 chat_id 访问但已被踢/退出 → `dead`；**私有/消息链接**（`t.me/c/…`）无权验证 → `unknown`（绝不判死）；429/网络/5xx → `unknown` |
| `checkAllTransports({ records, concurrency, force, maxAgeMs, onResult })` | 并发检查（默认 4，带节流与 429 兜底）并写回数据库；返回 `{ total, checked, ok, dead, newlyDead, recovered, unknown, skipped }` |
| `formatDeadReport(deadList)` | 失效清单文本（名称 / chat_id / 链接 / 原因），通知与菜单共用 |
| `notifyAdmins(text)` | 发送给 `ADMIN_CHAT_ID`（逗号分隔的多个管理员） |
| `transportLinkUrl(record)` | 见 `utils/tgLink.js`（重新导出） |
| `publicUsernameOf(url)` / `rateLimitRetryAfter(err)` | 从链接里取公开用户名；从 429 错误里取建议重试秒数 |
| `isDeadError(err)` / `isTransientError(err)` | 区分"链接失效"与"临时故障"（**429/5xx/网络一律算临时**，绝不算失效） |

**检查触发点：** ① 机器人 `/transport` 进列表时自动补查从未检查或超过 6 小时的记录（每次最多 8 条，不阻塞渲染，查完刷新列表并私聊提醒新失效项）；② 菜单/明细里的「🔍 检查链接活性」（全量）与「检查该链接活性」（单条）；③ 新增收录 / 改链接 / 改 chat_id 后立即实测并回显结论；④ `index.js` 每 6 小时全量巡检，新失效的链接提醒管理员（结果记为 `transport_check` 操作日志）。

#### tgLink.js — Telegram 链接（纯函数）

`transportLinkUrl({ chat_id, url })`：有 http(s) 链接就用它；否则用 chat_id 推导 `https://t.me/c/<内部ID>`——**仅当形如 `-100` + 至少 9 位**（真正的超级群/频道）才推导，避免 `-1002` 这类普通群被误判成「频道 2」。控制台与机器人共用，保证跳转链接口径一致。

#### tagUi.js — 标签按钮键盘（两区版面）
`/send` 打标签面板与 `/tag` 标签模式共用：

| 导出 | 功能 |
|------|------|
| `buildTagKeyboard(tags, opts)` | 单区列表：每行 4 个、每页 40 个 + 翻页按钮；`marker` 可给按钮加 `✅`/`+` 前缀 |
| `buildTagRegionKeyboard(applied, library, opts)` | **两区版面**（上区已有标签 / 下区标签库，见下） |
| `splitTagInput(text)` | 手动输入解析（空格 / `、` / `,` 分隔，去重保留首现） |
| `matchTagsInText(text, tags)` | 文本中识别已存在的标签（大小写不敏感）。**纯英文/数字标签按整词匹配**（`hello` 不会在 `hello` 里匹配出 `h`/`e`/`he`/`el`，需要片段请自行加标签）；含中文等非 ASCII 字符的标签仍按子串匹配 |
| `paginate(items, page)` | 分页切片（每页 40 个） |

**两区版面**（`/send` 发送成功后的打标签面板、`/tag` → 修改消息标签 → 🏷️ 添加标签）：

```
✅已有A | ✅已有B                ← 上区：已有标签（点击 = 移除）
── 已有标签（点击移除） ──        ← 分隔行（点击只提示，不改变状态）
+置顶1 | +置顶2 | +普通C          ← 下区：标签库正常显示（点击 = 添加）
◀ 上一页   1 / 2   下一页 ▶       ← 翻页只翻下区
↩️ 返回选择
```

- **上区** = 作用目标（定位的那条 message，未定位时整组）上**已打上**的标签，置顶显示；按钮前缀 `✅`，点击移除
- **下区** = 标签库正常显示：置顶标签（`pin>0`）按 pin 升序在最前，其余按使用次数降序、次数相同按名称；按钮前缀 `+`，点击添加
- **下区过滤规则**：已打上的**非置顶**标签不再在下区重复（"非置顶标签就无需显示了"，它们已在上面）；已打上的**置顶**标签仍在下区显示（"下面的置顶标签已有，同样显示出来"，置顶标签属于下区置顶）
- 点击语义由回调按"当前是否已打上"决定（已打上 = 移除，未打上 = 添加），因此上下两区共用同一个回调前缀
- `/tag` 的 🗑️ 删除标签仍为单区版面（那里列出的本来就是已有标签）

#### modeNames.js — 模式名称映射

维护模式标识符到中文名称的映射表：
```javascript
module.exports = {
  'media_group': '媒体合并',
  'search': '搜索',
  // ...
};
```

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
| `message` | `{media_type, text}` | 全文搜索 |
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
| `tags` | `name` (唯一) | 标签库（大写标签名） |

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
| `search_random` | boolean | false | 是否随机搜索结果 |
| `random_pictures` | boolean | false | 随机图片功能开关 |
| `random_pictures_num` | number | 9 | 随机图片数量 |
| `random_videos` | boolean | false | 随机视频功能开关 |
| `random_videos_time` | string | "<1min" | 视频时长筛选条件 |
| `random_videos_num_text` | number | 15 | 随机视频文字列表数 |
| `random_videos_num_video` | number | 10 | 随机视频实际发送数 |
| `media_group_num` | number | 10 | 媒体合并默认数量 |

> 标签已迁移至**独立 `tags` 集合**（`db/tags.js`），不再存储于 settings：每标签一条 `{name, pin, count}`——`pin`=置顶位置（0 不置顶；>0 为按钮网格位置，每行 4 个、1 为左上第一个按钮），`count`=使用次数。

#### db/media.js — 媒体文件记录

核心数据操作：

| 函数 | 功能 |
|------|------|
| `insertMedia(mediaRecord)` | 插入新的媒体记录（支持 `group`/`channel` 双位置字段） |
| `findMediaByFileUniqueId(fileUniqueId)` | 按 file_unique_id 精确查询 |
| `findMediaByGroupId(groupId)` | 按 group_id 查询所有媒体 |
| `getMaxSubgroup(groupId)` | 获取指定组的最大子组编号 |
| `deleteMediaByFileUniqueId(fileUniqueId)` | 按 file_unique_id 删除 |
| `updateMediaPassword(fileUniqueId, pwd)` | 更新媒体密码 |
| `buildMediaLocation(chatId, messageId, chatType)` | 按聊天类型构建媒体位置（频道 → `channel`，群组 → `group`） |

> **双位置字段：** `group: { chat_id, message_id }`（群组位置）与 `channel: { chat_id, message_id }`（频道位置）。
> 频道转发媒体两项都有；给空媒体补注释时可据此获得双位置信息。

#### db/message.js — 消息记录

| 函数 | 功能 |
|------|------|
| `upsertMessage(messageRecord)` | 插入或更新消息记录（支持 `tags`、`channel_forward` 字段） |
| `findMessageByFileUniqueId(fileUniqueId)` | 按 file_unique_id 查询 |
| `deleteMessageByFileUniqueId(fileUniqueId)` | 删除消息 |
| `findMessagesByGroupId(groupId)` | 按组查询所有消息 |
| `addTagToGroup(groupId, tag)` / `removeTagFromGroup(groupId, tag)` | 给媒体组所有消息添加/移除标签 |
| `getGroupTags(groupId)` | 获取媒体组全部标签（并集） |

> **channel_forward 字段：** `{ is_channel: true, channel_chat_id, channel_message_id, group_chat_id, group_message_id }`，
> 标记消息为频道转发并记录群组中该消息的位置，回复时可选频道或群组。

#### db/log.js — 操作日志（schema v2）

**实现已迁移到 `utils/opLog.js`**，`db/log.js` 只保留旧编号常量与兼容包装（`insertLog(type, userId, extra)` → 自动映射成动作键）。

日志文档结构（面向月表 / 年终统计设计）：

| 字段 | 说明 |
|------|------|
| `action` | 稳定动作键（如 `media_save`、`send_media`、`reply_media`、`query_keyword`、`media_clean_execute`、`tag_add`、`user_ban`、`chat_bind`、`setting_update`、`bot_start`…） |
| `actionLabel` | 动作中文名（冗余存储，改文案不影响历史数据） |
| `category` | 大类：`media`/`send`/`reply`/`query`/`clean`/`tag`/`user`/`chat`/`setting`/`content`/`transport`/`webui`/`system` |
| `result` / `error` | `ok` \| `fail`，失败时带错误信息（可统计失败率） |
| `source` | 发生位置：`private`/`group`/`channel`/`webui`/`system` |
| `date` / `time` | `date` 为 BSON 日期（`$year`/`$month`/`$dateToString` 聚合用），`time` 为毫秒时间戳（兼容旧数据） |
| `userId` / `chatId` / `messageId` | 操作者与触发上下文 |
| `target` | 操作对象 `{ type, id }`（`media`/`media_group`/`tag`/`user`/`chat`/`setting`/`article`/`collection`） |
| `counts` | 产出量数值：`{ media, groups, users, tags, edits, queries, results, texts, chats, articles, collections … }` |
| `detail` | 结构化细节：`{ query, mediaType, videoTime, tags, hasCaption, scope, via, status, name, before, after … }` |
| `durationMs` | 可选耗时 |
| `type` | 旧编号（0=启动,1=收录,2=修改,3=删除,11/12=随机,13=回复,14/15/21=合并/遮罩,16=帮助,17=查找,18=清理,19=删除模式,20=标记,22=查询,23=修改,24=设置,25=发送,26=标签,27=控制台登录,28=控制台数据操作,29-32=用户,33=群组频道,34/35=文章合集,36=搬运），继续保留以兼容历史统计 |

**唯一写入入口：** `logOperation({ action, category, result, source, userId, chatId, target, counts, detail, error, durationMs })`
—— 写入失败只记 `logger.error`，绝不影响业务流程。

**已接线的动作（节选）：**

| 大类 | 动作 |
|------|------|
| media | `media_save`（收录）/`media_save_duplicate`（重复命中）/`media_save_fail`（收录失败回滚）/`channel_forward`（频道转发归属，区分新收录与补位置）/`media_edit`（描述修改：私聊、群内两步、回复 `/edit`、控制台）`media_delete`（清空描述）/`media_delete_one`/`media_delete_group`/`mark`/`media_merge`/`media_hide`/`media_unhide`/`media_password` |
| send / reply | `send_media`/`send_text`/`send_fail`/`reply_media`/`reply_fail`（含打包模式、目标频道/群组、媒体类型与时长合计） |
| query | `query_keyword`（含命中条数）/`search`/`help`/`log_view`/`random_video`/`random_picture` |
| clean | `media_clean_scan`（扫描）/`media_clean_execute`（实际删除的组数与媒体数） |
| tag | `tag_add`/`tag_remove`/`tag_create`/`tag_rename`/`tag_delete`/`tag_pin`（自动识别打标签记 `tag_add` + `detail.auto=true`） |
| user | `user_create`/`user_update`/`user_delete`/`user_ban`/`user_unban`/`user_whitelist_add`/`user_whitelist_remove`/`user_join`/`user_leave`/`user_join_request`（含审批结论与原因） |
| chat / setting / content | `chat_create`/`chat_update`/`chat_delete`/`chat_bind`/`chat_unbind`/`setting_update`/`article_save`/`article_delete`/`collection_save`/`collection_delete` |
| system / webui | `bot_start`（版本、数据库、运行模式）/`bot_stop`（信号、运行时长）/`webui_login`/`webui_login_fail`/`webui_db_execute`（控制台原始增删改） |

**查看统计的两种方式：**
- 机器人内 `/log`：近 7 天明细（大类 → 动作）+ 本月 / 本年汇总 + 活跃时段条形图（时间口径按北京时间，兼容无 `action` 的历史数据）
- Web UI「统计报表」：统一**按年统计**（顶栏右上角 ◀ ▶ 切换年份）、环比、**每日操作量 GitHub 全年方格图**、动作明细、大类分布、活跃用户、**活跃时间**、失败统计 + 可筛选的操作日志明细表

**索引**（`db/index.js`）：`time -1`、`date -1`、`{action,date}`、`{category,date}`、`{userId,date}`、`{result,date}`

#### db/groupList.js — 媒体组汇总

| 函数 | 功能 |
|------|------|
| `upsertGroupList(groupId, increment)` | 原子增加 `is_group` 计数（$inc） |
| `syncGroupDeleteByText(groupId)` | **按组内是否还有文本重算 `is_delete`**（唯一判定入口，见下） |
| `setGroupDelete(groupId, timestamp)` | 直接设置删除标记（仅 `syncGroupDeleteByText` 与回滚使用） |
| `findGroupList(groupId)` | 查询组信息 |
| `deleteGroupList(groupId)` | 删除组记录 |

> **`group_list.is_delete` 语义（全项目统一）：**
>
> | 值 | 含义 |
> |----|------|
> | `0` | 组内存在文本（`message` 记录），**保留**，`/clean` 不清理 |
> | `> 0` 时间戳 | 组内没有任何描述（空描述媒体组），**可被 `/clean` 清理** |
> | `null` | 刚建组、尚未判定（收录流程会立刻重算，不会长期停留） |
>
> 判定统一由 `syncGroupDeleteByText(groupId)` 完成：`message` 集合中该 `group_id` 还有记录 → `0`；
> 否则 → 当前时间戳。**所有会改变「组内文本」的写路径都调用它**，而不是各自判断后写死：
>
> - 收录：`groupMessageHandlers.handleNewMediaMessage`（空描述媒体组照常录入 `media`，只把标记记为时间戳）
> - 发送：`sendMode`（单条 + 媒体组）、回复：`messageReplyMode`（单条 + 媒体组）
> - 编辑：`editMode.updateMessageDb`（补/改文本 → 0；清空描述 → 时间戳）、`editConfirmDbOnly`（仅更新数据库）、
>   `groupReplyEdit`（群内回复 `/edit`）
> - 删除：`deleteMode`（删除有文本的媒体后重算）、`groupMessageHandlers.handleEditedMessage`（群内直接清空描述）
>
> 因此「空描述媒体组照常被收录 → 可清理；后续补/改描述 → 自动变为无需清理；再清空 → 又可清理」，
> 且与媒体组内各条消息的到达顺序无关。

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
- `banUserFully(userId)` 不仅设置数据库状态（state=0），还主动将用户从**全部管理群组与频道**（含绑定关系的频道↔群组两侧）中封禁踢出
- `unbanUserFully(userId)` 同样覆盖全部群组与频道解封并恢复 state=1；解封后短暂标记"最近解封"，期间收到的 left/kicked 状态更新（解封动作回显）不会触发"退出即封禁"，避免"管理员刚解封、机器人立刻又封禁"
- `removeUserFromGroup()` 在用户离开群组时触发自动封禁（用于防撤回退群）

#### db/transport.js — 搬运链接

| 函数 | 功能 |
|------|------|
| `upsertTransport(transport)` | 插入或更新搬运记录（更新会作废旧活性结论） |
| `getAllTransports()` | 获取所有搬运源（按搬运次数降序） |
| `getTransportByChatId(chatId)` | 按 chat_id 查询 |
| `deleteTransport(chatId)` | 删除搬运记录 |
| `createTransport({ chat_id, chat_name, url, num })` | 新建收录记录（控制台用，重复 chat_id 返回 `{ ok:false, error }`） |
| `updateTransport(chatId, { chat_name, url, num })` | 修改收录记录（改链接后清空 `alive`/`last_check_*`，等待重查） |
| `updateTransportStatus(chatId, { status, error, chatName, previousAlive })` | 写回活性检查结论（`alive`：true/false/未知保持原值 + `last_check_at/status/error`） |
| `getTransportHealth()` | 活性巡检用列表（等价于 `getAllTransports`） |
| `extractChatInfo(url, bot)` | 从 t.me 链接解析出群组 chat_id 和名称 |

> **活性字段：** `alive`（true=有效 / false=失效 / null=未检查）、`last_check_at`、`last_check_status`（ok/dead/unknown）、`last_check_error`。由 `utils/linkHealth.js` 写入，机器人、控制台与巡检任务共用同一份结论。

#### db/dbStats.js — 数据库存储统计

控制台「数据库」视图与概览卡片共用（15 秒缓存，避免频繁打 Atlas）：

| 函数 | 功能 |
|------|------|
| `getDbStats({ force })` | 整库 `dbStats` + 逐集合 `collStats`：集合名/中文名、`count`、`size`、`storageSize`、`indexSize`、`nindexes`、`avgObjSize`、整库 totals；按数据体积降序 |
| `getDbStatsSummary()` | 概览卡片用的精简版（`objects`/`collections`/`storageSize`/`dataSize`/`indexSize`） |
| `clearDbStatsCache()` | 手动失效缓存 |
| `COLLECTION_LABELS` | 集合名 → 中文名映射 |

> **降级策略：** 若部署（部分共享集群 / 受限账号）不允许 `dbStats` 或 `collStats`，自动退回 `estimatedDocumentCount()` 只取文档数，并在返回值里给出 `available:false` + `reason`；前端据此显示原因而不是报错。实测 MongoDB Atlas 免费版（M0）该两条命令**可用**，因此大小/占用能正常显示。

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

### 11. 业务处理层 — handlers/

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
    ├── 频道转发识别 (resolveChannelForwardInfo)
    │   ├── 是（forward_origin / is_automatic_forward + 绑定库）→ 不重复收录，
    │   │      记录 message.channel_forward（频道源 + 群组位置）+ media 双位置（group/channel）
    │   └── 否 → 继续
    │
    ├── 生成 group_id (generateGroupIdFromMessage)
    │
    ├── 去重检查
    │   ├── 已存在 → 回复 "已收录" + 原文链接
    │   └── 不存在 → 继续
    │
    ├── 数据库操作（三步写入）
    │   ├── upsertGroupList (组汇总，$inc)
    │   ├── insertMedia (媒体记录，含 group/channel 位置)
    │   └── upsertMessage (消息记录，仅带文本媒体)
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
    ├── queryParser.parseQuery(text) → 结构化条件（关键字 + 标签）
    ├── 数据库模糊查询 (按 text / tags 筛选)
    ├── queryCache.createSession() → 缓存结果
    ├── queryFormatter.formatQueryResults() → 格式化为分页文本
    └── 发送带翻页键盘的消息
```

**分页机制：**
- 每页默认 10 条结果
- 翻页通过 `pageCallback.js` 处理
- 结果缓存 60 秒 TTL
- 支持标签筛选（`-` 宽松 / `--` 严格）、随机排序

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
| `/clean` | clean.js | 数据库清理模式 | 扫描空数据的 group_list，批量删除 |
| `/delete` | delete.js | 删除单一媒体 | 进入 delete 模式，等待用户发送媒体或链接 |
| `/delete_group` | deleteGroup.js | 删除整个媒体组 | 进入 deleteGroup 模式，等待用户操作 |
| `/edit` | edit.js | 编辑消息文本 | 进入 edit 模式，等待用户选择要编辑的消息；群组/频道中管理员**回复**一条媒体消息并发送 `/edit [新描述]`（也支持 `/edit@机器人用户名 [新描述]`）可跳过定位直接修改该媒体（带文字一步完成；不带文字时群组内等管理员下一条文本；频道仅支持带文字）。修改后 1 分钟自动删除全部操作记录（机器人提示 + 管理员的命令消息） |
| `/exit` | exit.js | 退出当前模式 | 调用 deleteUserState 清理状态 |
| `/help` | help.js | 显示命令按钮 | 发送带所有命令的内联键盘 |
| `/log` | log.js | 操作统计 | 从 log 集合聚合统计并展示 |
| `/manage` | manage.js | 管理面板 | 进入 manage 模式，显示管理主菜单 |
| `/mark` | mark.js | 标记模式 | 进入标记菜单（开始标记/标记记录/退出），标记记录支持按次数或时间排序分页展示 |
| `/send` | send.js | 发送模式 | 选择目标群组/频道（分页按钮），发送消息/媒体/媒体组并收录；成功后可打标签（按钮/手动输入，文本自动识别勾选）。打标签面板为**两区版面**：上区=已有标签（点击移除），下区=标签库（置顶在前，点击添加）；打标签时可一键"回复该消息"自动进入回复模式 |
| `/tag` | tag.js | 标签模式 | 修改消息标签（预览媒体组后添加/删除，按钮翻页+手动输入；**添加标签**为两区版面：上区=已有标签（点击移除）、下区=标签库（置顶在前，点击添加）；标签按 message 独立——只作用于定位的那条媒体，定位界面会把组内所有带文本 message 的标签分别列出）；编辑标签（添加/改名/删除/固定置顶位置，同步 message） |
| `/media_group [N]` | mediaGroup.js | 媒体合并模式 | 进入 mediaCollect 模式，type=media_group；N=每组个数（1~10，退出时按 N 个一组打包发送） |
| `/media_hide [N]` | mediaHide.js | 媒体遮罩模式 | 进入 mediaCollect 模式，type=media_hide；N=每组个数（1~10） |
| `/media_unhide [N]` | mediaUnhide.js | 去遮罩模式 | 进入 mediaCollect 模式，type=media_unhide；N=每组个数（1~10） |
| `/message_reply [N]` | messageReply.js | 消息回复 | 进入 messageReply 模式，定位到频道转发消息时可选择回复在群组/频道；N>=2 时媒体按 N 个为一组打包为媒体组回复（满 N 个立即回复一组，不足 N 的余量等待补满下一组，退出/超时时才冲刷发出） |
| `/message_reply_group` | messageReplyGroup.js | 消息回复（群组） | 直接回复在群组中（频道转发消息用群组位置，非转发消息用消息自身位置） |
| `/message_reply_channel` | messageReplyChannel.js | 消息回复（频道） | 直接回复在频道中（无频道位置时回退消息自身位置） |
| `/password` | password.js | 媒体密码 | 进入 password 模式，设置/更新媒体访问密码 |
| `/random_pictures [N]` | randomPictures.js | 随机图片 | 查询 media_type=photo 的随机结果，可指定数量 N（1~10） |
| `/random_videos [N]` | randomVideos.js | 随机视频 | 可按时长筛选；可指定数量：N 1~10 直接发送 N 个视频媒体，N>=11 以标题列表展示 |
| `/search` | search.js | 搜索模式 | 进入 search 模式，后续消息全部作为查询 |
| `/setting` | setting.js | 全局设置 | 进入 setting 模式，显示设置面板内联键盘 |
| `/transport` | transport.js | 搬运管理 | 进入 transport 模式，管理搬运链接的 CRUD；列表带**活性徽标**（✅ 有效 / ❌ 失效 / ❔ 未检查）与失效原因，进模式时自动补查过期记录，可「🔍 检查链接活性」全量实测；新增 / 改链接 / 改 chat_id 后立即实测并把结论直接回给用户 |

#### handlers/modes/ — 模式系统

**模式分发（modes/index.js）：**
```javascript
function handleModeMessage(userId, msgText, msg, userName) {
  const state = getUserState(userId);
  switch (state.mode) {
    case 'search': return handleSearchMode(userId, msgText, msg);
    case 'media_group':
    case 'media_hide':
    case 'media_unhide':
      return handleMediaCollectMode(userId, msg, state);
    // ... 其他模式
  }
}
```

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
| `execCmd.js` | 执行指定命令 |

---

### 12. Web UI 管理面板 — webui/

**路径:** `webui/` **职责:** 提供浏览器端数据查看与管理界面（零第三方依赖）

**启动方式：**

```bash
node index.js webui       # 或 npm run start:webui
```

浏览器访问 `http://127.0.0.1:9700`（端口可通过 `WEBUI_PORT` 配置）。登录密码：

- 在 `.env` 中配置 `WEBUI_PASSWORD`，或
- 未配置时启动日志会打印随机生成的密码

**鉴权机制：**
- 除 `/api/login` 外的所有 API 均需携带 `Authorization: Bearer <token>`
- 登录成功返回 token，前端存储在 localStorage，会话有效期 12 小时

**界面结构：左侧导航 + 主区 + 右侧实时日志坞（窄屏自动折叠为单列）**

| 视图 | 内容 |
|------|------|
| 📊 概览 | 媒体 / 有描述 / 可清理组 / 用户 / 标签 / 聊天 / 日志 统计卡片、**数据库占用卡片（storageSize + 文档数 + 索引占用，取不到时标注"当前套餐不可读取大小"）**、媒体类型分布、最近操作、最新媒体组（可点开详情）、快捷入口 |
| 🖼 媒体库 | 以 `group_list` 为单位的媒体组卡片：**图片与视频封面缩略图**（服务端代理 Telegram `getFile`）、描述摘要（空描述标为「可清理」）、标签、类型/组数/位置；筛选「全部 / 有描述 / 可清理」+ 顶部搜索（按 `message.text`）+ **标签筛选**（从「标签」视图点进来，可用胶囊清除）+ 分页；点开为详情对话框 |
| 📋 媒体详情 | 媒体缩略图条、**一键「↗ 跳转 Telegram 查看」**、**在线改描述**（保存会同步 Telegram caption，超 48 小时只改库并提示）、**点选媒体后改标签**（点缩略图或描述块选中该媒体：已有标签高亮、点 ✕ 直接移除；没有标签则高亮「➕ 添加标签」；未选中时标签区置灰不可点。原「整组操作」已移除，标签按 message 独立）、一键「标记为可清理 / 保留」（改写 `group_list.is_delete`） |
| 🧹 清理中心 | 按「一周前 / 一个月前 / 全部」给出**精确**的待清理组数与媒体数（`POST /api/clean` 预览），确认后执行与机器人 `/clean` 相同的删除逻辑；下方为可清理组预览 |
| 🏷 标签 | 顶栏三个按钮：**➕ 添加标签**（表单新建，自动大写、重名拒绝）、**🗑️ 删除标签**（进入删除模式后点卡片二次确认删除，会同步清理所有 message）、**⭐ 置顶排序**（进入排序模式后**直接拖动卡片排序**，保存即按顺序写入置顶位置 1..N）；卡片显示置顶位置、使用次数、计数，**点击卡片进入标签详情**——详情顶栏显示置顶状态（`📍 已置顶（位置 N）` / `⭐ 未置顶`），**点一下即切换**置顶/取消置顶，正文**直接列出该标签下的媒体组（与「媒体库」同款方块卡片，点卡片直接打开媒体详情）**，底部可跳转到媒体库筛选全部；顶部搜索可过滤标签名 |
| 👥 用户 | 用户表（名称 / ID / 状态 / 白名单 / 所在群组数 / 最近活跃），筛选「全部 / 白名单 / 已封禁」+ 搜索（名称或纯数字 ID）+ 分页；**支持新增 / 编辑（名称、状态、白名单、所在群组）/ 删除** |
| 📢 群组 / 频道 | `channel_group` 记录与频道↔群组绑定关系（含绑定对象名称解析）；**支持新增 / 编辑 / 删除，绑定为双向写入**（改绑会清理旧对端，删除会解除对端绑定） |
| 🚚 搬运收录 | `transport` 记录表：**活性徽标**（✅ 有效 / ❌ 失效 / ❔ 未检查）、名称、`chat_id`、**一键「↗ Telegram」跳转**、搬运次数、最近检查时间与失败原因；筛选「全部 / 有效 / 失效 / 未检查」+ 搜索（名称 / 链接 / chat_id）+ 分页；**支持新增 / 编辑 / 删除**，并可按行「🔄 检查活性」或「🔍 全部检查活性」（检查结果写回数据库，与机器人共用同一份结论） |
| 📄 文章 | `article` 卡片：标题（可点开链接）、子文章列表、更新时间、子文章数；**支持文章与子文章的增 / 改 / 删**（删除文章会级联删除子文章） |
| 📚 合集 / 杂集 | `collection`（合集）与 `misc`（杂集）卡片：名称、子项列表（可点开链接）、子项数；按类型筛选 + 搜索；**支持合集/杂集与子项的增 / 改 / 删**（删除会级联删除子项） |
| 📈 统计报表 | **统一按年统计**（顶栏右上角 `◀ 2026 年 ▶` 切换年份，无月报/年报页签）：操作总数、媒体产出、媒体组产出、活跃天数、失败次数（带环比）、**每日操作量 GitHub 全年方格图**（独占整条：7 行 = 周一…周日、每列一周，列宽自适应撑满卡片、窄屏横向滚动；整年每格一天，列顶标注月份，颜色随操作量分 5 档加深，悬停看当天媒体数）、动作明细 Top15、大类分布、活跃用户、**活跃时间**（北京时间 24 小时分布，0 次的小时用底色短桩区分，高峰柱标绿并在柱顶标出次数），以及可筛选（大类 / 结果 / 关键词）的操作日志明细表 —— 面向"年终统计"设计；底部明细表**撑满剩余高度**（表格内部滚动，不再悬在页面中间）。历史日志只有旧编号（`type`）时也都有可读中文名（如 23 → 「修改文本」），不再出现 `legacy_type_23` 之类的占位名 |
| 🗄 数据库 / 原始数据 | **数据库存储统计 + 原始数据浏览合并为一个视图**：顶部为整库汇总卡（集合数 / 文档总数 / 存储占用 / 数据体积 / 索引占用 / 平均文档）与**各集合明细表**（文档数、数据体积、磁盘占用、索引占用、索引数、平均文档——平均文档保留两位小数），可「🔄 重新统计」；套件不允许 `dbStats`/`collStats` 时自动降级为仅文档数并给出原因。下方为**集合浏览**：单集合分页浏览 / 「全部数据库」跨集合概览、文档 JSON 就地修改与删除、插入模板 |
| 📡 实时日志 | SSE 日志全屏视图，级别筛选（信息 / 成功 / 警告 / 错误）、暂停与清空 |

**AI 操作台（Ctrl/⌘ + K 或左下角「AI 翻译」）：**
- 输入自然语言，或点面板里的示例胶囊快速套用；点【翻译为操作】
- DeepSeek 将其翻译为完整数据库操作 JSON（`action/collection/filter/data`），展示为**可编辑**文本框
- 点【执行操作】才真正执行；删除类操作二次确认；`query` 结果会直接渲染到「原始数据」视图。**AI 只翻译、不直接操作数据库**
- 提示词（`webui/db-guide.md`）内置**意图 → 集合**路由表、更新到 schema v2 的表结构与 9 个跨场景示例，
  并在服务端校验 `action`/`collection` 合法性（模型输出占位文字或白名单外集合会直接报错并可展开原始返回，便于排查）
- 数据库表结构与 AI 提示词位于 `webui/db-guide.md`

**交互细节：**
- **主题跟随系统**：默认 `自动`，按 `prefers-color-scheme` 实时切换（首屏不闪白）；点「🌗 跟随系统」按钮可在 自动 → 浅色 → 深色 间循环并记住选择
- 快捷键：`/` 聚焦搜索、`Ctrl/⌘ + K` 打开 AI 操作台、`R` 刷新、`Esc` 关闭浮层；`Ctrl/⌘ + Enter` 在操作台内翻译
- 顶部「自动」开关每 5 秒刷新当前视图（页面隐藏时暂停）
- 缩略图懒加载 + 获取失败自动退化为类型图标，不会出现破图
- 所有写操作（改描述/标签、清理、用户与聊天增删改、AI 执行）都会写入操作日志，来源标记为 `webui`


**API 一览：**

| 接口 | 说明 |
|------|------|
| `POST /api/login` | 登录，返回 token |
| `GET /api/db/collections` | 可操作集合白名单 |
| `POST /api/db/query` | 查询（`collection` 为 `__all__` 时跨集合浏览，每集合前 100 条；否则分页） |
| `POST /api/db/execute` | 执行操作（`{ operation, confirm }`，delete 必须 confirm 且 filter 非空） |
| `POST /api/ai/plan` | AI 将自然语言翻译为完整操作计划（支持选中文档，不执行） |
| `GET /api/logs/stream` | SSE 实时日志流（token 经 query 传递） |
| `GET /api/overview` | 概览统计（各集合计数、媒体类型分布、最近操作、最新媒体组） |
| `GET /api/media` | 媒体组列表（`scope=all\|cleanable\|kept`、`q` 按描述搜索、分页），带首个媒体预览与描述/标签 |
| `GET /api/media/detail` | 单个媒体组详情（`groupId`）：媒体条目 + 描述与标签 + `group_list` 状态 |
| `POST /api/clean` | 清理空数据（`{ scope: week\|month\|all, confirm }`；不带 `confirm` 只返回待清理数量） |
| `GET /api/tags` | 标签库（含 `message` 中的实际使用次数） |
| `GET /api/users` | 用户列表（`scope=all\|white\|banned`、`q` 名称或 ID、分页） |
| `GET /api/groups` | 管理的群组/频道及绑定关系 |
| `GET /api/thumb` | 图片/视频封面缩略图代理（服务端调用 Telegram `getFile`，图片用自身 `file_id`，视频/文档/音频用收录时保存的 `thumb_file_id`；token 经 query 传递，内存缓存） |
| `POST /api/media/tags` | 给单条 media（`fileUniqueId`）或整个媒体组（`groupId`）增删标签（`{ add, remove }`），自动建标签并维护 `tags.count` |
| `POST /api/media/description` | 修改媒体描述（`{ fileUniqueId, text, editTelegram }`）：落库 + 重算 `is_delete` + 重算标签 + 同步 Telegram caption（失败只回报不回滚） |
| `GET /api/oplogs` | 操作日志列表（按 `category`/`action`/`result`/`userId`/时间范围/关键词筛选，分页；兼容只有 `type` 的历史数据） |
| `GET /api/stats` | 月报 / 年报（`period=month|year&year=&month=`）：汇总、环比、每日趋势、动作/大类/用户分布、失败统计 |
| `POST /api/users/create` \| `update` \| `delete` | 用户增 / 改（名称、状态、白名单、所在群组）/ 删（需 `confirm: true`） |
| `POST /api/groups/create` \| `update` \| `delete` | 群组/频道增 / 改（含绑定，双向写入）/ 删（需 `confirm: true`，同时解除对端绑定） |
| `GET /api/transport` | 搬运收录列表（`status=all\|alive\|dead\|unchecked`、`q` 名称/链接/chat_id、分页），返回 ✅/❌/❔ 活性状态、可点击 `link` 与四类计数 |
| `POST /api/transport/create` \| `update` \| `delete` | 收录记录增 / 改（名称、链接、次数；改链接会作废旧活性结论）/ 删（需 `confirm: true`） |
| `POST /api/transport/check` | 活性检查：带 `chat_id` 检查单条并写回结论；不带则全量检查，返回 `summary`（有效 / 失效 / 未知 / 新失效列表） |
| `GET /api/articles` | 文章列表（`q` 标题/链接、分页、`withSubs=1` 附带子文章） |
| `POST /api/articles/create` \| `update` \| `delete` | 文章增（自增 id）/ 改（标题、链接）/ 删（级联删除子文章，需 `confirm: true`） |
| `POST /api/articles/sub/create` \| `update` \| `delete` | 子文章增 / 改 / 删（自动刷新父文章 `updated_at`） |
| `GET /api/collections` | 合集/杂集列表（`type=all\|collection\|misc`、`q` 名称、`withSubs=1` 附带子项） |
| `POST /api/collections/create` \| `update` \| `delete` | 合集/杂集增 / 改（名称、类型）/ 删（级联删除子项，需 `confirm: true`） |
| `POST /api/collections/sub/create` \| `update` \| `delete` | 子项增 / 改 / 删（自动刷新父合集 `updated_at`） |
| `GET /api/db-stats` | 数据库存储统计（整库 `dbStats` + 各集合 `collStats`，15 秒缓存；`force=1` 强制重算，取不到时返回 `available:false` + 原因） |
| `POST /api/tags/create` | 新建标签（自动大写、≤20 字符、重名 409） |
| `POST /api/tags/delete` | 删除标签（需 `confirm: true`，同步从所有 `message.tags` 移除） |
| `POST /api/tags/rename` | 标签改名（`{ name, to }`，自动大写；同步改写所有 `message.tags`，重名 409 / 不存在 404） |
| `POST /api/tags/pin` | 设置 / 取消置顶（`{ name, pin }`，`pin=0` 取消，上限 40） |
| `POST /api/tags/reorder` | 按 `{ names: [...] }` 顺序批量写置顶位置 1..N（控制台拖拽排序保存用） |

**实现要点：**
- 使用 Node 内置 `http` 模块，无新增 npm 依赖（DeepSeek 调用使用 Node 内置 fetch）
- `createWebUI(deps)` 支持依赖注入，API 层可独立单元测试
- 集合白名单校验（仅允许 `db/collections.js` 中的集合），危险操作符由 AI 提示词约束
- 日志推送基于 `logger.onLog()` 订阅机制（SSE 广播，不影响原有日志写入）
- 静态文件与 API 同源提供，无 CORS 问题

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
    │   ├── 频道转发识别（resolveChannelForwardInfo）
    │   │   ├── 是（手动转发 / is_automatic_forward 自动转发 + 绑定库）
    │   │   │   └── 不重复收录 → 记录 channel_forward + media 双位置
    │   │   └── 否 → 正常收录流程
    │   │
    │   ├── extractMediaFromMessage(msg)    → { file_id, file_unique_id, media_type }
    │   ├── generateGroupIdFromMessage(msg) → group_id
    │   │
    │   ├── 查重: findMediaByFileUniqueId(file_unique_id)
    │   │   ├── 已存在 → 回复 "已收录" + 原文链接
    │   │   └── 不存在 → 继续
    │   │
    │   ├── upsertGroupList(group_id, 1)    → 组计数 +1
    │   ├── insertMedia({...})              → 写入媒体记录（含 group/channel 位置）
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
    │   → { tags: [], keyword: '关键词' }
    │
    ├── 数据库查询（模糊匹配 text / tags）
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

### 场景三：群组消息编辑同步

```
用户在群组中编辑了一条已收录的消息
    │
    ▼
handleGroupEditedMessage()
    │
    ├── 提取 file_unique_id
    ├── 检测文本变化
    │   ├── 文本更新 → upsertMessage (更新文本)
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

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | 是 | BotFather 获取的 Token |
| `MONGODB_URI` | 是 | MongoDB Atlas 连接串 |
| `TEST_MONGODB_URI` | 否 | 测试数据库连接串 |
| `ADMIN_CHAT_ID` | 是 | 管理员 Telegram 用户 ID，多个用逗号分隔 |
| `WEBUI_PORT` | 否 | Web UI 端口（默认 9700） |
| `WEBUI_PASSWORD` | 否 | Web UI 登录密码（未设置时启动随机生成并打印） |

---

## 指令列表

### 私聊命令（仅管理员可用）

| 命令 | 功能 | 所属模块 |
|------|------|----------|
| `/media_group [N]` | 媒体合并模式（N=每组个数 1~10，退出时按 N 个一组打包发送） | modes/mediaCollectMode.js |
| `/media_hide [N]` | 媒体遮罩模式（Spoiler，N=每组个数 1~10） | modes/mediaCollectMode.js |
| `/media_unhide [N]` | 媒体去遮罩模式（N=每组个数 1~10） | modes/mediaCollectMode.js |
| `/message_reply [N]` | 在群组/频道中回复指定消息（频道转发消息可先选择回复位置；N>=2 时媒体按 N 个一组打包为媒体组回复——满 N 个立即回复一组，不足 N 的余量等待补满下一组，退出/超时时才冲刷发出） | modes/messageReplyMode.js |
| `/message_reply_group [N]` | 在群组中回复指定消息（支持 N 打包） | modes/messageReplyMode.js |
| `/message_reply_channel [N]` | 在频道中回复指定消息（支持 N 打包） | modes/messageReplyMode.js |
| `/search` | 进入搜索模式 | modes/searchMode.js |
| `/delete` | 删除单一媒体 | modes/deleteMode.js |
| `/delete_group` | 删除整个媒体组 | modes/deleteGroupMode.js |
| `/clean` | 数据库清理模式 | modes/cleanMode.js |
| `/random_videos [N]` | 随机获取视频（N 1~10 直接发送视频媒体，N>=11 标题列表展示） | commands/randomVideos.js |
| `/random_pictures [N]` | 随机获取图片（N 1~10 张） | commands/randomPictures.js |
| `/mark` | 标记模式（开始标记/标记记录/退出） | modes/markMode.js |
| `/send` | 发送模式（选择群组/频道发送并收录；发送后先显示"正在发送中"再刷新为结果，可打标签——打标签面板为两区版面：上区=已有标签（点击移除）、下区=标签库（置顶在前，点击添加）；媒体组注释不在第一条时自动还原到正确位置并对该媒体打标签） | modes/sendMode.js |
| `/tag` | 标签模式（修改消息标签 / 编辑标签：添加、改名、删除、固定置顶位置，同步 message）。标签按 message 独立：新增/修改文本只打该条 message 的标签；修改消息标签时只作用于定位的那条媒体，并把组内所有带文本 message 的标签分别列出。**添加标签为两区版面**：上区=已有标签（点击移除），下区=标签库（置顶标签在最前，点击添加；已打上的非置顶标签不再重复显示，已打上的置顶标签仍保留在下区） | modes/tagMode.js |
| `/edit` | 编辑消息文本或清空（私聊定位后编辑；群组/频道中管理员回复一条媒体消息并发送 `/edit [新描述]` 可跳过定位直接修改，支持 `/edit@机器人用户名`，操作记录 1 分钟后自动删除） | modes/editMode.js、handlers/groupReplyEdit.js |
| `/log` | 查看操作统计 | commands/log.js |
| `/help` | 显示命令列表按钮 | commands/help.js |
| `/setting` | 全局设置面板 | modes/settingMode.js |
| `/transport` | 搬运链接管理（列表带活性徽标与失效原因，进入时自动补查过期记录；支持全量/单条活性检查，新增与改链接后立即实测） | modes/transportMode.js、utils/linkHealth.js |
| `/password` | 媒体文件密码设置 | modes/passwordMode.js |
| `/manage` | 管理面板（群组/用户/白名单） | modes/manage/ |
| `/exit` | 退出当前模式 | commands/exit.js |

> **标签展示时机：** 媒体组标签（📌）不会出现在查询结果列表里，而是在**查看媒体时**展示——发送的媒体组注释下方；在"媒体过多询问是否发送/选择查看方式"的询问界面中，会在标签**上方**先展示该组的**媒体描述**（描述/标签缺一即省略对应行），且**标签与显示的文本配对**（显示哪条文本就配哪条的标签，各 message 标签独立共存），格式如下：
>
> ```
> 该组共有 9 个媒体，分为 3 组。
>
> 媒体描述
> 📌 标签：AV、B
> 请选择查看方式：
> ```

### 群组/频道自动功能

| 功能 | 说明 |
|------|------|
| 媒体自动收录 | 群组/频道媒体自动入库（去重），带文本的媒体同步写入 message |
| 频道转发双位置 | 频道转发至群组的媒体（含 `is_automatic_forward` 自动转发识别）在 message 记录新增 `channel_forward`、media 记录写入 `group`/`channel` 双位置，回复时可选回复在频道或群组 |
| 编辑同步 | 消息编辑/删除后自动同步数据库 |
| 回复 `/edit` 快捷编辑 | 管理员回复一条媒体消息并发送 `/edit [新描述]`（支持 `/edit@机器人用户名`）可直接修改该媒体：改 Telegram caption + 同步数据库 + 按新文本重算该媒体标签；超 48 小时自动降级为仅更新数据库；**1 分钟后自动删除全部操作记录**（机器人提示 + 管理员的命令消息） |
| 关键字查询 | 管理员在群组中发送文本自动搜索 |
| 成员记录 | 加入/退出自动记录，可配置封禁策略 |
| 入群审批 | 关联频道的用户自动通过加群申请 |

---

## 数据库设计

### 集合总览

| 集合 | 存储内容 | 文档数 |
|------|----------|--------|
| `message` | 消息元数据（文本、类型、标签、频道转发信息） | 与带文本媒体对应 |
| `media` | 媒体文件记录（file_id、密码、group/channel 双位置） | 每条媒体一条记录 |
| `group_list` | 媒体组汇总信息 | 每组一条 |
| `channel_group` | 管理的群组/频道 | 每个群组/频道一条 |
| `users` | 用户信息及权限 | 每个用户一条 |
| `log` | 操作审计日志 | 每次操作一条 |
| `transport` | 搬运源链接 | 每个搬运源一条 |
| `settings` | 全局设置（单文档） | 固定1条 |
| `tags` | 标签库（`{name, pin, count}`：名称、置顶位置、使用次数） | 每个标签一条 |

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

---

## 版本历史

### v0.5.9（当前）
- **统计报表「每日操作量」统一为 GitHub 全年方格**：去掉「月报 / 年报」页签，报表统一按年统计，年份改为顶栏右上角 `◀ 2026 年 ▶` 左右切换（2000~2100 边界禁用）；方格图独占一条长卡片，**7 行 = 周一…周日、每列一周**，整年每格一天、列顶标注 1~12 月，列宽 `minmax(9px, 1fr)` 自适应撑满卡片（窄屏横向滚动），颜色随操作量分 5 档加深；移除右侧「最活跃的日子」。
  - 修掉「方格只排成一行」的根因：`grid-auto-flow: column` 未显式声明行数时会把所有格子铺在第一行，现显式 `grid-template-rows: repeat(7, auto)` 并加静态回归测试守卫。
- **新增「活跃时间」卡片**（排在「活跃用户」之后）：`/api/stats` 新增 `byHour`（北京时间整点 24 个小时桶，含媒体产出）；前端 24 根柱、**00~23 全部标注刻度**，0 次的小时用底色短桩区分（不再像有活动），每 6 小时一条淡分隔线，高峰柱标绿并在柱顶标出次数，底部汇总「高峰 HH:00 · N 次（占 X%）· 次高 …」；柱高改由 `grid-template-rows: 14px 1fr 13px` 精确换算，不再被 flex 收缩压扁。
- **标签详情直接列媒体**：点标签卡片后正文用**与「媒体库」同款方块卡片**列出该标签下的媒体组（缩略图 / 状态徽标 / 描述 / 标签 / 媒体数），点卡片直接打开媒体详情，页脚保留「🖼 在媒体库中筛选」查看全部。
- **修复媒体详情里标签根本点不动**（`pointer-events` 陷阱）：`.tag-edit.is-locked` 设了 `pointer-events: none`，选中后只加 `is-active` 而没有移除 `is-locked`，导致「➕ 添加标签」、标签上的 ✎/✕ 在浏览器里全部点不动（测试桩不实现 CSS 所以未暴露）。现在选中时移除 `is-locked`、未选中时加回，并补 `.tag-edit.is-active { pointer-events: auto }` 与静态 CSS 守卫。
- **标签增删改齐全**：
  - ➕ 添加标签：展开选择区，可点推荐标签或输入回车添加；**「➕ 添加标签」后面新增「取消」**（输入框那一行的「➕ 添加」后面也有），取消即收起并清空输入、不写库；
  - ✕ 移除已有标签；**新增 ✎ 改名**（`POST /api/tags/rename`，自动大写、重名 409、不存在 404，同步改写所有 `message.tags`）；
  - 只有一个媒体的组打开即自动选中，标签区直接可点。
- **无文本记录的媒体也能补描述 + 打标签**：缩略图统一可点选，选中后自动补出「描述与标签」编辑块（虚线框 + `无文本记录` 标记，直接进入编辑态），保存描述时后端自动补建 `message` 记录。
- **自动识别标签改为整词匹配**（`utils/tagUi.js: matchTagsInText`）：纯英文/数字标签按整词匹配，`hello` 不会再被拆成 `h`/`e`/`he`/`el`（`helloworld`、`a_hd_b` 也不命中）；含中文等非 ASCII 字符的标签仍按子串匹配（中文没有词边界，`这是HD画质` 仍能识别 `HD`）；正则元字符标签已转义。需要片段匹配时自行在标签库另加标签。
- 测试：`tests/webuiViews.test.js` 扩充为 30 项（方格整年格数与色深分级、年份左右切换与边界禁用、活跃时间 24 小时与高峰、标签详情方块卡片、标签增删改与取消按钮、无文本记录媒体补描述、单媒体自动选中）；`tests/webui.test.js` 新增标签改名与 `byHour` 聚合用例（并让内存假集合支持 `tags.$` 位置更新）；`tests/tags.test.js` 新增英文整词匹配用例；`tests/uiStatic.test.js` 新增方格 7 行与标签区 `pointer-events` 静态守卫。全量 **199 项通过**。

### v0.5.8
- **控制台媒体详情改为「点选媒体再改标签」**：移除整组操作块；点击缩略图或描述块选中该媒体 → 已有标签高亮、点 ✕ 直接移除；该媒体没有标签则高亮「➕ 添加标签」；未选中时标签区置灰不可点（`pointer-events:none` + 按钮 `disabled`）。改完标签整块重渲染后仍保留选中态。标签仍按 message 独立，`POST /api/media/tags` 的整组用法保留（机器人侧在用）。
- **修复收录链接活性误报失效**（`utils/linkHealth.js`）：原实现直接 `getChat(chat_id)`，而机器人通常并不在搬运来源频道里，38 条记录全部返回 "chat not found" → 被误判为 ❌ 失效。现在改为**优先按链接里的 `t.me/<username>` 探测**（实测 6/6 恢复为 ✅，并回填了最新频道名）；公开用户名解析失败才算 `dead`；私有/消息链接（`t.me/c/…`）机器人无权验证时判 `unknown` 而不是失效；**429 限流不再计入失效**（返回 `unknown` + `retry_after`，单条手动检查可按建议等待重试一次），批量检查加节流。
- **统计报表**：底部「操作日志明细」改为撑满剩余高度、表格内部滚动（原先悬在页面中间不贴底）；历史日志编号补齐可读名称——`type=23` 现在是「修改文本」（`media_edit_text`），`-1`/缺失编号显示「未知操作」，不再出现 `legacy_type_23` 这类占位名（`utils/opLog.js` 新增 `LEGACY_TYPE_LABELS` / `legacyTypeLabel()`）。
- **「数据库」视图并入「原始数据」**：顶部为数据库存储统计（整库汇总卡 + 各集合明细表），下方为集合浏览；概览与导航同步调整；**平均文档大小保留两位小数**（新增 `fmtBytesFixed`）。
- **标签视图增强**：顶栏新增「➕ 添加标签 / 🗑️ 删除标签 / ⭐ 置顶排序」；点卡片进入标签详情，详情顶栏显示置顶状态并可**点击切换**（置顶时自动取下一个空位，满 40 提示）；「置顶排序」模式下可**直接拖动卡片排序**，保存后按顺序写入置顶位置 1..N（`db/tags.js: reorderTags` + `POST /api/tags/reorder`）。新增接口 `POST /api/tags/{create,delete,pin,reorder}`。
- 测试：新增 `tests/linkHealth.test.js`（11 项：公开链接判活、私有链接不判死、429 不算失效、重试一次等）；`tests/webui.test.js` 新增标签接口与历史类型命名用例；`tests/webuiViews.test.js` 升级为带「HTML → DOM 树」解析的交互测试（媒体详情点选高亮、标签详情置顶切换、拖拽排序保存等 13 项）。

### v0.5.7
- **控制台新增 4 个视图**（`webui/public/app.js` + `index.html` 导航）：
  - **🚚 搬运收录**：`transport` 增删改查 + 活性徽标（✅/❌/❔）+ 失效原因 + 「↗ Telegram」跳转（`utils/tgLink.js` 统一推导，修掉 `-1002` 被误判为频道的边界问题）+ 状态筛选/搜索/分页 + 单条与全量活性检查。
  - **📄 文章**、**📚 合集 / 杂集**：父项与子项的增删改查（删除级联、自动维护父项 `updated_at`、id 业务自增），带搜索与类型筛选。
  - **🗄 数据库**：整库 `dbStats` + 逐集合 `collStats`（文档数 / 数据体积 / 磁盘占用 / 索引占用 / 索引数 / 平均文档大小，按体积排序，15 秒缓存，可手动重算）；取不到时降级为仅文档数并给出原因。概览页新增「🗄 数据库占用」卡片。
- **搬运收录链接活性检查**（`utils/linkHealth.js`，机器人与控制台共用同一份结论）：
  - 判定：`getChat` 成功且机器人在群内 → ✅ 有效；会话不存在 / 机器人被踢 → ❌ 失效；网络/限流/5xx → ❔ 未知（不算失效）；结论写回 `transport.alive / last_check_at / last_check_status / last_check_error`。
  - 触发点：机器人 `/transport` 列表自动补查过期（>6h）记录并私聊提醒新失效项；菜单/明细可全量或单条检查；新增、改链接、改 chat_id 后立即实测并回显；`index.js` 每 6 小时全量巡检，**新失效的链接提醒管理员**（`ADMIN_CHAT_ID`）并记 `transport_check` 日志。
  - 机器人列表与管理界面显示活性徽标、统计行与失效原因。
- 新增 `db/transport.js` 的 `createTransport / updateTransport / updateTransportStatus / getTransportHealth`，新增 `db/dbStats.js`、`utils/linkHealth.js`、`utils/tgLink.js`；新增操作日志动作 `transport_save / transport_delete / transport_check`。
- 新增接口：`GET /api/transport`、`POST /api/transport/{create,update,delete,check}`、`GET /api/articles`、`POST /api/articles/{create,update,delete}`、`POST /api/articles/sub/{create,update,delete}`、`GET /api/collections`、`POST /api/collections/{create,update,delete}`、`POST /api/collections/sub/{create,update,delete}`、`GET /api/db-stats`。
- 测试：`tests/webui.test.js` 新增 13 项领域接口用例（含活性检查注入、级联删除、降级分支），新增 `tests/tgLink.test.js`（链接推导边界）；新增 `tests/webuiViews.test.js`（用最小 DOM 桩在 Node 里**真跑** `public/app.js`，覆盖四个新视图的渲染、筛选/动作请求、字节格式化、降级提示，并回归"视图状态桶不得污染 `state.collections`"）；未登录 401 清单同步补齐新接口。

### v0.5.6
- **标签按钮改为两区版面**（`/send` 发送成功后的打标签面板、`/tag` → 修改消息标签 → 🏷️ 添加标签）：
  - **上区=已有标签**（作用目标上已打上的标签，置顶显示，按钮 `✅名称`，点击移除）；
  - **下区=标签库正常显示**（置顶标签 `pin>0` 按位置排在最前，其余按使用次数，按钮 `+名称`，点击添加）；
  - 两区之间插入分隔行 `── 已有标签（点击移除） ──`（点击只提示上下区含义，不改变状态）；
  - **下区过滤规则**：已打上的非置顶标签不再在下区重复（它们已在上区）；已打上的置顶标签仍在下区显示（置顶标签属于下区置顶）；
  - 点击语义统一为"已打上=移除、未打上=添加"，由回调按当前状态判断，因此 `/tag` 添加标签界面也能直接点掉已有标签（日志按实际增删分别记为 `tag_add`/`tag_remove`）；
  - 翻页只翻下区标签库，上区已有标签每页都在；`/tag` 的 🗑️ 删除标签仍为原单区版面；
  - 新增 `utils/tagUi.js: buildTagRegionKeyboard`（两区键盘构建，纯函数）+ 7 项单元测试；新增分隔行回调 `tag_noop`。

### v0.5.5
- **操作日志全面重构（schema v2，面向月表 / 年终统计）**：
  - 新增统一写入入口 `utils/opLog.js`：`logOperation({ action, category, result, source, userId, chatId, target, counts, detail, error, durationMs })`，
    文档含 `action`（稳定动作键）、`actionLabel`、`category`、`result/error`、`source`、`date`（BSON 日期，供聚合）、`target`、`counts`（产出量）、`detail`（结构化细节）；
    旧的 `insertLog(type, ...)` 保留为兼容包装（旧编号自动映射成动作键），历史数据仍可统计。
  - **补齐此前完全没有日志的功能**：用户封禁/解封/白名单增删、入群/退群/入群审批、群组频道增删改与绑定（管理面板与控制台）、文章与合集的保存删除、
    媒体密码、`/help`、`/log` 自身、机器人启动/关闭、控制台登录（含失败）与控制台原始数据增删改。
  - **细化已有日志**：收录（媒体类型/时长/是否有描述/位置/是否媒体组）、重复命中、收录失败回滚、频道转发归属（新收录 or 仅补位置）、
    发送/回复（目标频道或群组、数量、类型分布、视频时长合计、打包模式、失败原因）、查询（查询词、命中条数）、
    随机视频/图片（模式与时长筛选）、标记（组 ID 与新标记值）、清理（扫描 vs 实际删除的组数与媒体数）、标签（标签名、自动识别标记、改名/置顶/删除同步条数）、
    编辑描述（改前改后、是否超 48 小时降级、来源）等。
  - 删除"进入某模式"的重复入口日志（发送/回复/合并/遮罩/删除/标签模式），避免与真实操作重复计数。
  - `/log` 重写：按大类 → 动作聚合 + 产出量 + 近 7 天/本月/本年三个口径 + 北京时间活跃时段；无 `action` 的旧数据按 `type` 归类回退。
  - `db/index.js` 新增 `date` / `{action,date}` / `{category,date}` / `{userId,date}` / `{result,date}` 索引。
- **WebUI 新增/增强**：
  - **主题跟随系统**：默认「自动」（CSS `prefers-color-scheme`，首屏不闪白），可在 自动/浅色/深色 间循环切换并记住；
  - **标签 → 媒体组**：标签视图点击任意标签即筛选出该标签下的全部媒体组（可一键清除筛选）；
  - **媒体详情可编辑**：新增「↗ 跳转 Telegram 查看」（按群组/频道位置生成 `t.me/c/…` 链接，位于「复制 group_id」之前）、
    在线修改描述（同步 Telegram caption，超 48 小时自动降级为仅改库并提示）、逐条或整组增删标签（可新建标签并自动维护标签库计数）；
  - **视频/文档/音频封面**：收录时保存 Telegram 缩略图 `thumb_file_id`，媒体库与详情页可显示封面（老数据无封面时退化为类型图标）；
  - **用户与群组频道可增删改**：用户（名称/状态/白名单/所在群组）与聊天（名称/类型/绑定）均支持新增、编辑、删除；绑定为双向写入，改绑会清理旧对端、删除会解除对端绑定；
  - **新增「统计报表」视图**：月报/年报（操作总数、媒体与媒体组产出、活跃天数、失败次数、环比、每日柱状趋势、动作 Top15、大类分布、活跃用户）
    + 可筛选的操作日志明细表（新增 `GET /api/oplogs`、`GET /api/stats`）；
  - 新增 `POST /api/media/tags`、`POST /api/media/description`、`POST /api/users/create|update|delete`、`POST /api/groups/create|update|delete`，`GET /api/media` 支持 `tag` 参数。
- **AI 翻译提示词重写**（`webui/db-guide.md`）：新增"意图 → 集合"路由表、更新到 schema v2 的表结构（含 `log` 新字段、`tags` 集合、`is_delete` 语义、`thumb_file_id`）、
  9 个覆盖不同集合与动作的示例，并强制要求按当次需求作答；服务端新增 `action`/`collection` 合法性校验，非法时返回可展开的原始返回便于排查。
- 修复：`webui/server.js` 改聊天/改用户时原先依赖 `findOne` 返回副本，改为显式快照后再更新（避免"先读旧值、更新后再读旧值"读到新值）；
  测试假集合的 `findOne` 改为返回活引用，长期防住这类问题。

### v0.5.4
- **空描述媒体必须照常收录（修复数据丢失）**：
  - 频道转发到讨论群组的媒体，若媒体库中没有对应记录（频道侧未收录、或记录已被 `/clean` 清理），
    原实现只补一条没有 `media` 的 `message`——**描述为空时则什么都写不进去，媒体彻底丢失**。
    现在改为**照常收录**：新建 `group_list` + `media`（群组位置，频道位置在已知频道消息 ID 时一并记录），
    有描述再写 `message`（`group_id` 指向新建的组）。
  - `group_list.is_delete` 语义全项目统一为**唯一入口** `db/groupList.js: syncGroupDeleteByText(groupId)`：
    组内还有 `message`（文本）→ `0`（保留）；已无文本 → 时间戳（可被 `/clean` 清理）。
    收录 / 发送 / 回复 / 编辑 / 清空描述 / 删除全部改走该函数，修复了此前多处写死 `is_delete=0`
    或写死时间戳导致的不一致（消息回复模式无描述时不可清理、群内直接清空描述后仍标记为保留等）。
  - 群组自动收录、`/send` 不再依赖"是否新建组"判断标记，改为按实际文本状态重算，与媒体组内消息到达顺序无关。
  - `/send` 媒体组落库失败不再静默吞掉：会明确提示"已发送但入库失败"，避免用户误以为已收录。
  - 新增回归测试 `tests/recordMedia.test.js`（10 项）+ 内存 Mongo 桩 `tests/helpers/memoryDb.js`，
    离线覆盖收录 / 频道转发兜底 / `/send` / 清空描述等写库链路。
- **Web UI 全新界面**（简洁 / 高效 / 优雅，围绕机器人功能组织）：
  - 左侧导航 + 主区 + 右侧实时日志坞；深色/浅色双主题（同一套设计令牌）、响应式窄屏折叠；
  - 新增 **概览**（统计卡片 + 类型分布 + 最近操作 + 最新媒体组）、**媒体库**（媒体组卡片 + Telegram 图片缩略图代理 +
    描述/标签/位置 + 全部/有描述/可清理筛选 + 搜索分页 + 详情对话框）、**清理中心**（精确待清理数量 + 一键清理，
    与 `/clean` 同逻辑）、**标签**、**用户**、**群组/频道** 视图；原「原始数据」与「AI 翻译」能力保留并重新设计；
  - 快捷键（`/`、`Ctrl/⌘+K`、`R`、`Esc`）、自动刷新开关、缩略图懒加载与失败降级、Toast 与确认对话框。
  - 新增后端接口：`/api/overview`、`/api/media`、`/api/media/detail`、`/api/clean`、`/api/tags`、`/api/users`、
    `/api/groups`、`/api/thumb`（服务端代理 Telegram `getFile`，带内存缓存），原有接口与鉴权保持不变。
  - 新增前端静态一致性测试 `tests/uiStatic.test.js`（选择器、动作分支、主题令牌、既有文案）。

### v0.5.3
- **固定数量回复（`/message_reply N` 打包）**：删除"3 秒静默自动冲刷余量"逻辑——满 N 个立即作为媒体组回复，不足 N 的余量一直留在缓冲等待补满下一组，只有退出（/exit、超时、切换模式）时才冲刷发出。
- **标签按 message 独立（共存）**：
  - 发送/回复时自动识别出的标签只写入**新收录那条 message**（新增 `addTagToMessage` / `removeTagFromMessage` / `getMessageTags`），不再广播到整组；
  - 查看/预览媒体组时"📌 标签"与**显示的文本配对**（显示哪条文本就配哪条的标签）；
  - `/tag` 修改消息标签只作用于**定位用的那条 message**（无记录时回退组内最后新增文本那条），定位界面把组内**所有带文本 message 的标签分别列出**；
  - 编辑 caption（私聊 edit、群内直接编辑、回复 `/edit`）后按新文本**重算该 message 自己的标签**；
  - 修复：回复**媒体组**时只取第一条 caption 导致文本在非首条媒体上漏打标签；
  - 打标签后点"🔁 回复该消息"：回复目标改为**刚打标签的那条 message**。
- **新增：群组/频道回复 `/edit` 快捷编辑**（`handlers/groupReplyEdit.js`）：
  - 管理员**回复一条媒体消息**并发送 `/edit [新描述]`（支持 `/edit@机器人用户名`）直接修改该媒体，跳过"重新发送媒体"步骤；
  - 带文字一步完成；不带文字时群组内等管理员下一条文本（频道仅支持带文字）；
  - 修改 = 改 Telegram caption（HTML 解析失败自动降级）+ 同步数据库 + 按新文本重算标签；超 48 小时自动降级为仅更新数据库；
  - **1 分钟后自动删除全部操作记录**（机器人提示 + 管理员的 `/edit` 命令消息 + 两步流程的输入文本）。
- **指令兼容 `@机器人用户名` 后缀**：所有指令（/edit、/search、/message_reply 等）均可带 `@botname` 使用。
- message 记录新增 `updated_at` 时间戳，用于"组内最后新增/修改文本"判定。

### v0.5.2
- 落库并行化（媒体组逐条并发写入，显著提速）、回复位置切换按钮、数字参数指令（/media_group N 等）、标签展示优化。

### v0.5.1
- 发送/回复/日志多项优化：发送媒体组注释位置还原、群组自动收录去重兜底、操作日志完善等。
