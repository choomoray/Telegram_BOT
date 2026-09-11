// tests/chatMember.test.js
/**
 * chat_member 事件回归：解封不能被当成退群（"退出即封禁"误伤）
 *
 * 场景（用户反馈）：管理员在频道/群的「已移除用户 / 黑名单」里把某用户移除（= 解除封禁），
 * Telegram 发来的是 `kicked → left`（用户并没有主动退群），老实现只看新状态 left，
 * 于是当成退群 → removeUserFromGroup → 立即又把人封回去。
 * 现在必须识别为解封：库状态同步为正常、不做任何自动封禁。
 *
 * 注意：每个用例用不同的 userId —— db/users.js 的"最近解封"标记是按 userId 记的（TTL 2 分钟），
 * 复用同一个 id 会让后面的用例命中 TTL 保护而误判。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const root = path.join(__dirname, '..');
const {
    store,
    installMemoryDb,
    installBotStub,
    installLoggerStub,
    relaxTimers,
    resetStore
} = require('./helpers/memoryDb');

relaxTimers(); // db/users.js 里有清理定时器，测试里要让它不阻塞退出
installMemoryDb(root);
const { bot } = installBotStub(root);
installLoggerStub(root);

const { handleChatMemberUpdate } = require('../handlers/chatMemberHandler');
const { isRecentlyUnbanned } = require('../db/users');

const CHAT = -1009999;

const memberUpdate = (userId, oldStatus, newStatus) => ({
    chat: { id: CHAT, title: '测试频道' },
    old_chat_member: { status: oldStatus, user: { id: userId } },
    new_chat_member: { status: newStatus, user: { id: userId, first_name: '测试' } }
});

const userDoc = (userId) => (store.get('users') || []).find(u => u.id === userId) || null;

function seedUser(userId, state = 0) {
    resetStore();
    store.set('users', [{ _id: 'u1', id: userId, name: '测试', state, white: 0, group: [CHAT], last_seen: Date.now() }]);
}

test('管理员在 Telegram 侧解封（kicked → left）：不当退群、不自动封禁，库状态同步为正常', async () => {
    const USER = 7701;
    seedUser(USER, 0);

    const bans = [];
    bot.banChatMember = async (chatId, userId) => { bans.push([chatId, userId]); return true; };
    bot.unbanChatMember = async () => true;

    await handleChatMemberUpdate(memberUpdate(USER, 'kicked', 'left'));

    assert.deepStrictEqual(bans, [], '不能因为解封事件又去封禁');
    assert.strictEqual(userDoc(USER).state, 1, '库状态同步为正常（1）');
    assert.ok(isRecentlyUnbanned(USER), '标记最近解封，忽略后续 left/kicked 回显');
});

test('管理员解封并直接回到成员（kicked → member）：登记加入且不封禁', async () => {
    const USER = 7702;
    seedUser(USER, 0);
    const bans = [];
    bot.banChatMember = async () => { bans.push(1); return true; };
    bot.unbanChatMember = async () => true;

    await handleChatMemberUpdate(memberUpdate(USER, 'kicked', 'member'));

    assert.deepStrictEqual(bans, [], '不封禁');
    assert.strictEqual(userDoc(USER).state, 1);
    assert.ok((userDoc(USER).group || []).includes(CHAT), '登记回该聊天');
});

test('真正的退群（member → left）仍然维持「退出即封禁」策略', async () => {
    const USER = 7703;
    seedUser(USER, 1);

    const bans = [];
    bot.banChatMember = async (chatId, userId) => { bans.push([chatId, userId]); return true; };
    bot.unbanChatMember = async () => true;

    await handleChatMemberUpdate(memberUpdate(USER, 'member', 'left'));

    assert.ok(bans.length > 0, '主动退群仍然封禁（策略不变）');
    assert.strictEqual(userDoc(USER).state, 0, '库状态为封禁');
});

test('刚被解封的用户的 left 回显被忽略（不再次封禁）', async () => {
    const USER = 7704;
    seedUser(USER, 1);
    bot.banChatMember = async () => true;
    bot.unbanChatMember = async () => true;
    // 先走一次解封（markRecentlyUnbanned 生效）
    await handleChatMemberUpdate(memberUpdate(USER, 'kicked', 'left'));

    const bans = [];
    bot.banChatMember = async (chatId, userId) => { bans.push([chatId, userId]); return true; };
    // 紧接着的 left（解封回显）
    await handleChatMemberUpdate(memberUpdate(USER, 'member', 'left'));

    assert.deepStrictEqual(bans, [], 'TTL 内不再封禁');
    assert.strictEqual(userDoc(USER).state, 1);
});

test('库中已封禁用户重新加入（left → member）仍然被踢出封禁', async () => {
    const USER = 7705;
    seedUser(USER, 0);
    const bans = [];
    bot.banChatMember = async (chatId, userId) => { bans.push([chatId, userId]); return true; };

    await handleChatMemberUpdate(memberUpdate(USER, 'left', 'member'));

    assert.strictEqual(bans.length, 1, '封禁用户加入 → 立即踢出');
    assert.strictEqual(userDoc(USER).state, 0);
});
