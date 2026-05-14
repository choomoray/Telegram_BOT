# 可操作的数据库配置

## 集合 settings
用于存储机器人的运行时配置，文档固定 ID 为 `app_settings`。

| 字段                   | 类型    | 允许值       | 说明                 |
| ---------------------- | ------- | ------------ | -------------------- |
| STREAM_OUTPUT          | boolean | true / false | 是否启用流式输出     |
| STREAM_UPDATE_INTERVAL | number  | 100 ~ 5000   | 流式更新间隔（毫秒） |

## 查询示例
获取当前所有设置：
[QUERY:settings:{"_id":"app_settings"}]

## 更新示例
开启流式输出：
[DB:update:settings:STREAM_OUTPUT:true]
设置更新间隔为 300ms：
[DB:update:settings:STREAM_UPDATE_INTERVAL:300]

## 集合 user_setting
存储每个用户的个性化设置，文档 ID 为用户 ID（修改此数据库需要用户ID）。

| 字段                | 类型   | 允许值  | 说明                                         |
| ------------------- | ------ | ------- | -------------------------------------------- |
| search_level        | number | 0 / 1   | 搜索结果是否按等级排序（0关闭，1开启）       |
| search_random       | number | 0 / 1   | 搜索结果是否随机排序（0关闭，1开启）         |
| random_pictures     | number | 0 / 1   | 随机图片来源（0: message集合，1: media集合） |
| random_pictures_num | number | 1 ~ 10  | 随机图片的数量（默认9）                      |
| random_videos_num   | number | 10 ~ 50 | 随机视频的数量（默认15）                     |

## 查询示例
查询指定用户的设置：
[QUERY:user_setting:{"user_id":123456}]

## 更新示例
修改随机图片数量为 6：
[DB:update:user_setting:random_pictures_num:6]
修改随机图片来源为 media 集合：
[DB:update:user_setting:random_pictures:1]
修改随机视频数量为 20：
[DB:update:user_setting:random_videos_num:20]

## 其他可查询集合
- `message` — 收录的媒体消息
- `media` — 媒体文件记录
- `group_list` — 媒体组汇总
- `log` — 操作日志

查询示例（查询最近5条视频消息）：
[QUERY:message:{"media_type":"video","limit":5}]
