# Telegram 媒体管理机器人

一个功能丰富的 Telegram Bot，基于 Node.js 开发，用于群组/频道媒体消息的自动收录、检索、回复与管理，并集成群组管理和用户权限控制。

**版本:** 0.5.25 | **运行环境:** Node.js | **数据库:** MongoDB Atlas

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

   浏览器访问 `http://127.0.0.1:9700`。登录密码存放在**数据库 `settings` 集合**（`_id = app_settings`）的 `webui_password` 字段，需自行写入（见下）。

6. **（可选）test-log 模式（AI 可读临时日志）：**

   ```bash
   npm run start:test     # 或 node index.js test
   ```

   在 webui 模式基础上，日志除正常写入 `logs/<年>/<月>/<周>/<日>.log` 外，额外复制一份到 `logs/test-log/`（仅含 `log.log`、`error.log` 两个扁平文件），**供 AI 读取分析**。`logs/test-log` 在**每次以 test 启动时初始化**（清空上次内容），关闭时不清理由 test 模式产生的数据。

7. **（可选，推荐）看门狗模式（崩溃自动重启 + 通知管理员）：**

   ```bash
   node watchdog.js            # 等价于 node index.js
   node watchdog.js webui      # 等价于 node index.js webui（或直接跑「Telegram BOT.bat」）
   node watchdog.js test       # 等价于 node index.js test
   ```

   看门狗是**唯一入口**，参数与直接启动 bot 完全一致；崩溃后用**同一份参数**重新拉起（`node watchdog.js webui` 崩了就还是用 `webui` 重启）。

   - **崩溃检测**：子进程退出（`exitCode != 0` / 被信号杀 / OOM / 未捕获致命错误）→ **强制收掉残留进程** → 起一个**短命通知进程**发崩溃消息 → 等 **30 秒**后按原启动方式重启；
   - **崩溃通知由一个独立的短命进程发送**（`watchdog/notify-bot.js`，存活 `WATCHDOG_NOTIFY_TTL` 默认 5 秒，**无论发送成功与否都自行结束**）。这样崩溃播报与主 bot 的生命周期完全解耦：即使主 bot 还没起来、或起来后又立刻崩，崩溃消息也已经发出去了；它与 30 秒重启计时**互不影响**；
   - **软卡死检测**：每 30 秒轮询 `GET /health`，连续 3 次无响应即判定"进程活着但已不工作"，走软重启；
   - **重启前优雅关闭**：先 `POST /shutdown` 让 bot 自己收尾（关轮询 / 落盘日志 / 关数据库），超时才 `taskkill /T /F` 强杀进程树。Windows 上无法跨进程发信号，这个 HTTP 出口是唯一可行的优雅关闭途径；
   - **重启报告（由主 bot 第一时间发）**：崩溃现场写在 `watchdog/crash-marker.json`，重启后**主 bot 在数据库连上、polling 就绪的第一时间**自己给管理员发「♻️ BOT重启成功」（读完即删）；**不再**由看门狗等健康确认（原 `WATCHDOG_RESTART_REPORT_AFTER` 默认 30 秒 + 启动宽限期，用户往往几分钟后才收到，已移除）；达到重启上限则发「🛑 已停止自动重启，请人工介入」；
   - **报告只列问题**：崩溃与重启报告都**只取最近的 warn / erro 日志**（最多 `WATCHDOG_REPORT_LINES` 条，默认 **3**，去掉时间戳与颜色码），标题**首尾各出现一次**，形如：
     ```
     ⚠️ BOT出现意外崩溃，稍后尝试重启

     崩溃信息：
     [warn] 会话超时
     [erro] ETELEGRAM: 400 Bad Request: chat not found

     ⚠️ BOT出现意外崩溃，稍后尝试重启
     ```
   - **`/restart` 手动重启（仅管理员，已加入 /help 的「♻️ 重启」按钮）**：置位"重启意图"后走优雅关闭，以退出码 **75** 结束；看门狗把 75 解释为"用户要求重启"，**立即**按原启动方式拉起（不当作崩溃、不等 30 秒、不发崩溃报告）。未被看门狗托管时（直接 `node index.js`）进程会正常退出而不会自己起来，提示里会写明；
   - **重启风暴保护**：10 分钟内崩溃超过 5 次 → 停止自动重启并提醒人工介入；连续存活满 60 秒则重置计数（避免"很久崩一次"累积到上限）；
   - **孤儿防护**：看门狗被硬杀（任务管理器结束进程等）时，bot 会通过 `BOT_PARENT_PID` 发现父进程消失并自行退出，不会留下抢轮询的孤儿实例（否则下次启动会出现 Telegram 409）；
   - **终端颜色**：看门狗自身输出带颜色，且**完整透传 bot 的颜色输出**（不会把 bot 的 `[时间] [SUCC/ERRO] …` 变成无色），格式与加看门狗之前一致；看门狗行额外加 `[看门狗]` 前缀便于区分；
   - 看门狗自身日志在 `watchdog/watchdog.log`（独立于 bot 日志），崩溃现场写在 `watchdog/crash-marker.json` 并会被 bot 读取后删除（同一次崩溃只留痕一次，opLog 动作 `bot_watchdog_restart`）；
   - 所有参数都有默认值（见 `.env.example` 的 `WATCHDOG_*`），不配置也能跑。直接 `node index.js webui` 仍可正常使用（此时没有看门狗，行为与以前一致）。

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

| 事件                | 处理器                                        | 触发时机           |
| ------------------- | --------------------------------------------- | ------------------ |
| `message`           | `handlePrivateMessage` / `handleGroupMessage` | 收到新消息         |
| `edited_message`    | `handleGroupEditedMessage`                    | 消息被编辑         |
| `callback_query`    | `handleCallbackQuery`                         | 点击内联按钮       |
| `chat_member`       | 自动处理用户加入/离开                         | 群组成员变更       |
| `my_chat_member`    | 自动注册 Bot 加入的群组                       | Bot 被添加为管理员 |
| `chat_join_request` | 自动审批入群请求                              | 用户申请加群       |

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

**导出的关键配置：**

| 配置项               | 类型     | 说明               |
| -------------------- | -------- | ------------------ |
| `TELEGRAM_BOT_TOKEN` | string   | Bot Token          |
| `MONGODB_URI`        | string   | 数据库连接串       |
| `ADMIN_CHAT_IDS`     | number[] | 管理员用户 ID 列表 |

---

### 4. 数据库连接 — database.js

**路径:** `database.js` **职责:** 管理 MongoDB 连接生命周期

**实现机制：**

- 使用原生 `mongodb` v6.21.0 驱动（非 Mongoose）
- `connectDB()` 实现带指数退避的重试逻辑：
  - 重试次数：6 次
  - 每次间隔递增：5s → 10s → 15s → 20s → 25s
  - 总计最长等待约 30 秒
- 只有一个（生产）数据库：`DB_NAME`（`telegram_bot`）。
  历史上曾有 `--test` 专用测试库模式（`_test` 后缀 + `TEST_MONGODB_URI`），已移除；
  `node index test` 只影响日志（额外写一份到 `logs/test-log/`），仍连同一个库。
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
- **test 模式**（`node index test`）：日志额外复制一份到 `logs/test-log/log.log`、`logs/test-log/error.log`
  （logs 目录内的扁平临时日志，启动时重置，便于本次运行统一查看）
- **关闭清理**：收到关闭信号时立即删除"定时删除"的群组提示消息与消息回复模式遗留的"正在回复该消息"提示，
  并刷盘日志队列保证日志不丢失
- 日志目录在首次写入时自动创建

---

### 6. 媒体处理 — media.js

**路径:** `media.js` **职责:** 从消息中提取媒体、发送媒体、管理媒体收集状态

**核心函数：**

| 函数                                                  | 功能                 | 实现要点                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extractMediaFromMessage(msg)`                        | 从消息中提取媒体信息 | 检测 photo/video/audio/document 类型，返回标准化媒体对象；**文档/音频额外给出 `mediaName`**（文档取 `file_name`，音频优先 `file_name`、其次「标题 - 艺术家」），图片/视频不取。**不再自动为音频拼描述**：没有 caption 就是没有描述，严格按用户发送的内容收录                                                                                                        |
| `recordTextMedia({sentMsg, ...})`                     | 收录一条纯文本       | 写 `media_type='text'`：内容进 `media_name`、`entities` 进 `media_entities`（保留 Telegram 格式）                                                                                                                                                                                                                                                                   |
| `sendMediaAsReply(chatId, replyId, media)`            | 回复发送单个媒体     | 按 media_type 调用不同的 send 方法，附带原文链接按钮                                                                                                                                                                                                                                                                                                                |
| `sendMediaGroupAsReply(chatId, replyId, items, size)` | 批量发送媒体组       | 按 subgroup 分组发送，每批最多 10 条；**注释先行带上**：描述即使原本不在第一条，也先把第一条注释内联带上（发送那一刻产生的副本 —— 尤其是频道帖被 Telegram 自动转发到关联讨论群 —— 才会带上描述），发完再编辑还原到原本的媒体并清掉第一条（`albumCaptionCarry` / `clearAlbumCaption`）；**文本媒体不进相册，按原文顺序单独作为文本消息发出**（带 entities 保留格式） |
| `clearMediaGroupState(userId, send, state)`           | 清理收集状态并发送   | 将 `mediaCollection` 中的暂存媒体分批发出后清空                                                                                                                                                                                                                                                                                                                     |
| `sendMediaSubgroup(chatId, groupId, subgroup)`        | 发送指定子组         | 直接查询数据库获取指定 subgroup 的媒体列表；遇到文本媒体先冲刷相册再单独发文本                                                                                                                                                                                                                                                                                      |
| `sendMediaGroup(chatId, groupId)`                     | 发送完整媒体组       | 遍历所有 subgroup 逐批发送                                                                                                                                                                                                                                                                                                                                          |

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

| 函数                          | 说明                     |
| ----------------------------- | ------------------------ |
| `getUserState(userId)`        | 获取状态，超时自动清理   |
| `getRawUserState(userId)`     | 获取原始状态，不检测超时 |
| `setUserState(userId, state)` | 设置/覆盖状态            |
| `deleteUserState(userId)`     | 删除状态                 |
| `updateUserActivity(userId)`  | 更新最后活动时间         |

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

**语法支持（三段，必须按这个顺序出现，否则视为格式错误、不予查询）：**
```
关键字 +类型标记 -标签
└─ 0 ─┘ └─ 1 ─┘ └─ 2 ┘

