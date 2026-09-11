// tests/webuiViews.test.js
/**
 * 前端视图「运行时」渲染 + 交互测试（无需浏览器）：
 *   用最小 DOM/网络桩在 Node 里真正执行 webui/public/app.js，
 *   模拟导航点击与 data-action 点击，断言：
 *     1. 各视图能真实渲染出内容（媒体库 / 搬运收录 / 文章 / 合集 / 原始数据…）
 *     2. 概览页显示数据库占用卡片（字节格式化）
 *     3. 动作分发会发出正确的 API 请求（含查询参数与请求体）
 *     4. 媒体详情：移除整组操作 + 点选媒体后才高亮可改标签
 *     5. 标签视图：顶栏增删/排序、详情置顶切换、拖拽排序保存
 *   uiStatic.test.js 只做静态检查（id/action 是否存在），这里补上"跑起来不报错 + 交互正确"。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'webui', 'public', 'app.js'), 'utf8');
const VOID_TAGS = new Set(['IMG', 'INPUT', 'BR', 'HR']);

// ---------------- 最小 DOM 桩（支持 innerHTML → 子树解析，便于查询子元素） ----------------

function toCamel(name) {
    return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function makeElement(sel = '') {
    const listeners = {};
    const classes = new Set();
    let html = '';
    let children = [];
    const el = {
        sel,
        tagName: 'DIV',
        id: sel.replace(/^#/, ''),
        dataset: {},
        style: {},
        value: '',
        textContent: '',
        placeholder: '',
        className: '',
        disabled: false,
        open: false,
        parentElement: null,
        classList: {
            add: (...c) => c.forEach(x => classes.add(x)),
            remove: (...c) => c.forEach(x => classes.delete(x)),
            toggle: (c, on) => {
                const next = on === undefined ? !classes.has(c) : !!on;
                if (next) classes.add(c); else classes.delete(c);
                return next;
            },
            contains: (c) => classes.has(c)
        },
        get innerHTML() { return html; },
        set innerHTML(v) {
            html = String(v ?? '');
            children = parseTree(html, el);
        },
        get children() { return children; },
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        removeEventListener() { },
        async fire(type, ev) {
            const fns = listeners[type] || [];
            return Promise.all(fns.map(fn => fn(ev || {})));
        },
        appendChild(child) { if (child) { children.push(child); if (child.parentElement !== undefined) child.parentElement = el; } },
        prepend(child) { if (child) { children.unshift(child); if (child.parentElement !== undefined) child.parentElement = el; } },
        insertBefore(node, ref) {
            children = children.filter(c => c !== node);
            const idx = ref ? children.indexOf(ref) : -1;
            if (idx >= 0) children.splice(idx, 0, node); else children.push(node);
            if (node) node.parentElement = el;
        },
        get nextSibling() {
            const p = el.parentElement;
            if (!p) return null;
            const i = p.children.indexOf(el);
            return i >= 0 ? (p.children[i + 1] || null) : null;
        },
        remove() { },
        focus() { },
        setAttribute() { },
        removeAttribute() { },
        getBoundingClientRect: () => ({ left: 0, width: 100, top: 0, height: 20 }),
        showModal() { el.open = true; },
        close() { el.open = false; },
        querySelectorAll: (s) => queryAll(el, s),
        querySelector: (s) => queryAll(el, s)[0] || null,
        // 只支持类选择器（够用即可）；祖先查找交给测试助手包装
        closest: (sel) => {
            const cls = String(sel || '').replace(/^[a-zA-Z]+/, '').replace(/^\./, '');
            if (!cls) return null;
            let node = el;
            while (node) {
                if ((node.classList && node.classList.contains(cls)) || node.className === cls) return node;
                node = node.parentElement;
            }
            return null;
        }
    };
    return el;
}

/** 极简 HTML 解析：只用于测试，按标签层级建树，读取 class / data-* / disabled */
function parseTree(html, owner) {
    const out = [];
    const stack = [{ el: owner, nodes: out }];
    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
    let m;
    while ((m = tagRe.exec(html))) {
        const [, closing, rawTag, attrs] = m;
        const tag = rawTag.toUpperCase();
        if (closing) {
            if (stack.length > 1) stack.pop();
            continue;
        }
        const child = makeElement('');
        child.tagName = tag;
        const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1];
        child.className = cls;
        cls.split(/\s+/).filter(Boolean).forEach(c => child.classList.add(c));
        for (const dm of attrs.matchAll(/data-([a-zA-Z0-9-]+)="([^"]*)"/g)) {
            child.dataset[toCamel(dm[1])] = dm[2];
        }
        child.id = (attrs.match(/id="([^"]*)"/) || [, ''])[1];
        child.value = (attrs.match(/value="([^"]*)"/) || [, ''])[1];
        child.disabled = /\sdisabled(\s|>|$)/.test(attrs);
        const top = stack[stack.length - 1];
        child.parentElement = top.el;
        top.nodes.push(child);
        const isVoid = VOID_TAGS.has(tag) || attrs.trim().endsWith('/');
        if (!isVoid) stack.push({ el: child, nodes: child.children });
    }
    return out;
}

/** 在元素子树里按 class 选择器查找（仅支持 .cls 与 tag.cls 的简化形式） */
function queryAll(root, selector) {
    const cls = String(selector).replace(/^[a-zA-Z]+/, '').replace(/^\./, '');
    const results = [];
    const walk = (nodes) => {
        for (const n of nodes) {
            if ((n.classList && n.classList.contains(cls)) || n.className === cls) results.push(n);
            if (n.children && n.children.length) walk(n.children);
        }
    };
    walk(root.children || []);
    return results;
}

// ---------------- 沙箱 ----------------

