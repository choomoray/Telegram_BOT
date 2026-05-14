// handlers/commands/log.js
const bot = require('../../bot');
const logger = require('../../logger');
const { getCollection, COLLECTIONS } = require('../../db/getCollection');

const TYPE_NAMES = {
    1: '收录',
    2: '编辑',
    3: '删除',
    11: '随机视频',
    12: '随机图片',
    13: '消息回复',
    14: '媒体合并',
    15: '媒体遮罩',
    16: '帮助',
    17: '查找',
    18: '清理',
    19: '删除',
    20: '标记',
    21: '媒体去遮罩',
    22: '关键字查询',
    23: '修改'
};

const GROUPS = [
    [1, 2, 3],
    [22, 11, 12],
    [13, 14, 15, 21],
    [16, 17, 18, 19, 20, 23]
];

async function handleLogCommand(userId, msg) {
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    let processingMsg;
    try {
        processingMsg = await bot.sendMessage(chatId, '🔍 日志正在查询中...', {
            reply_to_message_id: messageId,
            allow_sending_without_reply: true
        });
    } catch (err) {
        logger.error(`用户 ${userId} /log 发送查询中消息失败: ${err.message}`);
        return;
    }

    (async () => {
        try {
            const logCol = getCollection(COLLECTIONS.LOG);
            const displayTypes = Object.keys(TYPE_NAMES).map(Number);

            // 1. 统计各类型数量
            const typeStats = await logCol.aggregate([
                { $match: { type: { $in: displayTypes } } },
                { $group: { _id: '$type', count: { $sum: 1 } } }
            ]).toArray();

            const typeCountMap = new Map(typeStats.map(item => [item._id, item.count]));
            const totalOps = typeStats.reduce((sum, item) => sum + item.count, 0);

            // 2. 按时间段统计（北京时间，每4小时一段）
            const hourSlots = [
                { label: '00-04', start: 0, end: 4 },
                { label: '04-08', start: 4, end: 8 },
                { label: '08-12', start: 8, end: 12 },
                { label: '12-16', start: 12, end: 16 },
                { label: '16-20', start: 16, end: 20 },
                { label: '20-24', start: 20, end: 24 }
            ];

            const hourStats = await logCol.aggregate([
                { $match: { type: { $in: displayTypes }, time: { $exists: true } } },
                {
                    $group: {
                        _id: { $floor: { $divide: [{ $hour: { date: '$time', timezone: '+08:00' } }, 4] } },
                        count: { $sum: 1 }
                    }
                }
            ]).toArray();

            const slotCounts = new Array(6).fill(0);
            for (const item of hourStats) {
                const idx = item._id;
                if (idx >= 0 && idx < 6) slotCounts[idx] = item.count;
            }

            // 3. 生成统计文本
            let result = '📊 数据统计\n';

            const group1 = GROUPS[0].map(type => `${TYPE_NAMES[type]}${typeCountMap.get(type) || 0}`).join('、');
            result += group1 + '\n';

            const group2 = GROUPS[1].map(type => `${TYPE_NAMES[type]}${typeCountMap.get(type) || 0}`).join('、');
            result += group2 + '\n';

            const group3 = GROUPS[2].map(type => `${TYPE_NAMES[type]}${typeCountMap.get(type) || 0}`).join('、');
            result += group3 + '\n';

            const group4 = GROUPS[3].map(type => `${TYPE_NAMES[type]}${typeCountMap.get(type) || 0}`).join('、');
            result += group4 + '\n\n';

            // 4. 活跃时间段（改为相对比例）
            result += '📊 活跃时间段\n';
            const maxCount = Math.max(...slotCounts, 1); // 防止除以0
            const maxBars = 10; // 最多显示10个方块
            for (let i = 0; i < hourSlots.length; i++) {
                const slot = hourSlots[i];
                const count = slotCounts[i];
                // 计算相对比例：当前时段数量 / 最大时段数量 * 最大方块数
                const filledBars = Math.round((count / maxCount) * maxBars);
                const emptyBars = maxBars - filledBars;
                const bar = '■'.repeat(filledBars) + '□'.repeat(emptyBars);
                result += `${slot.label}\t${bar}\n`;
            }

            await bot.editMessageText(result, {
                chat_id: chatId,
                message_id: processingMsg.message_id
            });

            logger.info(`用户 ${userId} 执行 /log 统计成功`);
        } catch (err) {
            logger.error(`执行 /log 失败: ${err.message}`);
            try {
                await bot.editMessageText('❌ 统计失败，请稍后重试', {
                    chat_id: chatId,
                    message_id: processingMsg.message_id
                });
            } catch (editErr) {
                logger.error(`编辑错误消息失败: ${editErr.message}`);
            }
        }
    })();
}

module.exports = handleLogCommand;