关键字 -标签1 标签2       宽松标签（命中任一即可，多个用空格或 、, 分隔，不区分大小写）
关键字 --标签1 标签2      严格标签（必须同时包含 -- 后所有标签）
关键字 +d                仅文件（+a 音频 / +p 图片 / +v 视频 / +t 文本，可写多个表示并集）
关键字 +v -高清 风景       三段组合：关键字 + 类型 + 标签
关键字                    文本模糊搜索（匹配描述 + 文件/音乐名称）
```
- 三段**都可以省略**（省略即不限制）；只要有 ≥2 段同时出现，就必须按 `关键字 → +类型 → -标签` 的顺序写：
  `+d 关键字`（类型跑到关键字前）、`关键字 -标签 +d`（类型跑到标签后）都会被拒绝，机器人回一条语法提示而不是执行查询；
- 标签段是"黏"的：`-图片 高清` 里的 `高清` 也算标签（与 `-图片、高清` 等价）；
- 未知的 `+xxx`（例如搜索词 `+1`）不算类型标记，按普通关键字处理；
- 段内只要出现 `--`，整段按严格模式理解。

**实现：**
```javascript
// 输出结构
{
  tags: ['图片', '教程'],   // 宽松标签数组（小写去重，任一命中）
  tagsAll: ['风光'],        // 严格标签数组（必须全部命中）
  types: ['video'],         // media_type 数组（+d/+a/+p/+v/+t → document/audio/photo/video/text）
  keyword: '关键字',        // 关键字段纯文本
  valid: true               // 段落顺序是否合法（false → handleQuery 不予查询）
}
```

> 媒体类型标记为 `+d 文件 / +a 音频 / +p 图片 / +v 视频 / +t 文本`；等级（`+S` 等）标记已移除，等级字段不再写入 message。


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

| 导出                                              | 功能                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `logOperation(entry)`                             | **唯一写入入口**：规范化 `action`/`category`/`result`/`source`/`target`/`counts`/`detail`，写入 `date`+`time`，失败只记日志不抛错 |
| `insertLog(type, userId, extra)`                  | 兼容旧编号的包装（旧调用无需改动，自动映射成动作键）                                                                              |
| `ACTIONS` / `CATEGORIES` / `ACTION_BY_TYPE`       | 动作目录、大类名称、旧编号反查表                                                                                                  |
| `getCatalog()`                                    | 动作目录（WebUI `/api/oplogs` 与 `/api/stats` 返回给前端做标签展示）                                                              |
| `actionLabel(action)` / `categoryLabel(category)` | 展示用中文名                                                                                                                      |

详见 [db/log.js — 操作日志（schema v2）](#dblogjs--操作日志schema-v2)。

#### sendMedia.js — 通用媒体组发送

封装 `bot.sendMediaGroup()`，处理媒体组发送的边界情况：
- 分批发送（Telegram 限制每批最多 10 条）
- 错误重试

#### linkHealth.js — 收录链接活性检查

`/transport` 列表、控制台「搬运收录」与每 6 小时的巡检任务共用：

| 导出                                                                      | 功能                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkTransportLink(record)`                                              | 实测单条：**优先按链接里的 `t.me/<username>` 探测**（机器人通常并不在搬运来源频道里，直接按 chat_id 查会得到 "chat not found"，早期实现因此把所有公开频道误报为失效）→ `ok`；公开用户名解析失败（频道已删除/改名/被封）→ `dead`；机器人能按 chat_id 访问但已被踢/退出 → `dead`；**私有/消息链接**（`t.me/c/…`）无权验证 → `unknown`（绝不判死）；429/网络/5xx → `unknown` |
| `checkAllTransports({ records, concurrency, force, maxAgeMs, onResult })` | 并发检查（默认 4，带节流与 429 兜底）并写回数据库；返回 `{ total, checked, ok, dead, newlyDead, recovered, unknown, skipped }`                                                                                                                                                                                                                                            |
| `formatDeadReport(deadList)`                                              | 失效清单文本（名称 / chat_id / 链接 / 原因），通知与菜单共用                                                                                                                                                                                                                                                                                                              |
| `notifyAdmins(text)`                                                      | 发送给 `ADMIN_CHAT_ID`（逗号分隔的多个管理员）                                                                                                                                                                                                                                                                                                                            |
| `transportLinkUrl(record)`                                                | 见 `utils/tgLink.js`（重新导出）                                                                                                                                                                                                                                                                                                                                          |
| `publicUsernameOf(url)` / `rateLimitRetryAfter(err)`                      | 从链接里取公开用户名；从 429 错误里取建议重试秒数                                                                                                                                                                                                                                                                                                                         |
| `isDeadError(err)` / `isTransientError(err)`                              | 区分"链接失效"与"临时故障"（**429/5xx/网络一律算临时**，绝不算失效）                                                                                                                                                                                                                                                                                                      |

**检查触发点：** ① 用户执行 `/transport` 进入列表时触发一次（带 10 分钟节流与并发去重）；② 菜单/明细里的「🔍 检查链接活性」（全量）与「检查该链接活性」（单条）；③ 新增收录 / 改链接 / 改 chat_id 后立即实测并回显结论；④ WebUI 进入「搬运收录」视图时触发一次（同样节流）。结果记为 `transport_check` 操作日志。

> **不再向管理员发 Telegram 消息**：巡检发现失效链接时只写日志与 opLog，并提示"请在 WebUI 控制台「搬运」页编辑或删除"。也**不再随 bot 启动自动巡检**（早期版本是启动 1 分钟后首查 + 每 6 小时一次）。

#### tgLink.js — Telegram 链接（纯函数）

`transportLinkUrl({ chat_id, url })`：有 http(s) 链接就用它；否则用 chat_id 推导 `https://t.me/c/<内部ID>`——**仅当形如 `-100` + 至少 9 位**（真正的超级群/频道）才推导，避免 `-1002` 这类普通群被误判成「频道 2」。控制台与机器人共用，保证跳转链接口径一致。

#### messageLocator.js — 把一条消息定位成可编辑目标

`/edit` 之外的三条定位路径共用（私聊消息链接 / 转发来源、群组里被回复的频道转发副本）：

| 导出                                   | 功能                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseMessageLink(text)`               | 解析消息链接（纯函数）：`t.me/c/<内部ID>/<消息ID>` → `chatId=-100<内部ID>`；`t.me/<公开用户名>/<消息ID>` → 只给用户名（需 `getChat` 解析）；邀请链接等非消息链接返回 null |
| `resolveUsernameChatId(username, bot)` | 公开用户名 → chat_id（`getChat('@name')`，机器人无权访问时返回 null）                                                                                                     |
| `resolveMessageOrigin(msg, bot)`       | 从一条消息解析原始位置：`forward_origin`（频道帖带 `message_id`）→ 旧版 `forward_from_chat` + `forward_from_message_id` → 文本/说明里的消息链接                           |

> **Telegram 限制：** 从**群组**转发的消息（`MessageOriginChat`）**不带原消息 ID**，无法定位 —— 这时请改用消息链接。

#### textMediaEdit.js — 文本媒体的正文修改

`applyTextMediaEdit(fileUniqueId, cleanText, entities)`：改写 `media.media_name` 与 `media_entities`（**严格保留用户发送的格式**；新正文没有格式时清掉旧 entities），若该 `file_unique_id` 上存在 `message` 记录（历史数据 / 控制台补过描述）再同步它的 `text` 与标签。群组回复 `/edit`、私聊 `/edit`、控制台改描述共用。

#### textEntities.js — 编辑时保留用户发送的文本格式（纯函数）

Telegram 的富文本是「纯文本 + entities」（加粗 / 斜体 / 下划线 / 删除线 / 剧透 / 代码 / 链接 / 自定义 emoji…），
offset/length 单位是 UTF-16 code unit（与 JS 字符串下标一致）。**保留格式的唯一正确做法是把用户消息里的 entities 原样带上**，
不要用 `parse_mode` 去解析原文（用户写的 `<3`、`*星号*` 会被吃掉甚至报错）——与 `/send`、`/reply` 的文本转发同一套思路（`utils/forwardText.js`）。

| 导出                                          | 功能                                                                                                                                                                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalizeEntities(entities)`                 | 校验 / 规范化：丢掉 offset/length 非法的项，按位置排序，不改动入参                                                                                                                                                                                                |
| `shiftEntities(entities, start, length)`      | 已知截取位置时按**精确下标**平移 / 裁剪（正文与命令前缀字符重合也不会错位，如 `/edit@SexFavoritesBOT BOT`）                                                                                                                                                       |
| `projectEntities(entities, rawText, newText)` | 正文被**截取**后（去 `/edit@Bot ` 前缀、去首尾空白、去 `#X` 后缀）平移 / 裁剪 entities；命令自身的 `bot_command` 被丢掉，越界项裁掉或丢弃；`newText` 不是 `rawText` 子串时返回空数组（宁可丢格式，也不给出错位的实体）                                            |
| `captionEntities(entities)`                   | 过滤出 caption 允许的类型（`bold/italic/underline/strikethrough/spoiler/code/pre/text_link/text_mention/custom_emoji/blockquote`）；`mention`/`hashtag`/`url`/`bot_command` 等自动识别类型在 caption 里会被 Telegram 拒绝，过滤掉即可（客户端仍会自动渲染成链接） |

> **编辑正文时的两条路径**（`utils/editTarget.js`）：有 entities → `editMessageText({ entities })` /
> `editMessageCaption({ caption_entities })`（不用 parse_mode）；没有 entities → 退回原来的「HTML 解析 → 纯文本」；
> entities 被 Telegram 拒绝时丢掉 entities 用纯文本重试，保证正文一定写得进去。

#### tagUi.js — 标签按钮键盘（两区版面）
`/send` 打标签面板与 `/tag` 标签模式共用：