function makeSandbox(fixtures) {
    const els = new Map();
    const document = {
        documentElement: makeElement('html'),
        querySelector(sel) {
            if (!els.has(sel)) els.set(sel, makeElement(sel));
            return els.get(sel);
        },
        // 表单字段收集（openForm → submitForm 会走这条路径）
        querySelectorAll(sel) {
            if (sel === '#form-body [data-field]') {
                const body = els.get('#form-body');
                if (!body) return [];
                const collect = (nodes) => nodes.flatMap(n => [n, ...collect(n.children || [])]);
                return collect(body.children).filter(n => n.dataset && n.dataset.field !== undefined);
            }
            return [];
        },
        createElement: (tag) => makeElement(tag),
        addEventListener() { }
    };
    const store = new Map([['webui_token', 'test-token']]);
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k)
    };
    const requests = [];
    const opens = [];
    const keys = Object.keys(fixtures).sort((a, b) => b.length - a.length); // 长路径优先，避免 /api/tags 抢走 /api/tags/create
    const fetchStub = async (url, opts = {}) => {
        const full = String(url);
        const body = opts.body ? JSON.parse(opts.body) : null;
        requests.push({ url: full, method: opts.method || 'GET', body });
        let payload = {};
        const hit = keys.find(k => full.startsWith(k));
        if (hit) {
            const v = fixtures[hit];
            payload = typeof v === 'function' ? v({ url: full, method: opts.method || 'GET', body }) : v;
        }
        return { ok: true, status: 200, json: async () => payload };
    };
    class EventSourceStub {
        constructor(url) { this.url = url; }
        addEventListener() { }
        close() { }
    }
    const sandbox = {
        document,
        window: {
            matchMedia: () => ({ matches: false, addEventListener() { } }),
            open: (url, target, features) => opens.push({ url, target, features })
        },
        localStorage,
        fetch: fetchStub,
        EventSource: EventSourceStub,
        location: { reload() { } },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        URLSearchParams,
        console
    };
    sandbox.globalThis = sandbox;
    return { sandbox, document, requests, opens };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 30));

function fixtures() {
    const now = Date.now();
    return {
        '/api/overview': {
            counts: { media: 12, groupList: 4, kept: 3, cleanable: 1, users: 2, whitelist: 1, banned: 0, tags: 3, chats: 2, bound: 1, logs: 9 },
            mediaByType: { photo: 3, video: 1 },
            recent: [],
            latestGroupList: []
        },
        '/api/db-stats': {
            ok: true, available: true, database: 'telegram_bot_test', at: now, reason: null,
            totals: { collections: 3, objects: 10, dataSize: 2048, storageSize: 4096, indexes: 5, indexSize: 1024, avgObjSize: 204.567 },
            collections: [{ name: 'media', label: '媒体文件', count: 5, size: 1024, storageSize: 2048, indexSize: 512, nindexes: 2, avgObjSize: 204.567, available: true, error: null }]
        },
        '/api/db/collections': { collections: ['media', 'transport'] },
        '/api/db/query': { all: true, limit: 50, groups: [{ collection: 'media', total: 5, items: [] }] },
        '/api/tags': {
            tags: [
                { name: 'AAA', pin: 1, count: 3, usage: 5 },
                { name: 'BBB', pin: 0, count: 1, usage: 2 },
                { name: 'CCC', pin: 0, count: 0, usage: 0 }
            ],
            total: 3
        },
        '/api/transport': {
            items: [{ chat_id: -1001, chat_name: '有效频道', url: 'https://t.me/alive', link: 'https://t.me/alive', num: 5, alive: true, last_check_at: now, last_check_status: 'ok', last_check_error: null }],
            total: 1, page: 1, pageSize: 20, totalPages: 1,
            counts: { all: 1, alive: 1, dead: 0, unchecked: 0 }
        },
        '/api/articles': {
            items: [{ id: 1, title: '文章A', link: 'https://telegra.ph/a', subCount: 1, updated_at: now, subs: [{ id: 1, article_id: 1, title: '第一章', link: 'https://telegra.ph/1' }] }],
            total: 1, page: 1, pageSize: 20, totalPages: 1, subTotal: 1
        },
        '/api/collections': {
            items: [{ id: 1, name: '合集A', type: 'collection', subCount: 1, updated_at: now, subs: [{ id: 1, collection_id: 1, name: '子项X', link: 'https://t.me/x' }] }],
            counts: { all: 1, collection: 1, misc: 0 }, subTotal: 1
        },
        '/api/media': (req) => {
            if (req.url.includes('tag=AAA')) {
                return {
                    total: 1, page: 1, pageSize: 12, totalPages: 1,
                    items: [{
                        group_id: '-100_1', is_group: 2, is_delete: 0, cleanable: false,
                        mediaCount: 2, subgroups: 1, types: ['photo', 'video'],
                        preview: { file_unique_id: 'AQAD1', media_type: 'photo', thumbable: true },
                        text: '有标签的描述', tags: ['AAA'],
                        group: { chat_id: -100, message_id: 11 }, channel: null
                    }]
                };
            }
            return { total: 0, page: 1, pageSize: 12, totalPages: 1, items: [] };
        },
        '/api/media/detail': (req) => {
            // 默认组 -100_1；-100_3 是「有媒体但完全没有文本记录」的组；-100_4 是只有一个媒体的组
            const groupId = decodeURIComponent((req.url.match(/groupId=([^&]*)/) || [, '-100_1'])[1]);
            if (groupId === '-100_3') {
                return {
                    group: { group_id: '-100_3', is_group: 2, is_delete: Date.now(), mark: 0, cleanable: true },
                    media: [
                        { file_unique_id: 'AQAD31', media_type: 'photo', subgroup: 1, message_id: 31, thumbable: false, group: { chat_id: -100, message_id: 31 }, channel: null },
                        { file_unique_id: 'AQAD32', media_type: 'video', subgroup: 2, message_id: 32, video_time: 12, thumbable: false, group: { chat_id: -100, message_id: 32 }, channel: null }
                    ],
                    messages: []
                };
            }
            if (groupId === '-100_4') {
                return {
                    group: { group_id: '-100_4', is_group: 1, is_delete: 0, mark: 0, cleanable: false },
                    media: [
                        { file_unique_id: 'AQAD41', media_type: 'photo', subgroup: 1, message_id: 41, thumbable: false, group: { chat_id: -100, message_id: 41 }, channel: null }
                    ],
                    messages: [
                        { file_unique_id: 'AQAD41', text: '单媒体描述', tags: ['JK'], chat_id: -100, message_id: 41 }
                    ]
                };
            }
            return {
                group: { group_id: '-100_1', is_group: 2, is_delete: 0, mark: 1, cleanable: false },
                media: [
                    { file_unique_id: 'AQAD1', media_type: 'photo', subgroup: 1, message_id: 11, thumbable: false, group: { chat_id: -100, message_id: 11 } },
                    { file_unique_id: 'AQAD2', media_type: 'video', subgroup: 1, message_id: 12, video_time: 30, thumbable: false, group: { chat_id: -100, message_id: 12 } }
                ],
                messages: [
                    { file_unique_id: 'AQAD1', text: '有标签的描述', tags: ['JK'], chat_id: -100, message_id: 11 },
                    { file_unique_id: 'AQAD2', text: '无标签的描述', tags: [], chat_id: -100, message_id: 12 }
                ]
            };
        },
        '/api/stats': (req) => {
            const params = new URLSearchParams(req.url.split('?')[1] || '');
            const period = params.get('period') === 'year' ? 'year' : 'month';
            const year = Number(params.get('year')) || 2026;
            const month = Number(params.get('month')) || 1;
            return {
                period,
                year,
                month: period === 'month' ? month : null,
                label: period === 'month' ? `${year} 年 ${month} 月` : `${year} 年`,
                from: 0, to: 0, scanned: 3, truncated: false,
                totals: { operations: 3, media: 1, groups: 1, activeDays: 2, avgPerDay: 1.5 },
                previous: { label: '上期', totals: { operations: 1 }, operationsDelta: 200, mediaDelta: null },
                byDay: [
                    { day: `${year}-${String(month).padStart(2, '0')}-02`, count: 1, media: 1, groups: 1 },
                    { day: `${year}-${String(month).padStart(2, '0')}-05`, count: 4, media: 0, groups: 0 }
                ],
                byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: h === 9 ? 2 : (h === 21 ? 4 : 0), media: 0 })),
                byAction: [{ action: 'media_save', label: '媒体收录', category: 'media', count: 3, media: 1, groups: 1, fail: 0, users: 1 }],
                byCategory: [{ category: 'media', label: '媒体', count: 3, actions: {} }],
                topUsers: [{ userId: 123, count: 3 }],
                failures: { count: 0, byAction: {} },
                catalog: { categories: { media: '媒体' }, actions: [{ action: 'media_save', label: '媒体收录', category: 'media' }] }
            };
        },
        '/api/oplogs': { total: 0, page: 1, pageSize: 30, totalPages: 1, items: [], catalog: { categories: {}, actions: [] } },
    };
}

