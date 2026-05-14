# Telegram 媒体管理机器人

一个功能丰富的 Telegram Bot，用于群组/频道媒体消息的自动收录、检索、回复与管理，并集成 AI 聊天智能体、群组管理和用户权限控制。

## 目录

- [项目结构](#项目结构)
- [核心模块函数索引](#核心模块函数索引)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [指令列表](#指令列表)
- [数据库设计](#数据库设计)
- [管理权限](#管理权限)
- [启动方式](#启动方式)
- [开发规范](#开发规范)

---

## 项目结构
project/
├── index.js # 启动入口，事件监听注册
├── bot.js # Telegram Bot 实例
├── config.js # 环境变量与配置
├── database.js # MongoDB 连接管理
├── logger.js # 彩色日志系统
├── media.js # 媒体发送、收集与状态清理
├── states.js # 用户状态管理（Map）
├── healthServer.js # 健康检查 HTTP 服务
│
├── utils/ # 工具函数
│ ├── chatIdConverter.js # chat_id 链接转换
│ ├── groupGenerator.js # group_id 生成
│ ├── helpers.js # 用户名称获取
│ ├── levelExtractor.js # 等级标记提取
│ ├── loadSystemPrompt.js # AI 系统提示加载
│ ├── modeNames.js # 模式名称映射
│ ├── queryCache.js # 查询结果分页缓存
│ ├── queryFormatter.js # 查询结果显示格式化
│ ├── queryParser.js # 查询条件解析
│ ├── sanitize.js # HTML 转义
│ ├── sendMedia.js # 媒体组发送
│ ├── enterMode.js # 模式切换公共清理
│ └── safeApiCall.js # API 自动重试工具
│
├── db/ # 数据库操作层
│ ├── index.js # 集合索引初始化
│ ├── getCollection.js # 获取集合对象
│ ├── collections.js # 集合名称常量
│ ├── channelGroup.js # 频道/群组记录
│ ├── groupList.js # 媒体组汇总
│ ├── log.js # 操作日志
│ ├── media.js # 媒体文件记录
│ ├── message.js # 消息记录
│ ├── settings.js # 全局配置（含原用户设置）
│ ├── transport.js # 搬运链接记录
│ └── users.js # 用户信息、封禁、白名单
│
├── ai/ # AI 相关
│ ├── deepseek.js # DeepSeek API 封装
│ ├── lmstudio.js # LM Studio API 封装
│ └── AI Read/ # AI 知识库（Markdown）
│ ├── 00-core.md
│ ├── 01-commands.md
│ └── 02-database.md
│
├── handlers/ # 业务逻辑
│ ├── messageHandlers.js # 私聊消息入口
│ ├── groupMessageHandlers.js # 群组消息（收录/编辑）
│ ├── callbackHandler.js # 回调查询入口
│ ├── queryHandler.js # 关键字查询分页
│ ├── cleanHelpers.js # 自定义清理辅助发送
│ │
│ ├── commands/ # /xxx 命令处理函数
│ │ ├── index.js # 命令动态加载与分发
│ │ ├── chat.js
│ │ ├── clean.js
│ │ ├── delete.js
│ │ ├── deleteGroup.js
│ │ ├── edit.js
│ │ ├── exit.js
│ │ ├── help.js
│ │ ├── log.js
│ │ ├── mark.js
│ │ ├── mediaGroup.js
│ │ ├── mediaHide.js
│ │ ├── mediaUnhide.js
│ │ ├── messageReply.js
│ │ ├── password.js
│ │ ├── randomPictures.js
│ │ ├── randomVideos.js
│ │ ├── search.js
│ │ ├── setting.js
│ │ └── transport.js
│ │
│ ├── modes/ # 模式具体逻辑
│ │ ├── index.js # 模式分发
│ │ ├── chatMode.js # AI 聊天模式
│ │ ├── mediaCollectMode.js # 媒体收集（合并/遮罩/去遮罩）
│ │ ├── messageReplyMode.js # 消息回复流程
│ │ ├── deleteMode.js
│ │ ├── deleteGroupMode.js
│ │ ├── searchMode.js
│ │ ├── cleanMode.js
│ │ ├── markMode.js
│ │ ├── editMode.js
│ │ ├── settingMode.js
│ │ ├── transportMode.js
│ │ ├── passwordMode.js
│ │ └── manage/ # 管理模式（拆分）
│ │   ├── index.js # 回调分发 + 文本消息路由
│ │   ├── mainMenu.js # 主菜单
│ │   ├── groups.js # 群组 CRUD
│ │   ├── users.js # 用户封禁/解封
│ │   ├── whitelist.js # 白名单管理
│ │   └── dashboard.js # 系统概览
│ │
│ └── callbacks/ # 内联按钮回调处理
│ ├── index.js # 回调前缀分发
│ ├── mediaCallback.js
│ ├── directCallback.js
│ ├── directConfirmCallback.js
│ ├── pageCallback.js
│ ├── toggleCallback.js
│ └── ...
│
└── logs/ # 日志文件（自动生成）
├── error.log
└── operation.log



---

## 核心模块函数索引

### 1. index.js - 程序入口

| 导出函数                   | 说明                                    |
| -------------------------- | --------------------------------------- |
| `start()`                  | 连接数据库、加载配置、启动Bot、注册事件 |
| `processPendingMessages()` | 处理数据库就绪前缓存的消息              |

### 2. bot.js

| 导出实例 | 说明                                          |
| -------- | --------------------------------------------- |
| `bot`    | 已配置 `allowed_updates` 的 Telegram Bot 实例 |

### 3. config.js

| 导出属性                  | 说明           |
| ------------------------- | -------------- |
| `TELEGRAM_BOT_TOKEN`      | TG Bot Token   |
| `MONGODB_URI`             | 主数据库连接   |
| `TEST_MONGODB_URI`        | 测试数据库连接 |
| `ADMIN_CHAT_IDS`          | 管理员 ID 数组 |
| `isTestMode`              | 是否测试模式   |
| `DEEPSEEK_API_URL/KEY` 等 | 模型连接参数   |

### 4. database.js

| 导出函数            | 说明                   |
| ------------------- | ---------------------- |
| `connectDB()`       | 连接 MongoDB，支持重试 |
| `getDb()`           | 获取数据库实例         |
| `getClient()`       | 获取 MongoClient 实例  |
| `getDatabaseName()` | 获取当前库名           |

### 5. logger.js

| 导出方法                | 说明         |
| ----------------------- | ------------ |
| `error(msg, ...args)`   | 红色错误日志 |
| `warn(msg, ...args)`    | 黄色警告日志 |
| `success(msg, ...args)` | 绿色成功日志 |
| `info(msg, ...args)`    | 蓝色普通信息 |

### 6. media.js

| 导出函数                                              | 说明                   |
| ----------------------------------------------------- | ---------------------- |
| `extractMediaFromMessage(msg)`                        | 从消息中提取媒体信息   |
| `sendMediaAsReply(chatId, replyId, media)`            | 回复单个媒体           |
| `sendMediaGroupAsReply(chatId, replyId, items, size)` | 分组回复媒体组         |
| `clearMediaGroupState(userId, send, state)`           | 清理媒体收集状态并发送 |
| `sendMediaSubgroup(chatId, groupId, subgroup)`        | 发送指定 subgroup      |
| `sendMediaGroup(chatId, groupId)`                     | 发送整个媒体组         |

### 7. states.js

| 导出函数                      | 说明                       |
| ----------------------------- | -------------------------- |
| `getUserState(userId)`        | 获取状态（带超时检测）     |
| `getRawUserState(userId)`     | 获取原始状态（不检测超时） |
| `setUserState(userId, state)` | 设置状态                   |
| `deleteUserState(userId)`     | 删除状态                   |
| `updateUserActivity(userId)`  | 更新最后活动时间           |

### 8. db/ 目录各文件主要函数

| 文件              | 主要函数                            | 说明                      |
| ----------------- | ----------------------------------- | ------------------------- |
| `channelGroup.js` | `getAllChannelGroups`               | 获取所有管理的群组/频道   |
|                   | `upsertChannelGroup`                | 插入或更新群组信息        |
|                   | `updateChannelGroup`                | 单字段更新                |
|                   | `deleteChannelGroup`                | 删除记录                  |
| `groupList.js`    | `upsertGroupList`                   | 原子增加 is_group 计数    |
|                   | `setGroupDelete`                    | 设置删除标记              |
|                   | `deleteGroupList`                   | 删除组记录                |
| `log.js`          | `insertLog(type, userId, extra)`    | 写入操作日志              |
| `media.js`        | `insertMedia`                       | 插入媒体文件              |
|                   | `findMediaByFileUniqueId`           | 按 file_unique_id 查询    |
|                   | `findMediaByGroupId`                | 按 group_id 查询          |
|                   | `updateMediaPassword`               | 更新密码字段              |
| `message.js`      | `upsertMessage`                     | 插入或更新消息            |
|                   | `findMessageByFileUniqueId`         | 按 file_unique_id 查询    |
|                   | `deleteMessageByFileUniqueId`       | 删除消息                  |
| `settings.js`     | `getSettings`                       | 获取全局设置（缓存）      |
|                   | `loadSettings(config)`              | 启动时加载设置到 config   |
|                   | `updateSetting(config, key, value)` | 更新单个全局设置          |
| `transport.js`    | `getAllTransports`                  | 获取搬运记录              |
|                   | `upsertTransport`                   | 插入或更新搬运            |
|                   | `extractChatInfo(url, bot)`         | 从链接解析群组信息        |
| `users.js`        | `addUserToGroup`                    | 记录用户加入群组          |
|                   | `removeUserFromGroup`               | 用户离开触发自动封禁      |
|                   | `banUserFully`                      | 全平台封禁（数据库+群组） |
|                   | `unbanUserFully`                    | 全平台解封                |
|                   | `isUserAllowed`                     | 检查是否允许使用私聊      |
|                   | `setUserWhite`                      | 设置白名单标记            |
|                   | `getAllUsers`                       | 获取所有用户              |

### 9. handlers/ 目录关键文件

| 文件                        | 主要函数                   | 说明                      |
| --------------------------- | -------------------------- | ------------------------- |
| `messageHandlers.js`        | `handlePrivateMessage`     | 私聊消息总入口            |
| `groupMessageHandlers.js`   | `handleGroupMessage`       | 群组消息入口（收录/查询） |
|                             | `handleGroupEditedMessage` | 群组编辑消息              |
| `queryHandler.js`           | `handleQuery`              | 处理关键字查询            |
|                             | `isAdmin`                  | 管理员判断                |
| `modes/index.js`            | `handleModeMessage`        | 模式消息分发              |
| `modes/mediaCollectMode.js` | `handleMediaCollectMode`   | 媒体收集统一处理          |
| `modes/messageReplyMode.js` | `handleMessageReplyMode`   | 消息回复流程              |
| `modes/manage/index.js`    | `handleCallback`           | 管理面板回调              |
|                             | `handleManageMessage`      | 管理模式消息处理          |
|                             | `showMainMenu`             | 显示管理主菜单            |
| `callbacks/index.js`        | `handleCallbackQuery`      | 回调分发（含动态前缀）    |

### 10. utils/ 工具函数

| 文件                 | 主要函数                     | 说明                   |
| -------------------- | ---------------------------- | ---------------------- |
| `chatIdConverter.js` | `generateMessageLink`        | 生成 t.me 跳转链接     |
| `groupGenerator.js`  | `generateGroupIdFromMessage` | 自动生成 group_id      |
| `levelExtractor.js`  | `extractLevel`               | 提取 `#S` 等级         |
|                      | `removeLevelSuffix`          | 移除等级标记           |
| `queryCache.js`      | `createSession`              | 创建分页查询会话       |
|                      | `getPageResults`             | 获取指定页结果         |
| `queryParser.js`     | `parseQuery`                 | 解析查询标记           |
| `queryFormatter.js`  | `formatQueryResults`         | 格式化查询结果         |
|                      | `buildFoldKeyboard`          | 构建翻页键盘           |
|                      | `buildNumberKeyboard`        | 构建编号键盘           |
| `sanitize.js`        | `escapeHTML`                 | HTML 特殊字符转义      |
| `sendMedia.js`       | `sendMediaGroup`             | 通用媒体组发送         |
| `modeNames.js`       | `getModeName`                | 获取模式中文名称       |
| `loadSystemPrompt.js`| `loadSystemPrompt`           | 加载 AI 系统提示词     |
| `enterMode.js`       | `cleanPreviousMode`          | 切换模式时清理上一模式 |
| `safeApiCall.js`     | `safeApiCall`                | API 调用自动重试       |

---

## 快速开始

1. 克隆项目并安装依赖：
   ```bash
   npm install
   创建 .env 文件（参考 环境变量）。

启动机器人：

```bash
node index.js          # 正常模式
node index.js --test   # 测试模式
```

环境变量
env
TELEGRAM_BOT_TOKEN=your_bot_token
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net
TEST_MONGODB_URI=mongodb+srv://user:pass@test-cluster.mongodb.net
ADMIN_CHAT_ID=123456789,987654321
DEEPSEEK_API_URL=http://127.0.0.1:55555/v1/chat/completions
DEEPSEEK_API_KEY=sk-any
DEEPSEEK_MODEL=deepseek-chat
LMSTUDIO_API_URL=http://localhost:1234/v1/chat/completions
LMSTUDIO_MODEL=qwen2.5-0.5b

指令列表
私聊命令
命令	功能
/chat	AI 聊天（支持选择模型）
/media_group	媒体合并模式
/media_hide	媒体遮罩模式
/media_unhide	媒体去遮罩模式
/message_reply	在群组中回复指定消息
/search	查找媒体是否入库
/delete	删除单一媒体
/delete_group	删除整个媒体组
/clean	数据库清理（空数据删除）
/random_videos	随机获取视频
/random_pictures	随机获取图片
/mark	标记模式（增加 mark 计数）
/edit	编辑消息文本或清空
/log	查看操作统计
/help	显示命令列表（按钮）
/setting	配置面板（全局）
/transport	搬运记录管理
/password	媒体文件密码
/manage	管理模式（群组/用户/白名单）
/exit	退出当前模式

群组/频道自动功能
媒体消息自动收录（去重、等级标记）

编辑消息同步更新/删除

管理员可进行关键字查询

成员加入/退出自动记录并可触发封禁

关联群组的加入请求自动审批

数据库设计
见项目根目录 Abstract.md V0.1 ~ V0.8 节中的详细表结构说明。

管理权限
所有私聊命令仅限 ADMIN_CHAT_ID 中的管理员使用。

群组中的查询、编辑等操作同样仅管理员可用。

非管理员私聊将收到“权限错误”提示。

普通用户加入关联频道且未被封禁时，可自动通过群组审批。

启动方式
```bash
node index.js          # 正常启动
node index.js --test   # 测试启动（使用测试数据库，数据库名加 _test 后缀）
```

启动流程：

连接 MongoDB（重试6次，共30秒）

初始化集合索引

加载 settings 集合中的动态配置

启动 Telegram Bot polling

处理缓存消息

记录启动日志

开发规范
遵循 AI准则.md 中的代码简洁原则，避免推测性代码和过度抽象。

新增指令：在 handlers/commands/ 中添加文件，按命名规则自动映射。

新增模式：在 handlers/modes/ 中实现，并在 modes/index.js 注册。复杂模式可拆分子目录（如 manage/）。

新增回调前缀：在 handlers/callbacks/index.js 中添加静态映射或动态检测。

修改数据库表：更新 db/index.js 的索引初始化代码。

重要操作需记录日志，调用 insertLog。

用户可见的错误应捕获并发送提示，避免崩溃。

使用 safeApiCall 包裹关键 Telegram API 调用，提高稳定性。