| 导出                                             | 功能                                                                                                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildTagKeyboard(tags, opts)`                   | 单区列表：每行 4 个、每页 40 个 + 翻页按钮；`marker` 可给按钮加 `✅`/`+` 前缀                                                                                                              |
| `buildTagRegionKeyboard(applied, library, opts)` | **两区版面**（上区已有标签 / 下区标签库，见下）                                                                                                                                           |
| `splitTagInput(text)`                            | 手动输入解析（空格 / `、` / `,` 分隔，去重保留首现）；只返回**要添加**的标签，`-标签` 前缀会被忽略                                                                                        |
| `parseTagInput(text)`                            | 手动输入完整解析：一次可写多个（空格 / `、` / `,` 分隔），前缀 `-` 表示**移除** → `{ add: [...], remove: [...] }`（规则见下表）                                                           |
| `matchTagsInText(text, tags)`                    | 文本中识别已存在的标签（大小写不敏感）。**纯英文/数字标签按整词匹配**（`hello` 不会在 `hello` 里匹配出 `h`/`e`/`he`/`el`，需要片段请自行加标签）；含中文等非 ASCII 字符的标签仍按子串匹配 |
| `paginate(items, page)`                          | 分页切片（每页 40 个）                                                                                                                                                                    |

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

**手动输入规则**（`parseTagInput`，机器人端与控制台**同一套**，适用于任意添加标签处 —— `/tag` 修改消息标签、`/send` 发送成功后弹出的打标签面板、控制台媒体详情的标签输入框）：

| 输入           | 效果                                                           |
| -------------- | -------------------------------------------------------------- |
| `xx yy`        | 添加 `XX`、`YY`（空格 / `、` / `,` / `，` 都能分隔，换行也算） |
| `xx -yy`       | 添加 `XX`，移除 `YY`                                           |
| `-xx -yy`      | 只移除 `XX`、`YY`                                              |
| `xx -xx`       | 同名同时出现 → **以移除为准**（不会又加又删）                  |
| `jk-2 a-b`     | 标签名中间的 `-` 不是前缀，照常当标签名                        |
| `－xx` / `−xx` | 中文输入法的全角减号同样识别为移除                             |

- 各榜单内部去重（大小写不敏感、保留首现）；标签名统一大写后才落库
- `/tag` 的 ➕ 添加面板：无前缀 = 添加、`-` 前缀 = 移除；🗑️ 删除面板：两者都算移除（面板语义优先）
- `/send` 打标签面板同理：无前缀添加、`-` 前缀移除
- 控制台媒体详情输入框同样支持（如 `xx yy -zz`）：回车或「➕ 添加」都按这套规则提交**一次** `POST /api/media/tags`（`add` / `remove` 同时下发）；只有 `-` 没有名字时给提示且不发请求

#### tagSession.js — 打标签会话（发送 / 回复写库成功后共用）

`/send`、消息回复、编辑描述等写库成功后的打标签流程实现，**与模式解耦**（不切换、不退出原模式）：

| 导出                                                                      | 功能                                                                                                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `recordAndTag(userId, { groupId, items })`                                | 批量收录 message + 自动匹配标签 + 依次送入打标签队列；返回 `boolean[]`（`true` = 该条提示语由面板承载，调用方不再发普通提示） |
| `recordMessageWithAutoTags(item)`                                         | 单条收录（只有带描述才写 `message`）+ 自动补充文本中已存在的标签                                                              |
| `enqueueTagTarget(userId, target)`                                        | 入队（队列为空时立即激活并弹出面板）；同一目标不重复入队                                                                      |
| `advanceToNext(userId)`                                                   | 点《✅ 完成》后切换队列中的下一个；队列为空则结束本次打标签                                                                    |
| `showActivePanel(userId, text)`                                           | 用成功提示刷新当前面板（无活动目标时退化为普通提示消息）                                                                      |
| `handleTagText(msg, session)`                                             | **纯文本 = 打标签**：解析空格/`、` 分隔的多个标签，`-标签` 表示移除，不存在的自动创建                                         |
| `handleTagCallback(query)`                                                | `sendtag:*`（上区移除 / 下区添加）、`sendtag_page:*`（翻页）、`sendtag_done`（完成）、`sendtag_reply`（进入回复模式）         |
| `isTagging(userId)` / `getTagSession(userId)` / `clearTagSession(userId)` | 会话查询与清理（限流入口、`/exit`、超时、切换模式时调用）                                                                     |

> 会话只存在于内存（与其它模式状态一致），不随模式状态清理而消失；有 2 小时空闲上限。
> `handlers/messageHandlers.js` 在分发模式之前先判断会话：**有活动目标时纯文本一律作为标签输入**
> （不发送、不查询），媒体消息照常交给当前模式处理。

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

| 集合            | 索引                     | 用途                 |
| --------------- | ------------------------ | -------------------- |
| `message`       | `file_unique_id` (唯一)  | 去重                 |
| `message`       | `group_id`               | 按组查询             |
| `message`       | `{media_type, text}`     | 全文搜索             |
| `media`         | `file_unique_id` (唯一)  | 去重                 |
| `media`         | `{group_id, message_id}` | 按组查询             |
| `media`         | `media_type`             | 类型筛选             |
| `media`         | `video_time`             | 视频时长筛选         |
| `group_list`    | `group_id` (唯一)        | 组汇总               |
| `channel_group` | `id` (唯一)              | 群组标识             |
| `users`         | `id` (唯一)              | 用户标识             |
| `users`         | `group`                  | 所在群组查询         |
| `users`         | `{state, white}`         | 权限筛选             |
| `log`           | `time` (倒序)            | 时间排序             |
| `transport`     | `chat_id` (唯一)         | 搬运记录             |
| `tags`          | `name` (唯一)            | 标签库（大写标签名） |

#### db/settings.js — 全局设置（含缓存）

**实现要点：**
- 使用固定 `_id: "app_settings"` 的单文档存储
- `getSettings()` 带 5 秒内存缓存，减少数据库请求
- `loadSettings(config)` 启动时将 DB 中的设置注入 config 对象
- `updateSetting(config, key, value)` 更新后主动刷新缓存
- 所有设置项有合理的默认值

**可配置项：**

| 键                        | 类型    | 默认值  | 说明               |
| ------------------------- | ------- | ------- | ------------------ |
| `search_random`           | boolean | false   | 是否随机搜索结果   |
| `random_pictures`         | boolean | false   | 随机图片功能开关   |
| `random_pictures_num`     | number  | 9       | 随机图片数量       |
| `random_videos`           | boolean | false   | 随机视频功能开关   |
| `random_videos_time`      | string  | "<1min" | 视频时长筛选条件   |
| `random_videos_num_text`  | number  | 15      | 随机视频文字列表数 |
| `random_videos_num_video` | number  | 10      | 随机视频实际发送数 |
| `media_group_num`         | number  | 10      | 媒体合并默认数量   |

> 标签已迁移至**独立 `tags` 集合**（`db/tags.js`），不再存储于 settings：每标签一条 `{name, pin, count}`——`pin`=置顶位置（0 不置顶；>0 为按钮网格位置，每行 4 个、1 为左上第一个按钮），`count`=使用次数。

#### db/media.js — 媒体文件记录

核心数据操作：

| 函数                                              | 功能                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insertMedia(mediaRecord)`                        | 插入新的媒体记录（支持 `group`/`channel` 双位置字段、`media_name`、`media_entities`）                                                                      |
| `findMediaByFileUniqueId(fileUniqueId)`           | 按 file_unique_id 精确查询                                                                                                                                 |
| `findMediaByGroupId(groupId)`                     | 按 group_id 查询所有媒体                                                                                                                                   |
| `getMaxSubgroup(groupId)`                         | 获取指定组的最大子组编号                                                                                                                                   |
| `deleteMediaByFileUniqueId(fileUniqueId)`         | 按 file_unique_id 删除                                                                                                                                     |
| `findMediaByPosition(chatId, messageId)`          | 按「聊天 + 消息 ID」反查媒体（群组位置 / 频道位置 / 旧数据顶层位置，以及文本媒体的 `text:<chatId>:<messageId>`）——回复 `/edit`、消息链接、转发来源定位共用 |
| `updateTextMediaContent(fileUniqueId, text)`      | 改写文本媒体的正文（`media_name`，并清掉与新正文错位的旧 `media_entities`）                                                                                |
| `updateMediaPassword(fileUniqueId, pwd)`          | 更新媒体密码                                                                                                                                               |
| `buildMediaLocation(chatId, messageId, chatType)` | 按聊天类型构建媒体位置（频道 → `channel`，群组 → `group`）                                                                                                 |

> **双位置字段：** `group: { chat_id, message_id }`（群组位置）与 `channel: { chat_id, message_id }`（频道位置）。
> 频道转发媒体两项都有；给空媒体补注释时可据此获得双位置信息。
>
> **`media_name`（文件/音乐名称）：** 收录时**只对文档与音频**写入（图片、视频不写）——文档取 Telegram 的 `file_name`，音频优先 `file_name`、没有则用「标题 - 艺术家」。它是"按文件名搜索"的唯一数据来源（见 `handlers/queryHandler.js` 的第二个数据源；WebUI 媒体库的搜索同样会匹配它）。
>
> **文本媒体（`media_type: 'text'`）：** `/send`、`/reply` 发出的纯文本通过 `media.recordTextMedia()` 收录成一条 media：文本内容存在 `media_name`（"借用"文件名那个字段），原消息的 `entities` 存在 `media_entities` 以**保留 Telegram 文本格式**；文本没有 Telegram file，`file_unique_id` 用 `text:<chatId>:<messageId>` 造唯一值。不写 `message` 集合（message 是"描述 + 标签"的载体），但 `group_list.is_delete` 会把文本媒体视为"有内容"，不会被 `/clean` 清掉。
> 它的正文**也能改**（改的是消息 `text`、落库改 `media_name`，见 `utils/textMediaEdit.js`）：群组/频道里管理员回复该消息发 `/edit 新文本`，或私聊 `/edit` 后发消息链接 / 转发该消息。文本消息**不能清空**（Telegram 不允许空文本）。

#### db/message.js — 消息记录

| 函数                                                               | 功能                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| `upsertMessage(messageRecord)`                                     | 插入或更新消息记录（支持 `tags`、`channel_forward` 字段） |
| `findMessageByFileUniqueId(fileUniqueId)`                          | 按 file_unique_id 查询                                    |
| `deleteMessageByFileUniqueId(fileUniqueId)`                        | 删除消息                                                  |
| `findMessagesByGroupId(groupId)`                                   | 按组查询所有消息                                          |
| `addTagToGroup(groupId, tag)` / `removeTagFromGroup(groupId, tag)` | 给媒体组所有消息添加/移除标签                             |
| `getGroupTags(groupId)`                                            | 获取媒体组全部标签（并集）                                |

> **channel_forward 字段：** `{ is_channel: true, channel_chat_id, channel_message_id, group_chat_id, group_message_id }`，
> 标记消息为频道转发并记录群组中该消息的位置，回复时可选频道或群组。

#### db/log.js — 操作日志（schema v2）

**实现已迁移到 `utils/opLog.js`**，`db/log.js` 只保留旧编号常量与兼容包装（`insertLog(type, userId, extra)` → 自动映射成动作键）。