async function boot(fx) {
    const env = makeSandbox(fx || fixtures());
    vm.createContext(env.sandbox);
    vm.runInContext(APP_SOURCE, env.sandbox, { filename: 'app.js' });
    await tick();
    return env;
}

async function goto(env, view) {
    const nav = env.document.querySelector('#nav');
    await nav.fire('click', { target: { closest: (sel) => (sel === '.nav-item' ? { dataset: { view } } : null) } });
    await tick();
    return env.document.querySelector('#view');
}

/** 模拟点击 #view 内带 data-action 的元素 */
async function act(env, dataset, extra = {}) {
    const el = { dataset, tagName: 'BUTTON', ...extra };
    await env.document.querySelector('#view').fire('click', { target: { closest: () => el, tagName: 'BUTTON' } });
    await tick();
    return el;
}

/** 模拟点击 #view 内带 data-action 的元素（不等待处理函数完成，用于会弹二次确认的动作） */
async function actNoWait(env, dataset, extra = {}) {
    const el = { dataset, tagName: 'BUTTON', ...extra };
    env.document.querySelector('#view').fire('click', { target: { closest: () => el, tagName: 'BUTTON' } });
    await tick();
    return el;
}

/** 模拟点击详情对话框内带 data-action 的元素（closest 支持 .msg-block，便于解析出所属媒体） */
async function actDialog(env, dataset, extra = {}) {
    const el = { dataset, tagName: 'BUTTON', ...extra };
    el.closest = (sel) => {
        if (sel === '[data-action]') return el;
        if (sel === '.msg-block' && el.dataset.file) {
            return env.document.querySelector('#detail-body').querySelectorAll('.msg-block')
                .find(b => b.dataset.msg === el.dataset.file) || null;
        }
        return null;
    };
    await env.document.querySelector('#detail-dialog').fire('click', {
        target: { closest: (sel) => el.closest(sel), tagName: el.tagName, dataset: {} }
    });
    await tick();
    return el;
}

function lastRequest(env, path, method) {
    return env.requests.filter(r => r.url.startsWith(path) && (!method || r.method === method)).pop();
}

// ---------------- 基础视图 ----------------

test('概览页渲染数据库占用卡片（字节格式化 + db-stats 请求）', async () => {
    const env = await boot();
    const html = env.document.querySelector('#view').innerHTML;
    assert.match(html, /数据库占用/);
    assert.match(html, /4\.00 KB/, 'storageSize 4096 应格式化为 4.00 KB');
    assert.ok(env.requests.some(r => r.url.startsWith('/api/db-stats')));
});

test('搬运收录视图：列表、活性徽标、跳转与筛选请求', async () => {
    const env = await boot();
    const view = await goto(env, 'transport');
    assert.match(view.innerHTML, /有效频道/);
    assert.match(view.innerHTML, /✅ 有效/);
    assert.match(view.innerHTML, /全部检查活性/);
    assert.ok(env.requests.some(r => r.url.includes('/api/transport?') && r.url.includes('status=all')));

    await act(env, { action: 'transport-status', status: 'dead' });
    assert.ok(env.requests.some(r => r.url.includes('status=dead')));

    await act(env, { action: 'transport-open', id: '-1001' });
    assert.deepStrictEqual(env.opens.map(o => o.url), ['https://t.me/alive']);

    await act(env, { action: 'transport-check', id: '-1001' });
    const checkReq = lastRequest(env, '/api/transport/check', 'POST');
    assert.deepStrictEqual(checkReq.body, { chat_id: -1001 });
});