日志文档结构（面向月表 / 年终统计设计）：

| 字段                              | 说明                                                                                                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`                          | 稳定动作键（如 `media_save`、`send_media`、`reply_media`、`query_keyword`、`media_clean_execute`、`tag_add`、`user_ban`、`chat_bind`、`setting_update`、`bot_start`…）                                                                                                |
| `actionLabel`                     | 动作中文名（冗余存储，改文案不影响历史数据）                                                                                                                                                                                                                          |
| `category`                        | 大类：`media`/`send`/`reply`/`query`/`clean`/`tag`/`user`/`chat`/`setting`/`content`/`transport`/`webui`/`system`                                                                                                                                                     |
| `result` / `error`                | `ok` \| `fail`，失败时带错误信息（可统计失败率）                                                                                                                                                                                                                      |
| `source`                          | 发生位置：`private`/`group`/`channel`/`webui`/`system`                                                                                                                                                                                                                |
| `date` / `time`                   | `date` 为 BSON 日期（`$year`/`$month`/`$dateToString` 聚合用），`time` 为毫秒时间戳（兼容旧数据）                                                                                                                                                                     |
| `userId` / `chatId` / `messageId` | 操作者与触发上下文                                                                                                                                                                                                                                                    |
| `target`                          | 操作对象 `{ type, id }`（`media`/`media_group`/`tag`/`user`/`chat`/`setting`/`article`/`collection`）                                                                                                                                                                 |
| `counts`                          | 产出量数值：`{ media, groups, users, tags, edits, queries, results, texts, chats, articles, collections … }`                                                                                                                                                          |
| `detail`                          | 结构化细节：`{ query, mediaType, videoTime, tags, hasCaption, scope, via, status, name, before, after … }`                                                                                                                                                            |
| `durationMs`                      | 可选耗时                                                                                                                                                                                                                                                              |
| `type`                            | 旧编号（0=启动,1=收录,2=修改,3=删除,11/12=随机,13=回复,14/15/21=合并/遮罩,16=帮助,17=查找,18=清理,19=删除模式,20=标记,22=查询,23=修改,24=设置,25=发送,26=标签,27=控制台登录,28=控制台数据操作,29-32=用户,33=群组频道,34/35=文章合集,36=搬运），继续保留以兼容历史统计 |

**唯一写入入口：** `logOperation({ action, category, result, source, userId, chatId, target, counts, detail, error, durationMs })`
—— 写入失败只记 `logger.error`，绝不影响业务流程。

**已接线的动作（节选）：**

| 大类                     | 动作                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| media                    | `media_save`（收录）/`media_save_duplicate`（重复命中）/`media_save_fail`（收录失败回滚）/`channel_forward`（频道转发归属，区分新收录与补位置）/`media_edit`（描述修改：私聊、群内两步、回复 `/edit`、控制台）`media_delete`（清空描述）/`media_delete_one`/`media_delete_group`/`mark`/`media_merge`/`media_hide`/`media_unhide`/`media_password` |
| send / reply             | `send_media`/`send_text`/`send_fail`/`reply_media`/`reply_fail`（含打包模式、目标频道/群组、媒体类型与时长合计）                                                                                                                                                                                                                                   |
| query                    | `query_keyword`（含命中条数）/`search`/`help`/`log_view`/`random_video`/`random_picture`                                                                                                                                                                                                                                                           |
| clean                    | `media_clean_scan`（扫描）/`media_clean_execute`（实际删除的组数与媒体数）                                                                                                                                                                                                                                                                         |
| tag                      | `tag_add`/`tag_remove`/`tag_create`/`tag_rename`/`tag_delete`/`tag_pin`（自动识别打标签记 `tag_add` + `detail.auto=true`）                                                                                                                                                                                                                         |
| user                     | `user_create`/`user_update`/`user_delete`/`user_ban`/`user_unban`/`user_whitelist_add`/`user_whitelist_remove`/`user_join`/`user_leave`/`user_join_request`（含审批结论与原因）                                                                                                                                                                    |
| chat / setting / content | `chat_create`/`chat_update`/`chat_delete`/`chat_bind`/`chat_unbind`/`setting_update`/`article_save`/`article_delete`/`collection_save`/`collection_delete`                                                                                                                                                                                         |
| system / webui           | `bot_start`（版本、数据库、运行模式）/`bot_stop`（信号、运行时长）/`webui_login`/`webui_login_fail`/`webui_db_execute`（控制台原始增删改）                                                                                                                                                                                                         |

**查看统计的两种方式：**
- 机器人内 `/log`：近 7 天明细（大类 → 动作）+ 本月 / 本年汇总 + 活跃时段条形图（时间口径按北京时间，兼容无 `action` 的历史数据）
- Web UI「统计报表」：统一**按年统计**（顶栏右上角 ◀ ▶ 切换年份）、环比、**每日操作量 GitHub 全年方格图**、动作明细、大类分布、活跃用户、**活跃时间**、失败统计 + 可筛选的操作日志明细表

**索引**（`db/index.js`）：`time -1`、`date -1`、`{action,date}`、`{category,date}`、`{userId,date}`、`{result,date}`

#### db/groupList.js — 媒体组汇总

| 函数                                             | 功能                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upsertGroupList(groupId, increment)`            | 原子增加 `is_group` 计数（$inc）                                                                                                                         |
| `syncGroupDeleteByText(groupId)`                 | **按组内是否还有文本重算 `is_delete`**（唯一判定入口，见下）                                                                                             |
| `setGroupDelete(groupId, timestamp)`             | 直接设置删除标记（仅 `syncGroupDeleteByText` 与回滚使用）                                                                                                |
| `findGroupList(groupId)`                         | 查询组信息                                                                                                                                               |
| `deleteGroupList(groupId)`                       | 删除组记录                                                                                                                                               |
| `syncGroupTags(groupId)`                         | **按组内所有 `message.tags` 重算 `group_list.tags`**（汇总，无标签则删字段）                                                                             |
| `applyTagChangeToGroupTags(groupId, tag, delta)` | 单个标签增量同步到 `group_list.tags`（$addToSet / $pull）                                                                                                |
| `syncAllGroupTags()`                             | 全库重算 `group_list.tags`（标签改名、删除后同步；需要时手动调用，**启动时不再自动跑**）                                                                 |
| `removeMediaGroupIfEmpty(groupId)`               | **删除媒体后的组状态统一入口**：以 `media` 实际记录数为准——组内已无媒体 → 删 `group_list`（并清残留 `message`）；仍有媒体 → 把 `is_group` 重算为真实数量 |
| `cleanupOrphanGroupList()`                       | 启动时清理历史遗留的"没有任何媒体的 `group_list` 项"（及其孤儿 `message`），幂等                                                                         |

> **`group_list.is_group` 只是计数快照，不是判断依据：** 删除路径不再用 `is_group === 1` 判断
> "最后一个媒体"，也不再用 `$inc: -1` 递减，而是调用 `removeMediaGroupIfEmpty()` 按 `media`
> 集合的**真实记录数**决定"删组还是重算计数"。原因：一旦计数器与真实媒体数漂移
> （重复计数、历史数据、回滚失败等），旧写法删完最后一个媒体后 `is_group` 仍 > 0，
> `group_list` 就会永远留下来（表现为"已经没有任何媒体的 group_list 项没有被跟随最后一个媒体一同删除"）；
> 反向漂移（计数偏小）还会导致**误删整个组**（组内其实还有媒体）。同理，计数偏小会被重算回真实数量。
>
> **删除媒体的三条路径**（`/delete`、`/delete_group`、`/clean` 与 Web UI 清理，以及群组收录失败回滚）
> 都会连带处理 `group_list`；其中 `/delete` 走 `removeMediaGroupIfEmpty`。注意：Web UI「数据库」视图里的
> **原始文档删除**（`/api/db/execute`，op=delete）是底层直改工具，**不做级联**——用它会留下空组，
> 下次重启时由 `cleanupOrphanGroupList()` 自动清掉。

> **`group_list.tags` —— 媒体组标签汇总（标签查询的第一入口）：**
>
> - 内容 = 该 `group_id` 下**所有 `message.tags` 的并集**（`message.tags` 始终是唯一权威来源，
>   `group_list.tags` 只是便于"先查 group_list"的冗余汇总）；没打过标签的组不带该字段。
> - 任何改变组内标签的写路径都会同步它：打标签会话（按钮 / 手输 / 文本自动匹配）、
>   `/tag` 修改消息标签、编辑描述后的自动补标签、标签改名与删除（全库重算）、启动迁移。
> - **标签查询（`handlers/queryHandler.js`）先查 `group_list.tags` 再查 `message`：**
>   - 宽松查询 `-标签`：`message` 与 `group_list` 都查 → 命中任一标签的媒体组（整组）
>     与自身 `message.tags` 命中的单条取**并集**；
>   - 严格查询 `--标签`：**只查 `group_list`** 同时含全部标签的媒体组，取其组内的 message 数据
>     （不再看单条 message 自己的标签）；
>   - 命中媒体组后，组内**所有描述**都会返回（媒体组含多条描述时全部显示），
>     带关键字时**关键字命中的描述排最前**（最符合查询的优先）。
>
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
> - 删除：`deleteMode`（删完按 `media` 实际记录数决定删组或重算，见 `removeMediaGroupIfEmpty`）、
>   `groupMessageHandlers.handleEditedMessage`（群内直接清空描述）
>
> 因此「空描述媒体组照常被收录 → 可清理；后续补/改描述 → 自动变为无需清理；再清空 → 又可清理」，
> 且与媒体组内各条消息的到达顺序无关。

#### db/channelGroup.js — 频道/群组

| 函数                               | 功能                    |
| ---------------------------------- | ----------------------- |
| `upsertChannelGroup(channelGroup)` | 插入或更新              |
| `getAllChannelGroups()`            | 获取所有管理的群组/频道 |
| `getChannelGroupById(id)`          | 按 chat_id 查询         |
| `updateChannelGroup(id, updates)`  | 单字段更新              |
| `deleteChannelGroup(id)`           | 删除记录                |

#### db/users.js — 用户管理

**权限模型：**
- `state: 1` = 正常, `state: 0` = 封禁
- `white: 1` = 白名单, `white: 0` = 未白名单
- 用户同时满足 `state: 1` 且 `white: 1` 才可使用私聊功能

**封禁机制：**
- `banUserFully(userId)` 不仅设置数据库状态（state=0），还主动将用户从**全部管理群组与频道**（含绑定关系的频道↔群组两侧）中封禁踢出
- `unbanUserFully(userId)` 同样覆盖全部群组与频道解封并恢复 state=1；解封后短暂标记"最近解封"，期间收到的 left/kicked 状态更新（解封动作回显）不会触发"退出即封禁"，避免"管理员刚解封、机器人立刻又封禁"。
  **管理员直接在 Telegram 侧（频道 / 群的「已移除用户 / 黑名单」）解封**同样不会被误判：Telegram 发来的是 `kicked → left`（用户并未主动退群，见 `handlers/chatMemberHandler.js`），现在识别为解封 —— 库状态同步回正常并忽略后续回显，**绝不触发自动封禁**；真正的 `member → left` 才维持"退出即封禁"策略。
- `removeUserFromGroup()` 在用户离开群组时触发自动封禁（用于防撤回退群）

#### db/transport.js — 搬运链接

| 函数                                                                        | 功能                                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `upsertTransport(transport)`                                                | 插入或更新搬运记录（更新会作废旧活性结论）                                          |
| `getAllTransports()`                                                        | 获取所有搬运源（按搬运次数降序）                                                    |
| `getTransportByChatId(chatId)`                                              | 按 chat_id 查询                                                                     |
| `deleteTransport(chatId)`                                                   | 删除搬运记录                                                                        |
| `createTransport({ chat_id, chat_name, url, num })`                         | 新建收录记录（控制台用，重复 chat_id 返回 `{ ok:false, error }`）                   |
| `updateTransport(chatId, { chat_name, url, num })`                          | 修改收录记录（改链接后清空 `alive`/`last_check_*`，等待重查）                       |
| `updateTransportStatus(chatId, { status, error, chatName, previousAlive })` | 写回活性检查结论（`alive`：true/false/未知保持原值 + `last_check_at/status/error`） |
| `getTransportHealth()`                                                      | 活性巡检用列表（等价于 `getAllTransports`）                                         |
| `extractChatInfo(url, bot)`                                                 | 从 t.me 链接解析出群组 chat_id 和名称                                               |

> **活性字段：** `alive`（true=有效 / false=失效 / null=未检查）、`last_check_at`、`last_check_status`（ok/dead/unknown）、`last_check_error`。由 `utils/linkHealth.js` 写入，机器人、控制台与巡检任务共用同一份结论。

#### db/dbStats.js — 数据库存储统计

控制台「数据库」视图与概览卡片共用（15 秒缓存，避免频繁打 Atlas）：

| 函数                    | 功能                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getDbStats({ force })` | 整库 `dbStats` + 逐集合 `collStats`：集合名/中文名、`count`、`size`、`storageSize`、`indexSize`、`nindexes`、`avgObjSize`、整库 totals；按数据体积降序 |
| `getDbStatsSummary()`   | 概览卡片用的精简版（`objects`/`collections`/`storageSize`/`dataSize`/`indexSize`）                                                                     |
| `clearDbStatsCache()`   | 手动失效缓存                                                                                                                                           |
| `COLLECTION_LABELS`     | 集合名 → 中文名映射                                                                                                                                    |

> **降级策略：** 若部署（部分共享集群 / 受限账号）不允许 `dbStats` 或 `collStats`，自动退回 `estimatedDocumentCount()` 只取文档数，并在返回值里给出 `available:false` + `reason`；前端据此显示原因而不是报错。实测 MongoDB Atlas 免费版（M0）该两条命令**可用**，因此大小/占用能正常显示。

#### db/log.js — 操作日志

通过 `insertLog(type, userId, extra)` 记录 25 种操作类型：

| 类型         | 值  | 说明         |
| ------------ | --- | ------------ |
| BOT_START    | 0   | 机器人启动   |
| MEDIA_SAVE   | 1   | 媒体入库     |
| MEDIA_EDIT   | 2   | 媒体编辑     |
| MEDIA_DELETE | 3   | 媒体删除     |
| ...          | ... | 共 25 种类型 |

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
    ├── queryParser.parseQuery(text) → 结构化条件（关键字 + 类型 + 标签）
    │      └── 段落顺序不合法 → 只回一条语法提示，不予查询
    ├── 数据源 1（message）：按 text / tags / media_type 模糊查询
    ├── 数据源 2（media）：按 media_name（文件/音乐名称、文本内容）查询
    │      └── 两边都命中的按 file_unique_id 去重（保留信息更全的 message 行）
    ├── queryCache.createSession() → 缓存结果
    ├── queryFormatter.formatQueryResults() → 格式化为分页文本
    └── 发送带翻页键盘的消息
```

**分页机制：**
- 每页默认 10 条结果
- 翻页通过 `pageCallback.js` 处理
- 结果缓存 60 秒 TTL
- 支持标签筛选（`-` 宽松 / `--` 严格）、类型筛选（`+d/+a/+p/+v/+t`）、随机排序
- **只命中文件名的结果**（例如"只发过文件、没写描述"）也能被搜到，结果行显示该文件名

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

| 命令                     | 文件                   | 功能             | 实现要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/clean`                 | clean.js               | 数据库清理模式   | 扫描空数据的 group_list，批量删除                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/delete`                | delete.js              | 删除单一媒体     | 进入 delete 模式，等待用户发送媒体或链接                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/delete_group`          | deleteGroup.js         | 删除整个媒体组   | 进入 deleteGroup 模式，等待用户操作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/edit`                  | edit.js                | 编辑消息文本     | 进入 edit 模式：① 发送要编辑的媒体（图片/视频/音频/文档）；② 或**发送消息链接**（`t.me/c/...`、`t.me/<用户名>/...`）**/ 转发该消息**（含转发来源）直接定位；③ 群组/频道中管理员**回复**一条消息（媒体**或机器人发出的文本消息**）并发送 `/edit [新描述]`（也支持 `/edit@机器人用户名 [新描述]`）可跳过定位直接修改（带文字一步完成；不带文字时群组内等管理员下一条文本；频道仅支持带文字）。媒体改 caption、文本消息改消息 `text`，**新正文一律带上管理员这条消息自己的 entities（严格保留加粗/斜体/链接等格式）**，库外消息只改 Telegram；文本消息不支持 `/null` 清空。修改后 1 分钟自动删除全部操作记录（机器人提示 + 管理员的命令消息） |
| `/exit`                  | exit.js                | 退出当前模式     | 调用 deleteUserState 清理状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/help`                  | help.js                | 显示命令按钮     | 发送带所有命令的内联键盘                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/log`                   | log.js                 | 操作统计         | 从 log 集合聚合统计并展示                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/manage`                | manage.js              | 管理面板         | 进入 manage 模式，显示管理主菜单                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/mark`                  | mark.js                | 标记模式         | 单选题式标记：进入后**要么发送要标记的媒体**（照旧 `group_list.mark +1` 并写入 `mark` 历史集合），**要么点「📝 仅记录」**（只写一条 `mode='record'` 记录：不标记任何媒体/媒体组、不带 `group_id`），二者完成后都自动退出标记模式                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/send`                  | send.js                | 发送模式         | 选择目标群组/频道（分页按钮），发送消息/媒体/媒体组并收录；**发文本同样收录**为 `media_type='text'`（内容进 `media_name`、`entities` 进 `media_entities`，可被搜索/查看，见 `media.recordTextMedia`）；成功后**自动进入打标签**（按钮/手动输入，文本自动识别勾选；手动输入空格分隔可写多个，`-标签` 表示移除）。打标签面板为**两区版面**：上区=已有标签（点击移除），下区=标签库（置顶在前，点击添加）；打标签**不退出本模式**，用户可继续发送媒体，点《✅ 完成》或一键"回复该消息"才结束（详见 mode 系统下的「打标签会话」）                                                                                                               |
| `/tag`                   | tag.js                 | 标签模式         | 修改消息标签（预览媒体组后添加/删除，按钮翻页+手动输入：空格分隔可写多个，`-标签` 表示移除；**添加标签**为两区版面：上区=已有标签（点击移除）、下区=标签库（置顶在前，点击添加）；标签按 message 独立——只作用于定位的那条媒体，定位界面会把组内所有带文本 message 的标签分别列出）；编辑标签（添加/改名/删除/固定置顶位置，同步 message）                                                                                                                                                                                                                                                                                                  |
| `/media_group [N]`       | mediaGroup.js          | 媒体合并模式     | 进入 mediaCollect 模式，type=media_group；N=每组个数（1~10，退出时按 N 个一组打包发送）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/media_hide [N]`        | mediaHide.js           | 媒体遮罩模式     | 进入 mediaCollect 模式，type=media_hide；N=每组个数（1~10）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `/media_unhide [N]`      | mediaUnhide.js         | 去遮罩模式       | 进入 mediaCollect 模式，type=media_unhide；N=每组个数（1~10）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/message_reply [N]`     | messageReply.js        | 消息回复         | 进入 messageReply 模式，定位到频道转发媒体时**必须选择回复在群组还是频道**（就绪消息上带「🔄 更改为发送至…」一键切换按钮），**未指定时默认回复在群组**；回复位置取自 `message.channel_forward` **与 `media.group`/`media.channel` 两处**，空描述媒体（没有 message 记录）同样可定位回复；N>=2 时媒体按 N 个为一组打包为媒体组回复（满 N 个立即回复一组，不足 N 的余量等待补满下一组，退出/超时时才冲刷发出）。单条/整组回复成功后**自动进入打标签（不退出回复模式）**，可继续发媒体继续回复。**就绪后也可直接发文字回复**（保留 Telegram 文本格式，并按新的 subgroup 收录成 `media_type='text'`，见下）                                     |
| `/message_reply_group`   | messageReplyGroup.js   | 消息回复（群组） | 直接回复在群组中（频道转发消息用群组位置，非转发消息用消息自身位置）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `/message_reply_channel` | messageReplyChannel.js | 消息回复（频道） | 直接回复在频道中（无频道位置时回退消息自身位置）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/password`              | password.js            | 媒体密码         | 进入 password 模式，设置/更新媒体访问密码                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/random_pictures [N]`   | randomPictures.js      | 随机图片         | 查询 media_type=photo 的随机结果，可指定数量 N（1~10）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/random_videos [N]`     | randomVideos.js        | 随机视频         | 可按时长筛选；可指定数量：N 1~10 直接发送 N 个视频媒体，N>=11 以标题列表展示                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/search`                | search.js              | 搜索模式         | 进入 search 模式，后续消息全部作为查询                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/setting`               | setting.js             | 全局设置         | 进入 setting 模式，显示设置面板内联键盘                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/transport`             | transport.js           | 搬运管理         | 进入 transport 模式，管理搬运链接的 CRUD；列表带**活性徽标**（✅ 有效 / ❌ 失效 / ❔ 未检查）与失效原因，进模式时自动补查过期记录，可「🔍 检查链接活性」全量实测；新增 / 改链接 / 改 chat_id 后立即实测并把结论直接回给用户                                                                                                                                                                                                                                                                                                                                                                                                                    |

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

**打标签会话（utils/tagSession.js）—— 与模式解耦：**

`/send`、消息回复、编辑描述等写库成功后会**自动进入打标签会话**，但会话**不切换、不退出**用户原有模式
（`send` 仍是 `send`、`message_reply` 仍是 `message_reply`），因此不影响原模式继续工作：

| 行为                   | 说明                                                                                                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自动进入               | 带描述的发送/回复成功后收录 `message`（标签作用对象 = 该条新的 `file_unique_id`），自动识别文本中已存在的标签并弹出打标签面板；无描述媒体不写 `message`，也不进入打标签                                                                                                                        |
| 纯文本 = 打标签        | 会话进行中用户发来的**纯文本**视为标签操作（空格 / `、` / `,` 分隔可一次多个，`-标签` 表示移除；不存在的标签自动创建），**不发送、不查询**；直到点《✅ 完成》才结束                                                                                                                             |
| 面板刷新方式           | **点按钮 → 只就地 `editMessageText` 刷新按钮与文本**（不重发消息、面板位置不动、聊天记录不刷屏）；**用户发消息改标签 → 删掉旧面板 + 发一条新面板**（用户消息在下方、旧面板被顶在上方看不到刷新结果，所以这一步才需要重发），见 `utils/tagSession.refreshPanel(userId, statusLine, { resend })` |
| 媒体照常               | 会话进行中发送媒体仍由当前模式正常处理（继续发送 / 继续回复），成功后同样进入打标签队列                                                                                                                                                                                                        |
| 队列                   | 当前标签还没打完又来一个需要打标签的媒体 → 先入队（提示"已加入打标签队列（第 N 个）"），**点《✅ 完成》后才把面板切换到下一个**；队列为空时结束会话（模式保留，可继续发送/回复）                                                                                                                |
| 面板按钮               | `sendtag:*` 上/下区标签切换（上区点击移除、下区点击添加）、`sendtag_page:*` 翻页、《✅ 完成》`sendtag_done`、《🔁 回复该消息》`sendtag_reply`（结束打标签并自动进入消息回复模式）                                                                                                                |
| 同步 `group_list.tags` | 每次标签变更后按组内 `message.tags` 并集重算 `group_list.tags`（见 `db/groupList.js`）                                                                                                                                                                                                         |
| 清理时机               | `/exit`、模式超时退出、进入其它指令/模式（`cleanPreviousMode`）时一并清空会话；会话本身有 2 小时空闲上限                                                                                                                                                                                       |

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

| 回调                       | 功能                               |
| -------------------------- | ---------------------------------- |
| `mediaCallback.js`         | 显示指定媒体（按编号从缓存中获取） |
| `directCallback.js`        | 快捷查看（直接从查询结果获取）     |
| `directConfirmCallback.js` | 确认快捷查看                       |
| `pageCallback.js`          | 翻页操作（上一页/下一页/指定页）   |
| `toggleCallback.js`        | 切换查询设置（显示模式/排序方式）  |
| `randomShowCallback.js`    | 随机结果显示切换                   |
| `cleanCallback.js`         | 清理模式确认/取消                  |
| `cleanContinueCallback.js` | 清理完成后继续/退出                |
| `execCmd.js`               | 执行指定命令                       |

---

### 12. Web UI 管理面板 — webui/

**路径:** `webui/` **职责:** 提供浏览器端数据查看与管理界面（零第三方依赖）

**启动方式：**

```bash
node index.js webui       # 或 npm run start:webui
```

浏览器访问 `http://127.0.0.1:9700`（端口可通过 `WEBUI_PORT` 配置）。**登录密码唯一来源是数据库 `settings` 集合**：