test('文章 / 合集视图：渲染与表单', async () => {
    const env = await boot();
    assert.match((await goto(env, 'articles')).innerHTML, /文章A/);
    await act(env, { action: 'article-sub-add', id: '1' });
    assert.match(env.document.querySelector('#form-title').textContent, /新增子文章（文章 #1）/);

    assert.match((await goto(env, 'collections')).innerHTML, /子项X/);
    await act(env, { action: 'collection-type', type: 'misc' });
    assert.ok(env.requests.some(r => r.url.includes('type=misc')));
});

// ---------------- 数据库并入原始数据 ----------------

test('「原始数据」已整合数据库统计：汇总卡 + 集合明细 + 平均文档两位小数', async () => {
    const env = await boot();
    const view = await goto(env, 'raw');
    const html = view.innerHTML;
    assert.match(html, /🗄 数据库存储/);
    assert.match(html, /各集合明细/);
    assert.match(html, /媒体文件/);
    assert.match(html, /2\.00 KB/, '集合 storageSize 2048 → 2.00 KB');
    assert.match(html, /204\.57 B/, '平均文档保留两位小数');
    assert.match(html, /集合浏览/);
    assert.ok(env.requests.some(r => r.url.startsWith('/api/db-stats')));

    await act(env, { action: 'dbstats-refresh' });
    assert.ok(env.requests.some(r => r.url.includes('/api/db-stats?force=1')));
});

test('数据库不可读取大小（降级）时给出提示而不是报错', async () => {
    const fx = fixtures();
    fx['/api/db-stats'] = {
        ok: false, available: false, database: 'x', at: Date.now(),
        reason: 'not authorized on x to execute command { dbStats: 1 }', totals: null, collections: []
    };
    const env = await boot(fx);
    const html = (await goto(env, 'raw')).innerHTML;
    assert.match(html, /无法读取存储大小/);
    assert.match(html, /dbStats/);
});

test('「原始数据」仍能拿到集合名列表（视图状态桶未互相污染）', async () => {
    const env = await boot();
    const html = (await goto(env, 'raw')).innerHTML;
    assert.match(html, /option value="transport"/);
    assert.match(html, /option value="media"/);
});

// ---------------- 媒体详情：点选媒体后高亮可改标签 ----------------

test('媒体详情：移除整组操作，未选中时标签区灰掉不可点', async () => {
    const env = await boot();
    await goto(env, 'media');
    await act(env, { action: 'open-media', group: '-100_1' });

    const body = env.document.querySelector('#detail-body');
    assert.ok(body.innerHTML.includes('有标签的描述'), '详情已渲染消息块');
    assert.ok(!body.innerHTML.includes('整组操作'), '整组操作已移除');
    assert.ok(!body.innerHTML.includes('group-tag-input'), '整组输入框已移除');
    assert.match(body.innerHTML, /tag-edit is-locked/, '默认标签区为锁定态');
    assert.match(body.innerHTML, /data-action="tag-add-prompt"[^>]*disabled/, '默认「添加标签」按钮不可点');
    assert.match(body.innerHTML, /data-action="detail-pick" data-file="AQAD1"/, '媒体缩略图可点选');
});

test('媒体详情：点选有标签的媒体 → 高亮标签；点选无标签的媒体 → 高亮添加标签', async () => {
    const env = await boot();
    await goto(env, 'media');
    await act(env, { action: 'open-media', group: '-100_1' });
    const body = env.document.querySelector('#detail-body');

    // 选中 AQAD1（已有 JK 标签）
    await actDialog(env, { action: 'detail-pick', file: 'AQAD1' }, { tagName: 'DIV' });
    const block1 = body.querySelectorAll('.msg-block').find(b => b.dataset.msg === 'AQAD1');
    const block2 = body.querySelectorAll('.msg-block').find(b => b.dataset.msg === 'AQAD2');
    assert.ok(block1.classList.contains('is-active'), '选中的消息块高亮');
    assert.ok(block1.querySelector('.tag-edit').classList.contains('is-active'), '标签区解锁高亮');
    assert.strictEqual(block1.querySelector('.tag-add-btn').disabled, false, '添加标签按钮可点');
    assert.ok(!block1.querySelector('.tag-add-btn').classList.contains('is-highlight'), '已有标签时不高亮添加按钮');
    assert.ok(!block2.classList.contains('is-active'), '其他消息块保持常规');

    // 选中 AQAD2（无标签）→ 高亮「添加标签」
    await actDialog(env, { action: 'detail-pick', file: 'AQAD2' }, { tagName: 'DIV' });
    const addBtn2 = block2.querySelector('.tag-add-btn');
    assert.ok(block2.classList.contains('is-active'));
    assert.ok(addBtn2.classList.contains('is-highlight'), '没有标签时高亮「添加标签」');
    assert.strictEqual(addBtn2.disabled, false);
    assert.ok(!block1.classList.contains('is-active'), '上一个选中态被清除');

    // 再点一次同一个媒体 = 取消选中（回到灰色常规态）
    await actDialog(env, { action: 'detail-pick', file: 'AQAD2' }, { tagName: 'DIV' });
    assert.ok(!block2.classList.contains('is-active'));
    assert.strictEqual(block2.querySelector('.tag-add-btn').disabled, true);
});

// ---------------- 统计报表：每日操作量方格图（统一全年 GitHub 样式） ----------------

/** 按年推算方格总数（当年天数补齐到整周） */
function expectedCells(year) {
    const pad = (new Date(Date.UTC(year, 0, 1)).getUTCDay() + 6) % 7;
    const days = ((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000);
    return Math.ceil((pad + days) / 7) * 7;
}

function cgCells(html) {
    return [...html.matchAll(/<i class="cg-cell[^"]*"[^>]*>/g)].map(m => m[0]);
}

/** 真正代表「某一天」的格子（带日期悬停提示），其余是补齐用的空格 */
function cgDayCells(html) {
    return cgCells(html).filter(c => /title="\d{4}-\d{2}-\d{2} 周/.test(c));
}

test('统计报表：每日操作量统一为全年 GitHub 方格（当天天数 + 分级色深 + 图例）', async () => {
    const env = await boot();
    const view = await goto(env, 'stats');
    const html = view.innerHTML;
    const year = new Date().getFullYear();

    assert.match(html, /每日操作量/);
    assert.match(html, /class="cg-grid"/);
    assert.match(html, /cg-days/);
    assert.ok(env.requests.some(r => r.url.startsWith('/api/stats?')), '应请求统计报表接口');
    assert.ok(env.requests.some(r => r.url.includes('period=year') && r.url.includes(`year=${year}`)), '统一按年统计');
    assert.ok(!env.requests.some(r => r.url.includes('period=month')), '不再有月报请求');

    const cells = cgCells(html);
    const total = expectedCells(year);
    const daysInYear = ((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000);
    assert.strictEqual(cells.length, total, `全年方格数 = 当年天数补齐到整周，实际 ${cells.length}`);
    assert.strictEqual(cgDayCells(html).length, daysInYear, '每格 = 当年的一天（含没有操作的空白日）');
    assert.strictEqual(cells.filter(c => c.includes('data-empty')).length, total - daysInYear, '其余为补齐空格');
    assert.ok(cells.some(c => c.includes('lv4')), '操作量最大的一天应为最深色');
    assert.ok(cells.some(c => c.includes('lv1')), '操作量较小的一天应为浅色');
    assert.ok(cells.filter(c => !c.includes('lv') && !c.includes('data-empty')).length > 0, '没有操作的日子是底色');

    assert.match(html, /5 次操作/, '悬停提示带操作次数');
    assert.match(html, /1 个媒体/, '悬停提示带媒体数');
    assert.match(html, /class="cg-leg"/);
    assert.match(html, /<i class="lv4"><\/i>/, '图例展示最深层级');
    assert.match(html, /最高 4 次\/天/);

    // 整年列顶标注月份；不再有「最活跃的日子」侧栏（用户要求去掉）
    assert.match(html, /class="cg-months"/);
    assert.match(html, /1月/);
    assert.match(html, /12月/);
    assert.ok(!html.includes('最活跃的日子'), '右侧「最活跃的日子」已移除');
    assert.ok(!html.includes('cg-flex'), '不再用左右分栏，方格独占整条');
});

test('统计报表：顶栏右上角 ◀ ▶ 切换年份（无月报/年报页签）', async () => {
    const env = await boot();
    const html = (await goto(env, 'stats')).innerHTML;
    const year = new Date().getFullYear();

    assert.match(html, /data-action="stats-year-prev"/);
    assert.match(html, /data-action="stats-year-next"/);
    assert.match(html, new RegExp(`class="year-label">${year} 年<`));
    assert.ok(!html.includes('stats-period'), '月报/年报页签已移除');
    assert.ok(!html.includes('stats-month'), '月份选择已移除');
    assert.ok(!html.includes('stats-year"'), '年份下拉已移除（改为左右箭头）');

    // 上一年
    await act(env, { action: 'stats-year-prev' });
    assert.ok(env.requests.some(r => r.url.includes(`year=${year - 1}`)), '◀ 请求上一年');
    assert.match(env.document.querySelector('#view').innerHTML, new RegExp(`class="year-label">${year - 1} 年<`));

    // 下一年（回到今年再往后）
    await act(env, { action: 'stats-year-next' });
    await act(env, { action: 'stats-year-next' });
    assert.ok(env.requests.some(r => r.url.includes(`year=${year + 1}`)), '▶ 请求下一年');
    assert.match(env.document.querySelector('#view').innerHTML, new RegExp(`class="year-label">${year + 1} 年<`));

    // 年份边界：2000 / 2100 时按钮禁用
    const env2 = await boot();
    await goto(env2, 'stats');
    for (let i = 0; i < 40; i++) await act(env2, { action: 'stats-year-prev' });
    assert.match(env2.document.querySelector('#view').innerHTML, /data-action="stats-year-prev"[^>]*disabled/, '到 2000 年后 ◀ 禁用');
});

test('统计报表：活跃用户之后有活跃时间（24 小时全标注 + 高峰标注）', async () => {
    const env = await boot();
    const html = (await goto(env, 'stats')).innerHTML;

    assert.match(html, /活跃时间/);
    assert.match(html, /北京时间每小时操作量/);
    assert.ok(html.indexOf('活跃用户') < html.indexOf('活跃时间'), '活跃时间排在活跃用户之后');

    const cols = [...html.matchAll(/<div class="col[^"]*" title="(\d{2}):00 · (\d+) 次操作/g)];
    assert.strictEqual(cols.length, 24, '每小时一根柱');
    assert.deepStrictEqual(cols.map(c => c[1]), Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')), '00→23 顺序完整');
    assert.strictEqual(cols[9][2], '2', '09:00 的 2 次操作进入对应小时');
    assert.strictEqual(cols[21][2], '4', '21:00 的 4 次操作进入对应小时');
    // 每小时都有刻度标签（不再只标偶数小时，避免看着像 12 小时）
    const labels = [...html.matchAll(/<span class="h">(\d{2})<\/span>/g)].map(m => m[1]);
    assert.strictEqual(labels.length, 24, '24 个小时刻度');
    assert.strictEqual(labels[0], '00');
    assert.strictEqual(labels[23], '23');
    assert.match(html, /class="col is-peak"[^>]*title="21:00/, '最高峰 21:00 标绿');
    assert.match(html, /<span class="v">4<\/span>/, '峰值柱顶标出次数');
    assert.match(html, /高峰 21:00 · 4 次（占 \d+%）/);
    assert.match(html, /class="col is-zero"/, '0 次的小时用底色短桩区分');
});

// ---------------- 标签详情：直接列出该标签下的媒体 ----------------

test('标签详情：直接列出该标签下的媒体组并可点开（无需先跳媒体库）', async () => {
    const env = await boot();
    await goto(env, 'tags');
    await act(env, { action: 'tag-card-open', tag: 'AAA' });
    await tick();

    const body = env.document.querySelector('#detail-body');
    assert.ok(env.requests.some(r => r.url.includes('/api/media?') && r.url.includes('tag=AAA')), '详情里直接查询该标签下的媒体');
    assert.match(body.innerHTML, /该标签下的媒体组/);
    // 与「媒体库」一致的方块卡片（不再是 mini-row 列表）
    assert.match(body.innerHTML, /class="media-grid"/);
    assert.match(body.innerHTML, /class="media-card" data-action="tag-media-open" data-group="-100_1"/);
    assert.match(body.innerHTML, /media-thumb/);
    assert.match(body.innerHTML, /有标签的描述/);
    assert.ok(!body.innerHTML.includes('mini-row'), '不再用小行列表');

    // 页脚保留「在媒体库中筛选」（点开卡片后会被媒体详情的页脚替换）
    assert.match(env.document.querySelector('#detail-foot').innerHTML, /在媒体库中筛选/);

    // 点击卡片 → 关闭标签详情并打开该媒体组详情
    const card = body.querySelectorAll('.media-card').find(el => el.dataset.group === '-100_1');
    assert.ok(card, '媒体卡片已渲染');
    await env.document.querySelector('#detail-dialog').fire('click', {
        target: { closest: (sel) => (sel === '[data-action]' ? card : null), tagName: 'ARTICLE', dataset: {} }
    });
    await tick();
    assert.ok(env.requests.some(r => r.url.includes('/api/media/detail?groupId=-100_1')), '点开媒体卡片会加载媒体详情');
    assert.match(env.document.querySelector('#detail-body').innerHTML, /有标签的描述/);
});

// ---------------- 媒体详情：无文本记录的媒体也能补描述 + 打标签 ----------------

test('媒体详情：点选没有文本记录的媒体 → 自动出现描述编辑区与可点标签按钮', async () => {
    const env = await boot();
    await goto(env, 'media');
    await act(env, { action: 'open-media', group: '-100_3' });

    const body = env.document.querySelector('#detail-body');
    assert.match(body.innerHTML, /该组没有描述/, '初始是空态提示');
    assert.strictEqual(body.querySelectorAll('.msg-block').length, 0, '没有 message 时先不渲染编辑块');

    await actDialog(env, { action: 'detail-pick', file: 'AQAD31' }, { tagName: 'DIV' });

    const block = body.querySelectorAll('.msg-block').find(b => b.dataset.msg === 'AQAD31');
    assert.ok(block, '点选后自动补出该媒体的描述 / 标签区块');
    assert.ok(block.classList.contains('no-record'), '标记为「无文本记录」');
    assert.ok(block.classList.contains('is-active'), '选中的媒体块高亮');
    assert.ok(!block.querySelector('.msg-editor').classList.contains('hidden'), '直接进入描述编辑态');
    assert.strictEqual(block.querySelector('.tag-add-btn').disabled, false, '添加标签按钮可点');
    assert.ok(block.querySelector('.tag-add-btn').classList.contains('is-highlight'), '没有标签时高亮添加按钮');
    assert.strictEqual(block.querySelector('.tag-add-submit').dataset.file, 'AQAD31');

    // 另一个媒体还没被点选，不会凭空出现编辑块
    assert.ok(!body.querySelectorAll('.msg-block').some(b => b.dataset.msg === 'AQAD32'));
});

test('媒体详情：无文本记录媒体保存描述 → 提交 fileUniqueId 与文本', async () => {
    const env = await boot();
    await goto(env, 'media');
    await act(env, { action: 'open-media', group: '-100_3' });
    await actDialog(env, { action: 'detail-pick', file: 'AQAD31' }, { tagName: 'DIV' });

    // 展开后重新查询（applyDetailSelection 会重建区块）
    const block = env.document.querySelector('#detail-body').querySelectorAll('.msg-block').find(b => b.dataset.msg === 'AQAD31');
    assert.ok(block, '编辑区块已就绪');
    block.querySelector('.msg-input').value = '补上的新描述';
    await actDialog(env, { action: 'desc-save', file: 'AQAD31' }, { tagName: 'BUTTON' });

    const req = lastRequest(env, '/api/media/description', 'POST');
    assert.deepStrictEqual(req.body, { fileUniqueId: 'AQAD31', text: '补上的新描述' });
});

// ---------------- 媒体详情：修复「➕ 添加标签」点击无反应 ----------------

test('媒体详情：点「➕ 添加标签」展开标签选择区，可点标签或输入回车添加', async () => {
    const env = await boot();
    await goto(env, 'media');
    await act(env, { action: 'open-media', group: '-100_1' });
    await actDialog(env, { action: 'detail-pick', file: 'AQAD1' }, { tagName: 'DIV' });

    const body = env.document.querySelector('#detail-body');
    const block = body.querySelectorAll('.msg-block').find(b => b.dataset.msg === 'AQAD1');
    const picker = block.querySelector('.tag-picker');
    assert.ok(picker.classList.contains('hidden'), '默认收起标签选择区');

    // 「➕ 添加标签」后面就跟着一个「取消」（默认隐藏，展开时显示）
    assert.match(body.innerHTML, /data-action="tag-add-prompt" data-file="AQAD1"[^>]*>➕ 添加标签<\/button>\s*<button class="btn btn-ghost btn-xs tag-cancel-btn hidden" data-action="tag-cancel" data-file="AQAD1">取消<\/button>/);
    // 输入框那一行的「➕ 添加」后面也有「取消」
    assert.match(body.innerHTML, /data-action="tag-add" data-file="AQAD1">➕ 添加<\/button>\s*<button class="btn btn-sm tag-cancel-submit" data-action="tag-cancel" data-file="AQAD1">取消<\/button>/);

    const cancelBtn = block.querySelector('.tag-cancel-btn');
    const cancelSubmit = block.querySelector('.tag-cancel-submit');
    assert.ok(cancelBtn.classList.contains('hidden'), '未展开时标签行的取消按钮隐藏');

    // 点「➕ 添加标签」→ 展开（此前点击被 detail-pick 吞掉，表现为“没有反应”）
    await actDialog(env, { action: 'tag-add-prompt', file: 'AQAD1' }, { tagName: 'BUTTON' });
    assert.ok(!picker.classList.contains('hidden'), '点击后展开标签选择区');
    assert.ok(!cancelBtn.classList.contains('hidden'), '展开后标签行的取消按钮出现');
    assert.ok(!cancelSubmit.classList.contains('hidden'), '展开后输入框行的取消按钮可见');

    // 点「取消」→ 收起并清空输入，不写库
    block.querySelector('.tag-input').value = '写了一半';
    const before = env.requests.length;
    await actDialog(env, { action: 'tag-cancel', file: 'AQAD1' }, { tagName: 'BUTTON' });
    assert.ok(picker.classList.contains('hidden'), '取消后收起标签选择区');
    assert.ok(cancelBtn.classList.contains('hidden'), '取消后标签行的取消按钮隐藏');
    assert.strictEqual(block.querySelector('.tag-input').value, '', '取消会清空输入框');
    assert.strictEqual(env.requests.length, before, '取消不发起任何请求');

    // 展开后用输入框的「➕ 添加」提交（输入框有值、按钮没有 data-tag）
    await actDialog(env, { action: 'tag-add-prompt', file: 'AQAD1' }, { tagName: 'BUTTON' });
    block.querySelector('.tag-input').value = '新标签';
    await actDialog(env, { action: 'tag-add', file: 'AQAD1' }, { tagName: 'BUTTON' });
    assert.deepStrictEqual(lastRequest(env, '/api/media/tags', 'POST').body, { fileUniqueId: 'AQAD1', add: ['新标签'], remove: [] });

    // 点标签库里的推荐标签（带 data-tag）
    await actDialog(env, { action: 'tag-add', file: 'AQAD1', tag: 'BBB' }, { tagName: 'BUTTON' });
    assert.deepStrictEqual(lastRequest(env, '/api/media/tags', 'POST').body, { fileUniqueId: 'AQAD1', add: ['BBB'], remove: [] });

    // 再点一次「➕ 添加标签」本身也能收起（保留原行为）
    // 注意：上面两次添加都会重渲染详情，必须重新取节点
    const block2 = env.document.querySelector('#detail-body').querySelectorAll('.msg-block').find(b => b.dataset.msg === 'AQAD1');
    const picker2 = block2.querySelector('.tag-picker');
    await actDialog(env, { action: 'tag-add-prompt', file: 'AQAD1' }, { tagName: 'BUTTON' });
    assert.ok(!picker2.classList.contains('hidden'), '重新展开');
    await actDialog(env, { action: 'tag-add-prompt', file: 'AQAD1' }, { tagName: 'BUTTON' });
    assert.ok(picker2.classList.contains('hidden'), '再点一次收起');
});

test('媒体详情：选中后标签区解锁（is-locked 必须移除，否则 CSS pointer-events 点不动）', async () => {
    const env = await boot();
    await goto(env, 'media');
    await act(env, { action: 'open-media', group: '-100_1' });

    const body = env.document.querySelector('#detail-body');
    const block1 = body.querySelectorAll('.msg-block').find(b => b.dataset.msg === 'AQAD1');
    const block2 = body.querySelectorAll('.msg-block').find(b => b.dataset.msg === 'AQAD2');
    assert.ok(block1.querySelector('.tag-edit').classList.contains('is-locked'), '未选中时锁定');
    assert.ok(!block1.querySelector('.tag-edit').classList.contains('is-active'));

    await actDialog(env, { action: 'detail-pick', file: 'AQAD1' }, { tagName: 'DIV' });
    assert.ok(!block1.querySelector('.tag-edit').classList.contains('is-locked'), '选中后必须解锁');
    assert.ok(block1.querySelector('.tag-edit').classList.contains('is-active'));
    assert.ok(block2.querySelector('.tag-edit').classList.contains('is-locked'), '其他媒体仍锁定');

    // 每个标签都带 ✎（改名）与 ✕（移除）按钮
    assert.match(body.innerHTML, /data-action="tag-rename" data-file="AQAD1"/);
    assert.match(body.innerHTML, /data-action="tag-remove" data-file="AQAD1"/);

    // 取消选中 → 重新锁定
    await actDialog(env, { action: 'detail-pick', file: 'AQAD1' }, { tagName: 'DIV' });
    assert.ok(block1.querySelector('.tag-edit').classList.contains('is-locked'), '取消选中后重新锁定');
});

test('媒体详情：标签「✎ 改名」提交到 /api/tags/rename 并刷新详情', async () => {
    const env = await boot();
    await goto(env, 'media');
    await act(env, { action: 'open-media', group: '-100_1' });
    await actDialog(env, { action: 'detail-pick', file: 'AQAD1' }, { tagName: 'DIV' });

    await actDialog(env, { action: 'tag-rename', file: 'AQAD1', tag: 'JK' }, { tagName: 'BUTTON' });
    assert.match(env.document.querySelector('#form-title').textContent, /重命名标签「JK」/);

    // 表单里 name 字段默认填了原名，改成新名字后提交
    const form = env.document.querySelector('#form-body');
    const input = (function find(nodes) {
        for (const n of nodes) {
            if (n.dataset && n.dataset.field === 'name') return n;
            const deep = find(n.children || []);
            if (deep) return deep;
        }
        return null;
    })(form.children);
    assert.ok(input, '表单应有 name 字段');
    assert.strictEqual(input.value, 'JK', '默认填入原标签名');
    input.value = 'JK2';
    await env.document.querySelector('#form-ok').fire('click');
    await tick();

    assert.deepStrictEqual(lastRequest(env, '/api/tags/rename', 'POST').body, { name: 'JK', to: 'JK2' });
});

test('媒体详情：只有一个媒体的组自动选中，标签区直接可点', async () => {
    const env = await boot();
    await goto(env, 'media');
    await act(env, { action: 'open-media', group: '-100_4' });

    const body = env.document.querySelector('#detail-body');
    const block = body.querySelectorAll('.msg-block').find(b => b.dataset.msg === 'AQAD41');
    assert.ok(block.classList.contains('is-active'), '唯一的媒体自动选中');
    assert.ok(!block.querySelector('.tag-edit').classList.contains('is-locked'), '标签区解锁');
    assert.strictEqual(block.querySelector('.tag-add-btn').disabled, false, '添加标签按钮可点');

    // 直接就能移除已有标签
    await actDialog(env, { action: 'tag-remove', file: 'AQAD41', tag: 'JK' }, { tagName: 'BUTTON' });
    assert.deepStrictEqual(lastRequest(env, '/api/media/tags', 'POST').body, { fileUniqueId: 'AQAD41', add: [], remove: ['JK'] });
});

test('媒体详情：点标签行的按钮不会取消媒体选中态（点击不再被吞）', async () => {
    const env = await boot();
    await goto(env, 'media');
    await act(env, { action: 'open-media', group: '-100_1' });
    await actDialog(env, { action: 'detail-pick', file: 'AQAD1' }, { tagName: 'DIV' });

    const body = env.document.querySelector('#detail-body');
    const block = body.querySelectorAll('.msg-block').find(b => b.dataset.msg === 'AQAD1');
    assert.ok(block.classList.contains('is-active'), '先选中');

    // 按钮类目标：detail-pick 提前 break，不会走到「再次点击取消选中」
    await env.document.querySelector('#detail-dialog').fire('click', {
        target: {
            closest: (sel) => (sel === '[data-action]'
                ? { dataset: { action: 'detail-pick', file: 'AQAD1' }, tagName: 'BUTTON' }
                : null),
            tagName: 'BUTTON',
            dataset: {}
        }
    });
    await tick();
    assert.ok(block.classList.contains('is-active'), '点按钮不会取消选中');
});

// ---------------- 标签视图：增删 / 详情置顶 / 拖拽排序 ----------------

test('标签视图：顶栏三个按钮 + 卡片点击进入详情', async () => {
    const env = await boot();
    const view = await goto(env, 'tags');
    assert.match(view.innerHTML, /data-action="tag-create"/);
    assert.match(view.innerHTML, /data-action="tag-mode" data-mode="delete"/);
    assert.match(view.innerHTML, /data-action="tag-mode" data-mode="sort"/);
    assert.match(view.innerHTML, /置顶 1/, '卡片显示置顶位置');

    await act(env, { action: 'tag-card-open', tag: 'AAA' });
    const body = env.document.querySelector('#detail-body');
    assert.match(body.innerHTML, /已置顶（位置 1）/, '详情顶栏显示置顶状态');
    assert.match(body.innerHTML, /tag-detail-pin/);
    assert.ok(env.document.querySelector('#detail-dialog').open, '详情对话框已打开');
});

test('标签详情：点击顶栏置顶状态可切换（置顶取下一个空位 / 取消置顶）', async () => {
    const env = await boot();
    await goto(env, 'tags');
    await act(env, { action: 'tag-card-open', tag: 'BBB' });
    await actDialog(env, { action: 'tag-detail-pin', tag: 'BBB' });
    const pinReq = lastRequest(env, '/api/tags/pin', 'POST');
    assert.deepStrictEqual(pinReq.body, { name: 'BBB', pin: 2 }, '未置顶的标签取下一个空位（已有 pin=1）');

    await actDialog(env, { action: 'tag-detail-pin', tag: 'AAA' });
    assert.deepStrictEqual(lastRequest(env, '/api/tags/pin', 'POST').body, { name: 'AAA', pin: 0 }, '已置顶的标签点一下取消置顶');
});

test('标签视图：添加 / 删除标签', async () => {
    const env = await boot();
    await goto(env, 'tags');

    // 添加：表单填名 → 提交
    await act(env, { action: 'tag-create' });
    const form = env.document.querySelector('#form-body');
    assert.match(form.innerHTML, /标签名/);
    const nameInput = (function find(nodes) {
        for (const n of nodes) {
            if (n.dataset && n.dataset.field === 'name') return n;
            const deep = find(n.children || []);
            if (deep) return deep;
        }
        return null;
    })(form.children);
    assert.ok(nameInput, '表单里应有 name 字段');
    nameInput.value = ' 新标签 ';
    await env.document.querySelector('#form-ok').fire('click');
    await tick();
    // 前端提交前会 trim
    assert.deepStrictEqual(lastRequest(env, '/api/tags/create', 'POST').body, { name: '新标签' });

    // 删除：进入删除模式后点卡片 → 二次确认 → 提交
    await act(env, { action: 'tag-mode', mode: 'delete' });
    assert.ok(env.document.querySelector('#view').innerHTML.includes('is-deleting'), '删除模式卡片高亮');
    await actNoWait(env, { action: 'tag-delete', tag: 'CCC' }); // 处理函数会等待确认框
    await env.document.querySelector('#confirm-ok').fire('click');
    await tick();
    assert.deepStrictEqual(lastRequest(env, '/api/tags/delete', 'POST').body, { name: 'CCC', confirm: true });
});

test('标签视图：置顶排序为拖拽模式，保存时按 DOM 顺序提交', async () => {
    const env = await boot();
    const view = await goto(env, 'tags');
    await act(env, { action: 'tag-mode', mode: 'sort' });
    const cards = view.querySelectorAll('.tag-card');
    assert.strictEqual(cards.length, 3, '排序模式显示全部标签');
    assert.match(view.innerHTML, /draggable="true"/);
    assert.match(view.innerHTML, /保存排序/);

    // 模拟拖拽：把第 3 张卡片插到最前
    cards[0].parentElement.insertBefore(cards[2], cards[0]);
    await act(env, { action: 'tag-sort-save' });
    const reorder = lastRequest(env, '/api/tags/reorder', 'POST');
    assert.deepStrictEqual(reorder.body, { names: ['CCC', 'AAA', 'BBB'] });
});

test('未知视图不渲染（导航守卫）', async () => {
    const env = await boot();
    const before = env.document.querySelector('#view').innerHTML;
    const nav = env.document.querySelector('#nav');
    await nav.fire('click', { target: { closest: () => ({ dataset: { view: 'nope' } }) } });
    await tick();
    assert.strictEqual(env.document.querySelector('#view').innerHTML, before);
});