```js
// settings 集合，_id = 'app_settings'
db.settings.updateOne(
  { _id: 'app_settings' },
  { $set: { webui_password: '你的面板密码' } },
  { upsert: true }
)
```

- `webui_password` 是**密钥类字段**：不会进入 `config` 对象、也不会出现在机器人 `/setting` 面板里（避免被日志带出）；
- **未配置时无法登录**（登录接口返回 503 并提示字段名，启动日志也会告警）——不再随机生成密码，也不读 `.env`；
- 改完最多 5 秒生效（`db/settings.js` 的短 TTL 缓存）；改用 `setSettingPassword()` / `clearSettingsCache()` 可立即生效；
- 密码比较使用定长比较（`crypto.timingSafeEqual`）。

**鉴权机制：**
- 除 `/api/login` 外的所有 API 均需携带 `Authorization: Bearer <token>`
- 登录成功返回 token，前端存储在 localStorage，会话有效期 12 小时

**界面结构：左侧导航 + 主区 + 右侧实时日志坞（窄屏自动折叠为单列）**

**响应式（平板 / 手机）：** 断点为 **1040px / 880px / 640px** 三档（另有瀑布流相关断点：随机推荐**按窗口宽度**的 560/720/1024/1400/1800 列数阶梯、媒体库**按容器宽度**的 640/420 列宽收窄，以及标签详情 + 媒体详情左栏**共用的** 880 列宽收窄）：

- **1040px**：媒体详情对话框由左右两栏切为**上下单栏**（显式声明单列轨道，否则 `minmax(360px, 34%)` 的硬下限会把左栏压成 0 宽并被对话框裁掉）；
- **880px**：外壳塌成单栏（左侧导航变横向可滑、右侧日志坞隐藏，"实时日志"视图仍可看）；用户 / 搬运收录等多列表格改为**横向滚动**（`table-scroll`，此前 `overflow:hidden` 会把最右侧操作列直接裁掉）；实时日志框高度改由 CSS 控制并加 `min()` 上限（此前内联 `calc(100vh - 250px)` 在工具栏换行后会撑出屏幕）；统计「操作日志明细」不再强制半屏高；全年方格放大到 13px 并保留横向滚动；**触控目标**加大（`.btn-sm` / `.btn-xs` / `.chip` / `.pagination` / 导航项）；表单控件 16px（避免 iOS 聚焦自动缩放）；toast 避开底部安全区；登录页与 AI 操作台使用 `dvh` + `env(safe-area-inset-*)`；
- **640px**：对话框底部按钮换行并平分整行（此前实测约 492px 宽，手机上「关闭」会被裁掉、详情弹层关不掉）；对话框占满 `100vw - 16px`；顶栏标题与搜索各占一行；工具栏按钮允许收缩。

> **瀑布流的排布方式（重要）：** 四处瀑布流（随机推荐 / 媒体库 / 标签详情 / 媒体详情左栏）都用 **CSS Grid + 行跨度**实现：
> 容器 `grid-auto-rows: 8px` 是一把"行标尺"，卡片 `align-self: start`（高度=内容高度），
> JS（`webui/public/app.js: layoutFlowGrid`）量出每张卡高度后写 `grid-row-end: span N`。
> 这样**格子按"先第一行从左到右、再往下"自动放置**，视觉顺序与列表顺序一致（顺着看不会跳列）；
> 而 CSS 多列（`columns`）是"先把第一列填满再填第二列"，顺序会先上下再左右 —— 故不使用。
> 重排时机：视图渲染后、缩略图按真实比例定高后、窗口缩放后（防抖 120ms）。

| 视图          | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📊 概览        | 媒体 / 有描述 / 可清理组 / 用户 / 标签 / 聊天 / 日志 统计卡片、**数据库占用卡片（storageSize + 文档数 + 索引占用，取不到时标注"当前套餐不可读取大小"）**、媒体类型分布、最近操作、最新媒体组（可点开详情）、快捷入口                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 🖼 媒体库      | 以 `group_list` 为单位的媒体组卡片：**图片与视频封面缩略图**（封面 = **该组第一条带文本 `message` 对应的媒体**，没有带文本媒体时回退 `media` 里最早一条；文本媒体 `media_type='text'` 不当封面；卡片封面与卡片描述因此始终是同一条媒体）、**服务端代理 Telegram `getFile`**（**悬停即弹出完整比例大图预览、缩略图本身也切到不裁切**）、**预览图右下角带文件类型角标**（🖼 图片 / 🎬 视频 / 🎵 音频 / 📄 文件 / 📝 文本）、**瀑布流（多列错落）布局**——与「随机推荐」同一套：**封面按图片原始比例完整显示、不裁切不变形**，列数**按容器宽度自适应**（列宽约 228px），因此在主区域和「标签详情」弹窗里**卡片一样大**、不会因为弹窗窄而变小（窄屏收窄列宽，手机上也排得下 2 列）、描述摘要（没有 message 时用 `media_name`（文件名 / 文本内容）兜底，仍然没有才标为「可清理」）、标签、类型/组数/位置；筛选「全部 / 有描述 / 可清理」+ 顶部搜索（**同时匹配 `message.text` 与 `media.media_name`**，因此只发过文件、没写描述的媒体也能按文件名搜到）+ **标签筛选**（从「标签」视图点进来，可用胶囊清除）+ 分页 + **「每组显示」40 / 80（默认）/ 120 / 200**；点开为详情对话框 |
| 🎲 随机推荐    | 比机器人上的两个随机更自由：**数据来源**下拉常驻在「▾ 更多筛选」按钮前面（折叠也可见：message 库 = 有描述/标签的记录，默认；media 库 = 全部收录媒体）；**筛选条件面板默认折叠**（只留「类型」一行，点「▾ 更多筛选 / ▴ 收起筛选」展开收起，收起时用一句「已启用：…」摘要提示生效中的隐藏条件）；**类型**（图片/视频/音频/文件，多选）、**标签**（可多选，含任一 / 需同时含全部）、**关键词**（匹配描述）、**视频时长**（1 分钟内 / 3 分钟内 / 1-5 / 5-30 / 30 分钟以上 / 1 小时以上）、**范围**（全部 / 保留 / 可清理）、**数量**（20 / 40（默认）/ 80 / 150）任意组合，点「🎲 换一批」即重抽；结果区是**瀑布流（多列错落）**布局，**列数随窗口宽度阶梯变化**（手机 2 列 → 平板 3 列 → 小笔记本 4 列 → 桌面 5 列 → 大屏 6 列封顶），**封面按图片原始比例完整显示、不裁切不变形**，描述 / 标签 / 类型角标等文字信息仍在图片下方（卡片**不显示「保留 / 可清理」**——那是媒体库的清理语义，随机推荐里没有意义）；点卡片直接进该媒体组详情改描述/标签，「↗」在 Telegram 打开                                                                                                 |
| 📋 媒体详情    | 左右两栏（左 = 媒体缩略图条，右 = 描述与标签 + 定位信息）**各自独立滚动**（每栏一根滚动条、高度只由自己内容决定，容器 `align-items: start` 互不拉平；窄屏单栏恢复整体滚动）；左栏媒体条是**瀑布流**（封面按图片原始比例完整显示、不裁切，列宽 132px、窄屏 104px —— 与「标签详情」的媒体**完全同一尺度**）、**一键「↗ 跳转 Telegram 查看」**、**在线改描述**（保存会同步 Telegram caption，超 48 小时只改库并提示）、**点选媒体后改标签**（点缩略图或描述块选中该媒体：已有标签高亮、点 ✕ 直接移除；没有标签则高亮「➕ 添加标签」；未选中时标签区置灰不可点。原「整组操作」已移除，标签按 message 独立）、一键「标记为可清理 / 保留」（改写 `group_list.is_delete`）                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🧹 清理中心    | 按「一周前 / 一个月前 / 全部」给出**精确**的待清理组数与媒体数（`POST /api/clean` 预览），确认后执行与机器人 `/clean` 相同的删除逻辑；下方为可清理组预览                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🏷 标签        | 顶栏三个按钮：**➕ 添加标签**（表单新建，自动大写、重名拒绝）、**🗑️ 删除标签**（进入删除模式后点卡片二次确认删除，会同步清理所有 message）、**⭐ 置顶排序**（进入排序模式后**直接拖动卡片排序**，保存即按顺序写入置顶位置 1..N）；卡片显示置顶位置、使用次数、计数，**点击卡片进入标签详情**——详情顶栏显示置顶状态（`📍 已置顶（位置 N）` / `⭐ 未置顶`），**点一下即切换**置顶/取消置顶，正文**直接列出该标签下的媒体组（与「媒体详情」左栏**同一尺度**的紧凑瀑布流卡片：列宽 132px / 窄屏 104px 与 `.detail-strip--flow` 完全一致，同一个窗口下两处媒体一样大；卡片内容相应精简成「封面 + 描述 + 一行类型 / 媒体数」——132px 放不下徽标、标签胶囊、定位信息与 group_id，也不再有「点击进详情」提示与封面类型角标，点卡片直接打开媒体详情）**，底部可跳转到媒体库筛选全部；顶部搜索可过滤标签名                                                                                                                                                                                                                                                                            |
| 👥 用户        | 用户表（名称 / ID / 状态 / 白名单 / 所在群组数 / 最近活跃），筛选「全部 / 白名单 / 已封禁」+ 搜索（名称或纯数字 ID）+ 分页；**支持新增 / 编辑（名称、状态、白名单、所在群组）/ 删除**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 📢 群组 / 频道 | `channel_group` 记录与频道↔群组绑定关系（含绑定对象名称解析）；**支持新增 / 编辑 / 删除，绑定为双向写入**（改绑会清理旧对端，删除会解除对端绑定）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 🚚 搬运收录    | `transport` 记录表：**活性徽标**（✅ 有效 / ❌ 失效 / ❔ 未检查）、名称、`chat_id`、**一键「↗ Telegram」跳转**、搬运次数、最近检查时间与失败原因；筛选「全部 / 有效 / 失效 / 未检查」+ 搜索（名称 / 链接 / chat_id）+ 分页；**支持新增 / 编辑 / 删除**，并可按行「🔄 检查活性」或「🔍 全部检查活性」（检查结果写回数据库，与机器人共用同一份结论）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 📄 文章        | `article` 卡片：标题（可点开链接）、子文章列表、更新时间、子文章数；**支持文章与子文章的增 / 改 / 删**（删除文章会级联删除子文章）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 📚 合集 / 杂集 | `collection`（合集）与 `misc`（杂集）卡片：名称、子项列表（可点开链接）、子项数；按类型筛选 + 搜索；**支持合集/杂集与子项的增 / 改 / 删**（删除会级联删除子项）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 📈 统计报表    | **统一按年统计**（顶栏右上角 `◀ 2026 年 ▶` 切换年份，无月报/年报页签）：操作总数、媒体产出、媒体组产出、活跃天数、失败次数（带环比）、**每日操作量 GitHub 全年方格图**（独占整条：7 行 = 周一…周日、每列一周，列宽自适应撑满卡片、窄屏横向滚动；整年每格一天，列顶标注月份，颜色随操作量分 5 档加深，悬停看当天媒体数）、动作明细 Top15、大类分布、活跃用户、**活跃时间**（北京时间 24 小时分布，0 次的小时用底色短桩区分，高峰柱标绿并在柱顶标出次数），以及可筛选（大类 / 结果 / 关键词）的操作日志明细表 —— 面向"年终统计"设计；底部明细表**撑满剩余高度**（表格内部滚动，不再悬在页面中间）。历史日志只有旧编号（`type`）时也都有可读中文名（如 23 → 「修改文本」），不再出现 `legacy_type_23` 之类的占位名                                                                                                                                                                                                                                                                                                                                                       |
| 🗄 数据库      | **集合浏览与集合明细整合为一个视图**：上栏 = 集合选择 / 排序 / 插入 / AI 翻译 / 🔄 重新统计 + 库信息；中部为整库汇总卡（集合数 / 文档总数 / 存储占用 / 数据体积 / 索引占用）；下方为**各集合明细表**（文档数、数据体积、磁盘占用、索引占用、索引数，按体积排序，**点任意一行即切换下方浏览的集合**，当前集合行高亮）。套件不允许 `dbStats`/`collStats` 时自动降级为仅文档数并给出原因。再下方为**原始文档浏览**：选中集合后分页浏览、文档 JSON 就地修改与删除、插入模板（「全部数据库」选项只作为占位，不再重复列一遍集合列表）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 📡 实时日志    | SSE 日志全屏视图，级别筛选（信息 / 成功 / 警告 / 错误）、暂停与清空                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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

| 接口                                                       | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/login`                                          | 登录，返回 token                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/db/collections`                                  | 可操作集合白名单                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /api/db/query`                                       | 查询（`collection` 为 `__all__` 时跨集合浏览，每集合前 100 条；否则分页）                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /api/db/execute`                                     | 执行操作（`{ operation, confirm }`，delete 必须 confirm 且 filter 非空）                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/ai/plan`                                        | AI 将自然语言翻译为完整操作计划（支持选中文档，不执行）                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/logs/stream`                                     | SSE 实时日志流（token 经 query 传递）                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/overview`                                        | 概览统计（各集合计数、媒体类型分布、最近操作、最新媒体组）                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET /api/media`                                           | 媒体组列表（`scope=all\|cleanable\|kept`、`tag` 按标签筛选、`q` 按描述搜索、`page` / `pageSize` 分页，**`pageSize` 上限 200**、越界按 200 截断），带封面预览与描述/标签；**封面 = 该组第一条带文本 `message` 对应的媒体**（无带文本媒体时回退 `media` 最早一条）                                                                                                                                                                                           |
| `GET /api/media/detail`                                    | 单个媒体组详情（`groupId`）：媒体条目 + 描述与标签 + `group_list` 状态                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /api/random`                                          | **随机推荐**：`source=message\|media`（数据来源，默认 `message` = 只抽有描述记录的媒体并按其 `file_unique_id` 补 media 信息；`media` = 全部收录媒体）、`types`（photo/video/audio/document，逗号分隔）、`tags` + `tagMode=any\|all`、`q`（匹配描述）、`duration`（all/<1min/<3min/1-5min/5-30min/>30min/>1h）、`scope=all\|kept\|cleanable`、`count=1..150`（默认 40）任意组合，随机抽一批媒体（带缩略图信息、描述、标签、位置以及 Telegram 跳转所需字段） |
| `POST /api/clean`                                          | 清理空数据（`{ scope: week\|month\|all, confirm }`；不带 `confirm` 只返回待清理数量）                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/tags`                                            | 标签库（含 `message` 中的实际使用次数）                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/users`                                           | 用户列表（`scope=all\|white\|banned`、`q` 名称或 ID、分页）                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/groups`                                          | 管理的群组/频道及绑定关系                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/thumb`                                           | 图片/视频封面缩略图代理（服务端调用 Telegram `getFile`，图片用自身 `file_id`，视频/文档/音频用收录时保存的 `thumb_file_id`；token 经 query 传递，内存缓存）                                                                                                                                                                                                                                                                                                |
| `POST /api/media/tags`                                     | 给单条 media（`fileUniqueId`）或整个媒体组（`groupId`）增删标签（`{ add, remove }`），自动建标签并维护 `tags.count`                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/media/description`                              | 修改媒体描述（`{ fileUniqueId, text, editTelegram }`）：落库 + 重算 `is_delete` + 重算标签 + 同步 Telegram caption（失败只回报不回滚）                                                                                                                                                                                                                                                                                                                     |
| `GET /api/oplogs`                                          | 操作日志列表（按 `category`/`action`/`result`/`userId`/时间范围/关键词筛选，分页；兼容只有 `type` 的历史数据）                                                                                                                                                                                                                                                                                                                                             |
| `GET /api/stats`                                           | 月报 / 年报（`period=month                                                                                                                                                                                                                                                                                                                                                                                                                                 | year&year=&month=`）：汇总、环比、每日趋势、动作/大类/用户分布、失败统计 |
| `POST /api/users/create` \| `update` \| `delete`           | 用户增 / 改（名称、状态、白名单、所在群组）/ 删（需 `confirm: true`）                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/groups/create` \| `update` \| `delete`          | 群组/频道增 / 改（含绑定，双向写入）/ 删（需 `confirm: true`，同时解除对端绑定）                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/transport`                                       | 搬运收录列表（`status=all\|alive\|dead\|unchecked`、`q` 名称/链接/chat_id、分页），返回 ✅/❌/❔ 活性状态、可点击 `link` 与四类计数                                                                                                                                                                                                                                                                                                                           |
| `POST /api/transport/create` \| `update` \| `delete`       | 收录记录增 / 改（名称、链接、次数；改链接会作废旧活性结论）/ 删（需 `confirm: true`）                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /api/transport/check`                                | 活性检查：带 `chat_id` 检查单条并写回结论；不带则全量检查，返回 `summary`（有效 / 失效 / 未知 / 新失效列表）                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/articles`                                        | 文章列表（`q` 标题/链接、分页、`withSubs=1` 附带子文章）                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/articles/create` \| `update` \| `delete`        | 文章增（自增 id）/ 改（标题、链接）/ 删（级联删除子文章，需 `confirm: true`）                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/articles/sub/create` \| `update` \| `delete`    | 子文章增 / 改 / 删（自动刷新父文章 `updated_at`）                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /api/collections`                                     | 合集/杂集列表（`type=all\|collection\|misc`、`q` 名称、`withSubs=1` 附带子项）                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/collections/create` \| `update` \| `delete`     | 合集/杂集增 / 改（名称、类型）/ 删（级联删除子项，需 `confirm: true`）                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /api/collections/sub/create` \| `update` \| `delete` | 子项增 / 改 / 删（自动刷新父合集 `updated_at`）                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /api/db-stats`                                        | 数据库存储统计（整库 `dbStats` + 各集合 `collStats`，15 秒缓存；`force=1` 强制重算，取不到时返回 `available:false` + 原因）                                                                                                                                                                                                                                                                                                                                |
| `POST /api/tags/create`                                    | 新建标签（自动大写、≤20 字符、重名 409）                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/tags/delete`                                    | 删除标签（需 `confirm: true`，同步从所有 `message.tags` 移除）                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/tags/rename`                                    | 标签改名（`{ name, to }`，自动大写；同步改写所有 `message.tags`，重名 409 / 不存在 404）                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /api/tags/pin`                                       | 设置 / 取消置顶（`{ name, pin }`，`pin=0` 取消，上限 40）                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /api/tags/reorder`                                   | 按 `{ names: [...] }` 顺序批量写置顶位置 1..N（控制台拖拽排序保存用）                                                                                                                                                                                                                                                                                                                                                                                      |

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

| 变量                 | 必填 | 说明                                    |
| -------------------- | ---- | --------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | 是   | BotFather 获取的 Token                  |
| `MONGODB_URI`        | 是   | MongoDB Atlas 连接串                    |
| `ADMIN_CHAT_ID`      | 是   | 管理员 Telegram 用户 ID，多个用逗号分隔 |
| `WEBUI_PORT`         | 否   | Web UI 端口（默认 9700）                |

> Web UI 登录密码**不在 `.env`**：见数据库 `settings` 集合的 `webui_password` 字段（本表只列环境变量）。

---

## 指令列表

### 私聊命令（仅管理员可用）

| 命令                         | 功能                                                                                                                                                                                                                                                                                                                                                                                    | 所属模块                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `/media_group [N]`           | 媒体合并模式（N=每组个数 1~10，退出时按 N 个一组打包发送）                                                                                                                                                                                                                                                                                                                              | modes/mediaCollectMode.js                                              |
| `/media_hide [N]`            | 媒体遮罩模式（Spoiler，N=每组个数 1~10）                                                                                                                                                                                                                                                                                                                                                | modes/mediaCollectMode.js                                              |
| `/media_unhide [N]`          | 媒体去遮罩模式（N=每组个数 1~10）                                                                                                                                                                                                                                                                                                                                                       | modes/mediaCollectMode.js                                              |
| `/message_reply [N]`         | 在群组/频道中回复指定消息（频道转发消息可先选择回复位置；N>=2 时媒体按 N 个一组打包为媒体组回复——满 N 个立即回复一组，不足 N 的余量等待补满下一组，退出/超时时才冲刷发出）；就绪后也可直接发文字回复                                                                                                                                                                                    | modes/messageReplyMode.js                                              |
| `/message_reply_group [N]`   | 在群组中回复指定消息（支持 N 打包）                                                                                                                                                                                                                                                                                                                                                     | modes/messageReplyMode.js                                              |
| `/message_reply_channel [N]` | 在频道中回复指定消息（支持 N 打包）                                                                                                                                                                                                                                                                                                                                                     | modes/messageReplyMode.js                                              |
| `/search`                    | 进入搜索模式                                                                                                                                                                                                                                                                                                                                                                            | modes/searchMode.js                                                    |
| `/delete`                    | 删除单一媒体                                                                                                                                                                                                                                                                                                                                                                            | modes/deleteMode.js                                                    |
| `/delete_group`              | 删除整个媒体组                                                                                                                                                                                                                                                                                                                                                                          | modes/deleteGroupMode.js                                               |
| `/clean`                     | 数据库清理模式                                                                                                                                                                                                                                                                                                                                                                          | modes/cleanMode.js                                                     |
| `/random_videos [N]`         | 随机获取视频（N 1~10 直接发送视频媒体，N>=11 标题列表展示）                                                                                                                                                                                                                                                                                                                             | commands/randomVideos.js                                               |
| `/random_pictures [N]`       | 随机获取图片（N 1~10 张）                                                                                                                                                                                                                                                                                                                                                               | commands/randomPictures.js                                             |
| `/mark`                      | 标记模式（单选题：发媒体正常标记 / 「📝 仅记录」只记录，完成即退出）                                                                                                                                                                                                                                                                                                                     | modes/markMode.js                                                      |
| `/send`                      | 发送模式（选择群组/频道发送并收录；发送后先显示"正在发送中"再刷新为结果，可打标签——打标签面板为两区版面：上区=已有标签（点击移除）、下区=标签库（置顶在前、点击添加）；媒体组**描述先行带上**（发送时先内联带在第一条上，任何副本/自动转发都带描述），发完再还原到原本的媒体位置并对该媒体打标签；发文本同样收录为 `media_type='text'`）                                                | modes/sendMode.js                                                      |
| `/tag`                       | 标签模式（修改消息标签 / 编辑标签：添加、改名、删除、固定置顶位置，同步 message）。标签按 message 独立：新增/修改文本只打该条 message 的标签；修改消息标签时只作用于定位的那条媒体，并把组内所有带文本 message 的标签分别列出。**添加标签为两区版面**：上区=已有标签（点击移除），下区=标签库（置顶标签在最前，点击添加；已打上的非置顶标签不再重复显示，已打上的置顶标签仍保留在下区） | modes/tagMode.js                                                       |
| `/edit`                      | 编辑消息正文（媒体改 caption、**机器人发出的文本消息改消息 text**；私聊可发媒体、**消息链接**或**转发来源**定位；群组/频道中管理员回复一条消息并发送 `/edit [新描述]` 可跳过定位直接修改，支持 `/edit@机器人用户名`，操作记录 1 分钟后自动删除；文本消息不能 `/null` 清空）                                                                                                             | modes/editMode.js、handlers/groupReplyEdit.js、utils/messageLocator.js |
| `/log`                       | 查看操作统计                                                                                                                                                                                                                                                                                                                                                                            | commands/log.js                                                        |
| `/help`                      | 显示命令列表按钮                                                                                                                                                                                                                                                                                                                                                                        | commands/help.js                                                       |
| `/setting`                   | 全局设置面板                                                                                                                                                                                                                                                                                                                                                                            | modes/settingMode.js                                                   |
| `/transport`                 | 搬运链接管理（列表带活性徽标与失效原因，进入时自动补查过期记录；支持全量/单条活性检查，新增与改链接后立即实测）                                                                                                                                                                                                                                                                         | modes/transportMode.js、utils/linkHealth.js                            |
| `/password`                  | 媒体文件密码设置                                                                                                                                                                                                                                                                                                                                                                        | modes/passwordMode.js                                                  |
| `/manage`                    | 管理面板（群组/用户/白名单）                                                                                                                                                                                                                                                                                                                                                            | modes/manage/                                                          |
| `/exit`                      | 退出当前模式                                                                                                                                                                                                                                                                                                                                                                            | commands/exit.js                                                       |

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

| 功能                  | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 媒体自动收录          | 群组/频道媒体自动入库（去重），带文本的媒体同步写入 message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 频道转发双位置        | 频道转发至群组的媒体（含 `is_automatic_forward` 自动转发识别）在 message 记录新增 `channel_forward`、media 记录写入 `group`/`channel` 双位置，回复时可选回复在频道或群组；**`/send` 刚把同一批媒体发给频道时**（Telegram 会立刻自动转发到关联讨论群），库里可能还没落库 → 先按 `utils/inflight.js` 的登记短暂等落库完成再收录，**不另建"无描述、可清理"的影子媒体组**，只补一个群组位置                                                                                                                                                                                                          |
| 编辑同步              | 消息编辑/删除后自动同步数据库                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 回复 `/edit` 快捷编辑 | 管理员回复一条消息并发送 `/edit [新描述]`（支持 `/edit@机器人用户名`）可直接修改该消息：媒体改 Telegram caption、**机器人发出的文本消息改消息 text**（正文同步进 `media.media_name`）+ 同步数据库 + 按新文本重算该媒体标签；**新正文严格保留管理员发来的格式**（entities 原样带上，含 `/edit@Bot ` 前缀的偏移平移；没有格式时才退回 HTML/纯文本）；被回复的是**频道帖的自动转发副本**时按转发来源定位频道源消息再改；库里没有记录的消息也允许改（只改 Telegram）；文本消息不能 `/null` 清空；超 48 小时自动降级为仅更新数据库；**1 分钟后自动删除全部操作记录**（机器人提示 + 管理员的命令消息） |
| 关键字查询            | 管理员在群组中发送文本自动搜索                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 成员记录              | 加入/退出自动记录，可配置封禁策略                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 入群审批              | 关联频道的用户自动通过加群申请                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

---

## 数据库设计

### 集合总览

| 集合            | 存储内容                                                                              | 文档数            |
| --------------- | ------------------------------------------------------------------------------------- | ----------------- |
| `message`       | 消息元数据（文本、类型、标签、频道转发信息）                                          | 与带文本媒体对应  |
| `media`         | 媒体文件记录（file_id、密码、group/channel 双位置）                                   | 每条媒体一条记录  |
| `group_list`    | 媒体组汇总信息（`is_group` 计数、`is_delete` 标记、`mark` 次数、`tags` 组内标签并集） | 每组一条          |
| `channel_group` | 管理的群组/频道                                                                       | 每个群组/频道一条 |
| `users`         | 用户信息及权限                                                                        | 每个用户一条      |
| `log`           | 操作审计日志                                                                          | 每次操作一条      |
| `transport`     | 搬运源链接                                                                            | 每个搬运源一条    |
| `settings`      | 全局设置（单文档）                                                                    | 固定1条           |
| `tags`          | 标签库（`{name, pin, count}`：名称、置顶位置、使用次数）                              | 每个标签一条      |

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
