/* =============================================================================
   Telegram 媒体机器人 · Web 控制台 前端
   结构：常量/状态 → 基础设施（请求、格式化、Toast、对话框、表单）→ 视图渲染 → 事件绑定
   所有视图以 HTML 字符串渲染，事件统一走容器上的 [data-action] 委托。
   ============================================================================= */
(function () {
  'use strict';

  const TOKEN_KEY = 'webui_token';
  const THEME_KEY = 'webui_theme';
  const API = '/api';
  const ALL_KEY = '__all__';                        // 原始数据：跨集合浏览
  const SEARCH_VIEWS = ['media', 'users', 'tags'];  // 支持顶部搜索的视图
  const THEME_MODES = ['auto', 'light', 'dark'];

  // 与 db/log.js 的 LOG_TYPES 对应（历史数据没有 action 时的兜底显示）
  const LOG_TYPE_NAMES = {
    0: '启动', 1: '收录', 2: '编辑', 3: '删除', 11: '随机视频', 12: '随机图片',
    13: '消息回复', 14: '媒体合并', 15: '媒体遮罩', 16: '帮助', 17: '查找',
    18: '清理', 19: '删除模式', 20: '标记', 21: '媒体去遮罩', 22: '关键字查询',
    23: '修改', 24: '设置更新', 25: '发送', 26: '标签操作'
  };

  const TYPE_META = {
    photo: { icon: '🖼', label: '图片' },
    video: { icon: '🎬', label: '视频' },
    audio: { icon: '🎵', label: '音频' },
    document: { icon: '📄', label: '文件' }
  };

  const $ = (sel) => document.querySelector(sel);

  const state = {
    view: 'overview',
    search: '',
    autoRefresh: false,
    timer: null,
    collections: [],
    overview: null,
    media: { scope: 'all', q: '', tag: '', page: 1, pageSize: 24, total: 0, totalPages: 1, items: [] },
    users: { scope: 'all', q: '', page: 1, pageSize: 20, total: 0, totalPages: 1, items: [] },
    raw: { collection: ALL_KEY, sort: -1, page: 1, pageSize: 20, total: 0, totalPages: 1, items: [] },
    clean: { previews: null, items: [] },
    tags: [],
    chats: [],
    stats: { period: 'month', year: new Date().getFullYear(), month: new Date().getMonth() + 1, data: null },
    oplogs: { page: 1, pageSize: 30, total: 0, totalPages: 1, items: [], category: 'all', result: 'all', q: '' },
    selectedRaw: null,
    detail: null,
    logPaused: false, logFilter: 'all', logBuffer: [], loading: false
  };

  /* ============================ 基础设施 ============================ */

  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 3600);
  }

  function token() { return localStorage.getItem(TOKEN_KEY) || ''; }

  async function request(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token()) headers.Authorization = `Bearer ${token()}`;
    const res = await fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 401) { logout(); throw new Error('会话已过期，请重新登录'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  }
  const apiGet = (path) => request(path);
  const apiPost = (path, body) => request(path, { method: 'POST', body });

  /** 缩略图地址：<img> 无法带 header，因此用 query 传 token（与日志流一致） */
  function thumbUrl(fileUniqueId) {
    return `${API}/thumb?fileUniqueId=${encodeURIComponent(fileUniqueId)}&token=${encodeURIComponent(token())}`;
  }

  /* ---------------- 主题（跟随系统 / 浅色 / 深色） ---------------- */

  const prefersLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function themeMode() {
    const saved = localStorage.getItem(THEME_KEY);
    return THEME_MODES.includes(saved) ? saved : 'auto';
  }

  function applyTheme(mode) {
    const next = THEME_MODES.includes(mode) ? mode : 'auto';
    localStorage.setItem(THEME_KEY, next);
    const html = document.documentElement;
    // auto：不写 data-theme，交给 CSS 的 prefers-color-scheme 媒体查询（首屏也无闪烁）
    if (next === 'auto') html.removeAttribute('data-theme');
    else html.dataset.theme = next;
    const btn = $('#theme-btn');
    if (btn) btn.textContent = { auto: '🌗 跟随系统', light: '☀️ 浅色', dark: '🌙 深色' }[next];
  }

  function cycleTheme() {
    const current = themeMode();
    const next = THEME_MODES[(THEME_MODES.indexOf(current) + 1) % THEME_MODES.length];
    applyTheme(next);
    toast(next === 'auto' ? '主题：跟随系统设置' : (next === 'light' ? '主题：浅色' : '主题：深色'));
  }

  if (prefersLight && prefersLight.addEventListener) {
    prefersLight.addEventListener('change', () => {
      if (themeMode() === 'auto') toast(`已跟随系统：${prefersLight.matches ? '浅色' : '深色'}主题`);
    });
  }

  /* ---------------- 格式化 ---------------- */

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtAgo(ms) {
    if (!ms) return '—';
    const diff = Date.now() - ms;
    if (diff < 0) return '刚刚';
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo} 个月前`;
    return `${Math.floor(mo / 12)} 年前`;
  }
  function fmtNum(n) { return (n === null || n === undefined) ? '—' : Number(n).toLocaleString('zh-CN'); }
  function shortId(id, len = 22) {
    const s = String(id ?? '');
    return s.length > len ? s.slice(0, len) + '…' : s;
  }
  function typeIcon(t) { return (TYPE_META[t] || { icon: '📎' }).icon; }
  function typeLabel(t) { return (TYPE_META[t] || { label: t || '未知' }).label; }
  function fmtDuration(sec) {
    const s = Number(sec) || 0;
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }
  /** -1001234567890 → 1234567890（t.me/c/ 链接用的 chat id） */
  function toLinkChatId(chatId) {
    const s = String(chatId ?? '');
    if (s.startsWith('-100')) return s.slice(4);
    if (s.startsWith('-')) return s.slice(1);
    return s;
  }
  function telegramLink(detail) {
    const media = (detail && detail.media) || [];
    const first = media[0] || {};
    const pos = first.group || first.channel || null;
    let chatId = pos && pos.chat_id;
    let messageId = (pos && pos.message_id) || first.message_id;
    if (!chatId) {
      const gid = (detail.group && detail.group.group_id) || '';
      chatId = String(gid).split('_')[0];
    }
    if (!chatId || !messageId || String(chatId) === 'undefined') return null;
    return `https://t.me/c/${toLinkChatId(chatId)}/${messageId}`;
  }

  /* ---------------- 确认对话框 ---------------- */

  function confirmDialog({ title, body, okText = '确认删除', danger = true }) {
    return new Promise((resolve) => {
      const dlg = $('#confirm-dialog');
      $('#confirm-title').textContent = title;
      $('#confirm-body').innerHTML = body;
      const ok = $('#confirm-ok');
      ok.textContent = okText;
      ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      const onClose = () => { cleanup(); resolve(false); };
      function cleanup() {
        ok.removeEventListener('click', onOk);
        $('#confirm-cancel').removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
      }
      ok.addEventListener('click', onOk);
      $('#confirm-cancel').addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
    });
  }

  /* ---------------- 通用表单对话框 ---------------- */

  let formSubmit = null;

  /**
   * 打开表单对话框
   * @param {Object} cfg - { title, okText, fields: [{key,label,type,value,options,required,readonly,placeholder,hint}], onSubmit(values) }
   */
  function openForm(cfg) {
    const dlg = $('#form-dialog');
    $('#form-title').textContent = cfg.title || '编辑';
    $('#form-ok').textContent = cfg.okText || '保存';
    $('#form-body').innerHTML = (cfg.fields || []).map(f => {
      const id = `f-${f.key}`;
      let control;
      if (f.type === 'select') {
        control = `<select id="${id}" data-field="${esc(f.key)}">${(f.options || []).map(o =>
          `<option value="${esc(o.v)}" ${String(o.v) === String(f.value) ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select>`;
      } else {
        control = `<input id="${id}" data-field="${esc(f.key)}" type="${f.type === 'number' ? 'number' : 'text'}"
          value="${esc(f.value === undefined || f.value === null ? '' : f.value)}"
          placeholder="${esc(f.placeholder || '')}" ${f.readonly ? 'readonly' : ''}>`;
      }
      return `<div class="field" style="margin-bottom:12px">
        <label style="display:block;font-size:12px;color:var(--text-3);margin-bottom:5px">${esc(f.label)}${f.required ? ' *' : ''}</label>
        ${control}
        ${f.hint ? `<div class="dim" style="font-size:11px;margin-top:4px">${esc(f.hint)}</div>` : ''}
      </div>`;
    }).join('');
    formSubmit = cfg.onSubmit;
    if (!dlg.open) dlg.showModal();
    const first = $('#form-body input:not([readonly]), #form-body select');
    if (first) first.focus();
  }

  async function submitForm() {
    if (!formSubmit) { $('#form-dialog').close(); return; }
    const values = {};
    document.querySelectorAll('#form-body [data-field]').forEach(el => { values[el.dataset.field] = el.value; });
    try {
      await formSubmit(values);
      $('#form-dialog').close();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ============================ 数据加载 ============================ */

  function setBadge(sel, n) {
    const el = $(sel);
    if (!el) return;
    el.textContent = (n === undefined || n === null) ? '' : fmtNum(n);
  }

  async function loadOverview() {
    const data = await apiGet('/overview');
    state.overview = data;
    const c = data.counts || {};
    setBadge('#nav-count-media', c.media);
    setBadge('#nav-count-clean', c.cleanable);
    setBadge('#nav-count-tags', c.tags);
    setBadge('#nav-count-users', c.users);
    return data;
  }

  async function loadMedia() {
    const m = state.media;
    const params = new URLSearchParams({ scope: m.scope, page: String(m.page), pageSize: String(m.pageSize) });
    if (m.q) params.set('q', m.q);
    if (m.tag) params.set('tag', m.tag);
    const data = await apiGet('/media?' + params.toString());
    m.items = data.items || [];
    m.total = data.total || 0;
    m.page = data.page || 1;
    m.totalPages = Math.max(1, Math.ceil(m.total / (data.pageSize || m.pageSize)));
    return data;
  }

  async function loadUsers() {
    const u = state.users;
    const params = new URLSearchParams({ scope: u.scope, page: String(u.page), pageSize: String(u.pageSize) });
    if (u.q) params.set('q', u.q);
    const data = await apiGet('/users?' + params.toString());
    u.items = data.items || [];
    u.total = data.total || 0;
    u.page = data.page || 1;
    u.totalPages = Math.max(1, Math.ceil(u.total / (data.pageSize || u.pageSize)));
    return data;
  }

  async function loadRaw() {
    const r = state.raw;
    const data = await apiPost('/db/query', {
      collection: r.collection,
      filter: {},
      sort: { _id: r.sort },
      page: r.page,
      pageSize: r.pageSize
    });
    if (data.all) {
      r.groups = data.groups || [];
      r.items = [];
      r.total = 0;
      r.totalPages = 1;
      return data;
    }
    r.items = data.items || [];
    r.total = data.total || 0;
    r.page = data.page || 1;
    r.totalPages = Math.max(1, Math.ceil(r.total / (data.pageSize || r.pageSize)));
    return data;
  }

  async function loadClean() {
    const scopes = ['week', 'month', 'all'];
    const results = await Promise.all(scopes.map(async (scope) => {
      try {
        const d = await apiPost('/clean', { scope });
        return { scope, groups: d.groups || 0, media: d.media || 0 };
      } catch (err) {
        return { scope, groups: 0, media: 0, error: err.message };
      }
    }));
    const list = await apiGet('/media?scope=cleanable&pageSize=60');
    state.clean.previews = results;
    state.clean.items = list.items || [];
    return results;
  }

  async function loadStats() {
    const s = state.stats;
    const params = new URLSearchParams({ period: s.period, year: String(s.year) });
    if (s.period === 'month') params.set('month', String(s.month));
    const [report] = await Promise.all([apiGet('/stats?' + params.toString()), loadOpLogs()]);
    s.data = report;
    return report;
  }

  async function loadOpLogs() {
    const o = state.oplogs;
    const params = new URLSearchParams({ page: String(o.page), pageSize: String(o.pageSize) });
    if (o.category && o.category !== 'all') params.set('category', o.category);
    if (o.result && o.result !== 'all') params.set('result', o.result);
    if (o.q) params.set('q', o.q);
    const data = await apiGet('/oplogs?' + params.toString());
    o.items = data.items || [];
    o.total = data.total || 0;
    o.page = data.page || 1;
    o.totalPages = Math.max(1, Math.ceil(o.total / (data.pageSize || o.pageSize)));
    if (data.catalog) state.logCatalog = data.catalog;
    return data;
  }

  /* ============================ 视图：概览 ============================ */

  function statCard(k, v, s, cls = '') {
    return `<div class="stat ${cls}">
      <div class="k">${k}</div>
      <div class="v">${fmtNum(v)}</div>
      ${s ? `<div class="s">${esc(s)}</div>` : ''}
    </div>`;
  }

  function renderOverview() {
    const o = state.overview || {};
    const c = o.counts || {};
    const byType = o.mediaByType || {};
    const typeTotal = Object.values(byType).reduce((a, b) => a + b, 0) || 1;
    const typeOrder = ['photo', 'video', 'audio', 'document'];

    const stats = [
      statCard('🖼 媒体总数', c.media, `共 ${fmtNum(c.groupList)} 个媒体组`),
      statCard('📝 有描述', c.kept, `占 ${c.groupList ? Math.round((c.kept / c.groupList) * 100) : 0}%`),
      statCard('🧹 可清理组', c.cleanable, '空描述 · 可被 /clean 清理', 'is-warn'),
      statCard('👥 用户', c.users, `白名单 ${fmtNum(c.whitelist)} · 封禁 ${fmtNum(c.banned)}`),
      statCard('🏷 标签', c.tags, '独立标签库'),
      statCard('📢 群组 / 频道', c.chats, `绑定对 ${fmtNum(c.bound)}`),
      statCard('📊 操作日志', c.logs, '累计记录')
    ].join('');

    const typeBars = typeOrder.map(t => {
      const n = byType[t] || 0;
      return `<div class="bar-row">
        <span class="muted-2">${typeIcon(t)} ${typeLabel(t)}</span>
        <span class="bar"><i style="width:${Math.round((n / typeTotal) * 100)}%"></i></span>
        <span class="n">${fmtNum(n)}</span>
      </div>`;
    }).join('');

    const recent = (o.recent || []).map(r => {
      const label = r.actionLabel || LOG_TYPE_NAMES[r.type] || '操作';
      const fail = r.result === 'fail' ? ' danger' : '';
      return `<div class="mini-row">
        <span class="tag${fail}">${esc(label)}</span>
        <span class="t">${esc(r.query || (r.userId ? `用户 ${r.userId}` : '—'))}</span>
        <span class="time">${fmtAgo(r.time)}</span>
      </div>`;
    }).join('') || '<div class="empty">暂无操作记录</div>';

    const latest = (o.latestGroupList || []).map(g => `
      <div class="mini-row" style="cursor:pointer" data-action="open-media" data-group="${esc(g.group_id)}">
        <span class="tag ${g.is_delete > 0 ? 'warn' : 'ok'}">${g.is_delete > 0 ? '可清理' : '保留'}</span>
        <span class="t mono">${esc(shortId(g.group_id, 30))}</span>
        <span class="time">${fmtNum(g.is_group)} 个媒体</span>
      </div>`).join('') || '<div class="empty">暂无媒体组</div>';

    $('#view').innerHTML = `
      <div class="stats">${stats}</div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>媒体类型分布</h3><span class="dim">共 ${fmtNum(c.media)} 个媒体</span></div>
          <div class="bars">${typeBars}</div>
          <div class="callout" style="margin-top:16px">
            <span>💡</span>
            <div><b>状态语义：</b>组内没有任何描述时，<code>group_list.is_delete</code> 记为时间戳（可被清理）；
            之后补上或修改描述会自动变为 <code>0</code>（保留）。清理规则见「清理中心」。</div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>最近操作</h3><span class="dim">实时写入 log 集合</span></div>
          <div class="mini-list">${recent}</div>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>最新媒体组</h3><span class="dim">点击查看详情</span></div>
          <div class="mini-list">${latest}</div>
        </div>
        <div class="card">
          <div class="card-head"><h3>快捷入口</h3></div>
          <div class="chips">
            <button class="chip" data-action="goto" data-view="media">🖼 浏览媒体库</button>
            <button class="chip" data-action="goto" data-view="clean">🧹 清理空描述组</button>
            <button class="chip" data-action="goto" data-view="tags">🏷 管理标签</button>
            <button class="chip" data-action="goto" data-view="users">👥 用户与封禁</button>
            <button class="chip" data-action="goto" data-view="stats">📈 统计报表</button>
            <button class="chip" data-action="palette">🧠 AI 翻译</button>
          </div>
        </div>
      </div>`;
  }

  /* ============================ 视图：媒体库 ============================ */

  function mediaCard(item) {
    const p = item.preview;
    const thumb = p && p.thumbable
      ? `<img loading="lazy" decoding="async" src="${thumbUrl(p.file_unique_id)}" alt="">`
      : `<span class="ph">${typeIcon(p ? p.media_type : null)}</span>`;
    const typeTags = (item.types || []).map(t => `<span class="tag">${typeIcon(t)} ${typeLabel(t)}</span>`).join('');
    const loc = [
      item.group ? '👥 群组' : null,
      item.channel ? '📢 频道' : null
    ].filter(Boolean).join(' · ') || '—';
    const text = item.text
      ? esc(item.text.length > 90 ? item.text.slice(0, 90) + '…' : item.text)
      : '空描述（可清理）';
    const tags = (item.tags || []).slice(0, 4).map(t => `<span class="tag-pill">${esc(t)}</span>`).join('');
    const moreTags = (item.tags || []).length > 4 ? `<span class="tag-pill">+${item.tags.length - 4}</span>` : '';

    return `<article class="media-card" data-action="open-media" data-group="${esc(item.group_id)}">
      <div class="media-thumb">
        ${thumb}
        <div class="badges">
          <span class="tag ${item.cleanable ? 'warn' : 'ok'}">${item.cleanable ? '可清理' : '保留'}</span>
          ${typeTags}
        </div>
      </div>
      <div class="media-body">
        <div class="media-text ${item.text ? '' : 'is-empty'}">${text}</div>
        <div class="tags-line">${tags}${moreTags}</div>
        <div class="media-meta">
          <span>${fmtNum(item.mediaCount)} 个媒体</span>
          <span>·</span>
          <span>${fmtNum(item.subgroups)} 组</span>
          <span>·</span>
          <span>${loc}</span>
          <span class="spacer"></span>
          <span class="mono">${esc(shortId(item.group_id, 14))}</span>
        </div>
      </div>
    </article>`;
  }

  function renderMedia() {
    const m = state.media;
    const chips = [
      ['all', '全部'],
      ['kept', '有描述'],
      ['cleanable', '🟠 可清理']
    ].map(([v, label]) => `<button class="chip ${m.scope === v ? 'is-active' : ''}" data-action="media-scope" data-scope="${v}">${label}</button>`).join('');

    const tagChip = m.tag
      ? `<button class="chip tag-filter-chip" data-action="clear-tag" title="点击清除标签筛选">🏷 ${esc(m.tag)} ✕</button>`
      : '';

    const body = m.items.length
      ? `<div class="media-grid">${m.items.map(mediaCard).join('')}</div>`
      : `<div class="empty"><div class="empty-ico">🗂</div><div>没有符合条件的媒体组${m.q ? `（搜索：${esc(m.q)}）` : ''}${m.tag ? `（标签：${esc(m.tag)}）` : ''}</div></div>`;

    $('#view').innerHTML = `
      <div class="toolbar">
        <div class="chips">${chips}${tagChip}</div>
        <span class="dim">共 ${fmtNum(m.total)} 组</span>
        <span class="grow"></span>
        <label class="switch">每组显示
          <select id="media-pagesize" style="width:auto">
            ${[12, 24, 48, 100].map(n => `<option value="${n}" ${m.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
        </label>
      </div>
      ${body}
      ${paginationHtml(m, 'media-page')}`;
    updatePageSub(`共 ${fmtNum(m.total)} 个媒体组${m.q ? ` · 搜索“${m.q}”` : ''}${m.tag ? ` · 标签 ${m.tag}` : ''}`);
  }

  /* ============================ 视图：清理中心 ============================ */

  function renderClean() {
    const previews = state.clean.previews || [];
    const byScope = Object.fromEntries(previews.map(p => [p.scope, p]));
    const items = state.clean.items || [];
    const now = Date.now();
    const CARD = [
      ['week', '一周之前', '🧹', 'is_delete 早于 7 天'],
      ['month', '一个月之前', '🧹', 'is_delete 早于 30 天'],
      ['all', '全部空数据', '🔥', '所有可清理组']
    ];

    const cards = CARD.map(([scope, title, icon, desc]) => {
      const p = byScope[scope] || { groups: 0, media: 0 };
      return `<div class="clean-card">
        <h3>${icon} ${title}</h3>
        <div class="clean-nums">
          <div><span class="n">${fmtNum(p.groups)}</span><span class="l">媒体组</span></div>
          <div><span class="n">${fmtNum(p.media)}</span><span class="l">媒体文件</span></div>
        </div>
        <div class="dim" style="font-size:11.5px">${desc}</div>
        <button class="btn ${scope === 'all' ? 'btn-danger' : 'btn-soft-danger'} btn-sm"
                data-action="clean-run" data-scope="${scope}" ${p.groups ? '' : 'disabled'}>
          执行清理
        </button>
      </div>`;
    }).join('');

    const rows = items.map(it => {
      const age = it.is_delete > 0 ? fmtAgo(it.is_delete) : '—';
      const bucket = it.is_delete > 0 && it.is_delete <= now - 30 * 864e5 ? '一个月前'
        : (it.is_delete > 0 && it.is_delete <= now - 7 * 864e5 ? '一周前' : '一周内');
      return `<div class="mini-row" style="cursor:pointer" data-action="open-media" data-group="${esc(it.group_id)}">
        <span class="tag warn">${bucket}</span>
        <span class="t">${it.text ? esc(it.text.slice(0, 60)) : '空描述'}</span>
        <span class="time">${fmtNum(it.mediaCount)} 个 · ${age}</span>
      </div>`;
    }).join('') || '<div class="empty">当前没有可清理的媒体组</div>';

    $('#view').innerHTML = `
      <div class="callout">
        <span>🧹</span>
        <div>
          <b>清理规则</b>：机器人收录/发送/回复媒体时，若该媒体组<b>没有任何描述</b>，会把
          <code>group_list.is_delete</code> 记为时间戳（表示可清理）；一旦补上或修改描述，
          该字段自动变回 <code>0</code>（保留）。此处按时间戳清理对应的 <code>media</code> 与
          <code>group_list</code> 记录，<b>不会删除 Telegram 里的消息本身</b>。
        </div>
      </div>
      <div class="clean-grid">${cards}</div>
      <div class="card">
        <div class="card-head"><h3>待清理预览</h3><span class="dim">最近 ${fmtNum(items.length)} 组（按时间戳由新到旧）</span></div>
        <div class="mini-list">${rows}</div>
      </div>`;
  }

  /* ============================ 视图：标签 ============================ */

  function renderTags() {
    const q = state.search.trim().toLowerCase();
    const tags = state.tags.filter(t => !q || t.name.toLowerCase().includes(q));
    const maxUse = Math.max(1, ...state.tags.map(t => t.usage || 0));
    const cards = tags.map(t => `
      <div class="tag-card" data-action="tag-media" data-tag="${esc(t.name)}"
           title="点击查看该标签下的所有媒体组">
        <div class="top">
          <span class="name" title="${esc(t.name)}">${esc(t.name)}</span>
          ${t.pin > 0 ? `<span class="tag accent">置顶 ${t.pin}</span>` : ''}
        </div>
        <div class="bar"><i style="width:${Math.round(((t.usage || 0) / maxUse) * 100)}%"></i></div>
        <div class="stat-row">
          <span>使用 <span class="mono">${fmtNum(t.usage)}</span> 次</span>
          <span>计数 <span class="mono">${fmtNum(t.count)}</span></span>
        </div>
      </div>`).join('');

    $('#view').innerHTML = `
      <div class="toolbar">
        <span class="dim">独立标签库 <code>tags</code>；标签本身存在每条 <code>message.tags</code> 中，<b>点击标签查看它下面的所有媒体组</b></span>
        <span class="grow"></span>
        <span class="dim">共 ${fmtNum(state.tags.length)} 个标签${q ? ` · 过滤出 ${fmtNum(tags.length)} 个` : ''}</span>
      </div>
      ${tags.length ? `<div class="tag-grid">${cards}</div>` : '<div class="empty"><div class="empty-ico">🏷</div><div>没有标签</div></div>'}`;
    updatePageSub(`共 ${fmtNum(state.tags.length)} 个标签`);
  }

  /* ============================ 视图：用户 ============================ */

  function renderUsers() {
    const u = state.users;
    const chips = [['all', '全部'], ['white', '白名单'], ['banned', '已封禁']]
      .map(([v, label]) => `<button class="chip ${u.scope === v ? 'is-active' : ''}" data-action="user-scope" data-scope="${v}">${label}</button>`).join('');

    const rows = u.items.map(it => {
      const initial = (it.name || '?').trim().charAt(0) || '?';
      const stateTag = it.state === 0 ? '<span class="tag danger">已封禁</span>' : '<span class="tag ok">正常</span>';
      const whiteTag = it.white === 1 ? '<span class="tag accent">白名单</span>' : '<span class="tag">普通</span>';
      return `<tr>
        <td><div class="user-name"><span class="avatar">${esc(initial)}</span><span>${esc(it.name || '未命名')}</span></div></td>
        <td class="num">${esc(it.id)}</td>
        <td>${stateTag} ${whiteTag}</td>
        <td class="num">${fmtNum(it.groups)}</td>
        <td class="num">${fmtTime(it.last_seen)}</td>
        <td class="right">
          <button class="btn btn-ghost btn-xs" data-action="user-edit" data-id="${esc(it.id)}">✏️</button>
          <button class="btn btn-ghost btn-xs" data-action="user-delete" data-id="${esc(it.id)}" data-name="${esc(it.name || '')}">🗑</button>
        </td>
      </tr>`;
    }).join('');

    $('#view').innerHTML = `
      <div class="toolbar">
        <div class="chips">${chips}</div>
        <button class="btn btn-sm" data-action="user-create">➕ 新增用户</button>
        <span class="dim">共 ${fmtNum(u.total)} 位用户</span>
        <span class="grow"></span>
        <label class="switch">每页
          <select id="users-pagesize" style="width:auto">
            ${[20, 50, 100].map(n => `<option value="${n}" ${u.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>用户</th><th>ID</th><th>状态</th><th>所在群组</th><th>最近活跃</th><th class="right">操作</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6"><div class="empty">没有符合条件的用户</div></td></tr>'}</tbody>
        </table>
      </div>
      ${paginationHtml(u, 'users-page')}`;
    updatePageSub(`共 ${fmtNum(u.total)} 位用户`);
  }

  function userForm(user) {
    const existing = !!user;
    openForm({
      title: existing ? `编辑用户 ${user.id}` : '新增用户',
      okText: existing ? '保存修改' : '创建用户',
      fields: [
        { key: 'id', label: '用户 ID', type: 'number', value: existing ? user.id : '', required: true, readonly: existing, hint: existing ? 'ID 作为唯一键，不可修改' : 'Telegram 用户数字 ID' },
        { key: 'name', label: '名称', value: existing ? user.name : '' },
        { key: 'state', label: '状态', type: 'select', value: existing ? user.state : 1, options: [{ v: 1, l: '正常' }, { v: 0, l: '已封禁' }] },
        { key: 'white', label: '白名单', type: 'select', value: existing ? user.white : 0, options: [{ v: 0, l: '普通' }, { v: 1, l: '白名单' }] },
        { key: 'groupText', label: '所在群组 ID', value: existing ? (user.group || []).join(', ') : '', hint: '多个用逗号分隔；留空表示不记录' }
      ],
      onSubmit: async (v) => {
        const group = String(v.groupText || '').split(/[,，\s]+/).map(s => Number(s.trim())).filter(n => Number.isFinite(n));
        if (existing) {
          await apiPost('/users/update', {
            id: Number(user.id),
            patch: { name: v.name, state: Number(v.state), white: Number(v.white), group }
          });
          toast('✅ 用户已更新');
        } else {
          await apiPost('/users/create', {
            id: Number(v.id), name: v.name, state: Number(v.state), white: Number(v.white), group
          });
          toast('✅ 用户已创建');
        }
        await loadOverview().catch(() => { });
        await show('users');
      }
    });
  }

  /* ============================ 视图：群组 / 频道 ============================ */

  function renderChats() {
    const items = state.chats || [];
    const cards = items.map(c => {
      const isChannel = c.type === 'channel';
      const bindName = c.bind_id ? (c.bindName || `Chat${c.bind_id}`) : null;
      return `<div class="chat-card">
        <div class="top">
          <span class="ico">${isChannel ? '📢' : '👥'}</span>
          <span class="name">${esc(c.name || '未命名')}</span>
          <span class="spacer"></span>
          <span class="tag">${isChannel ? '频道' : '群组'}</span>
        </div>
        <div class="kv">
          <span class="k">chat_id</span><span class="v mono">${esc(c.id)}</span>
          <span class="k">绑定</span>
          <span class="v">${c.bind_id ? `${isChannel ? '👥' : '📢'} ${esc(bindName)} <span class="mono dim">(${esc(c.bind_id)})</span>` : '<span class="dim">未绑定</span>'}</span>
        </div>
        <div class="editor-row">
          <button class="btn btn-ghost btn-xs" data-action="chat-edit" data-id="${esc(c.id)}">✏️ 编辑</button>
          <button class="btn btn-ghost btn-xs" data-action="chat-delete" data-id="${esc(c.id)}" data-name="${esc(c.name || '')}">🗑 删除</button>
          <span class="spacer"></span>
          <span class="dim" style="font-size:11px">绑定为双向</span>
        </div>
      </div>`;
    }).join('');
    $('#view').innerHTML = `
      <div class="toolbar">
        <button class="btn btn-sm" data-action="chat-create">➕ 新增聊天</button>
        <span class="dim">共 ${fmtNum(items.length)} 个聊天 · 绑定关系双向写入（频道 ↔ 群组）</span>
      </div>
      ${items.length
        ? `<div class="chat-grid">${cards}</div>`
        : '<div class="empty"><div class="empty-ico">📢</div><div>暂无群组 / 频道记录（机器人成为管理员后会自动登记）</div></div>'}`;
    updatePageSub(`共 ${fmtNum(items.length)} 个聊天`);
  }

  function chatForm(chat) {
    const existing = !!chat;
    openForm({
      title: existing ? `编辑 ${chat.name || chat.id}` : '新增群组 / 频道',
      okText: existing ? '保存修改' : '创建',
      fields: [
        { key: 'id', label: 'chat_id', type: 'number', value: existing ? chat.id : '', required: true, readonly: existing, hint: existing ? 'chat_id 为唯一键，不可修改' : '如 -1001234567890' },
        { key: 'name', label: '名称', value: existing ? chat.name : '' },
        { key: 'type', label: '类型', type: 'select', value: existing ? chat.type : 'channel', options: [{ v: 'channel', l: '📢 频道' }, { v: 'group', l: '👥 群组' }] },
        { key: 'bind_id', label: '绑定对端 chat_id', type: 'number', value: existing && chat.bind_id ? chat.bind_id : '', hint: '留空表示不绑定；填写后会双向绑定（对端不存在则只写本端）' }
      ],
      onSubmit: async (v) => {
        const bindId = String(v.bind_id || '').trim() === '' ? null : Number(v.bind_id);
        if (existing) {
          await apiPost('/groups/update', {
            id: Number(chat.id),
            patch: { name: v.name, type: v.type, bind_id: bindId }
          });
          toast('✅ 聊天已更新');
        } else {
          await apiPost('/groups/create', { id: Number(v.id), name: v.name, type: v.type, bind_id: bindId });
          toast('✅ 聊天已创建');
        }
        await loadOverview().catch(() => { });
        await show('chats');
      }
    });
  }

  /* ============================ 视图：统计报表 ============================ */

  function deltaHtml(delta) {
    if (delta === null || delta === undefined) return '<span class="sub">无上期数据</span>';
    const cls = delta >= 0 ? 'delta-up' : 'delta-down';
    const arrow = delta >= 0 ? '▲' : '▼';
    return `<span class="sub ${cls}">${arrow} ${Math.abs(delta)}% 环比上期</span>`;
  }

  function renderStats() {
    const s = state.stats;
    const d = s.data;
    if (!d) { $('#view').innerHTML = '<div class="loading">正在统计…</div>'; return; }

    const t = d.totals || {};
    const prev = d.previous || {};
    const years = [];
    for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 4; y--) years.push(y);

    const cards = [
      `<div class="report-card"><div class="label">📊 操作总数</div><div class="value">${fmtNum(t.operations)}</div>${deltaHtml(prev.operationsDelta)}</div>`,
      `<div class="report-card"><div class="label">🖼 收录/发送媒体</div><div class="value">${fmtNum(t.media || 0)}</div>${deltaHtml(prev.mediaDelta)}</div>`,
      `<div class="report-card"><div class="label">🗂 媒体组产出</div><div class="value">${fmtNum(t.groups || 0)}</div><div class="sub">含收录、发送、回复</div></div>`,
      `<div class="report-card"><div class="label">📅 活跃天数</div><div class="value">${fmtNum(t.activeDays || 0)}</div><div class="sub">日均 ${t.avgPerDay || 0} 次操作</div></div>`,
      `<div class="report-card"><div class="label">⚠️ 失败操作</div><div class="value">${fmtNum((d.failures && d.failures.count) || 0)}</div><div class="sub">${d.failures && d.failures.count ? '可在下方日志中查看原因' : '全部成功'}</div></div>`
    ].join('');

    const maxDay = Math.max(1, ...(d.byDay || []).map(x => x.count));
    const chart = (d.byDay || []).map((x, i) => {
      const h = Math.max(2, Math.round((x.count / maxDay) * 100));
      const showLabel = (d.byDay.length <= 16) || (i % Math.ceil(d.byDay.length / 12) === 0);
      return `<div class="col" title="${x.day}：${x.count} 次操作 · ${x.media} 个媒体">
        <i style="height:${h}%"></i>
        <span>${showLabel ? x.day.slice(8) : ''}</span>
      </div>`;
    }).join('') || '<div class="empty">本期没有操作记录</div>';

    const maxAction = Math.max(1, ...(d.byAction || []).map(a => a.count));
    const actionRows = (d.byAction || []).slice(0, 15).map(a => `
      <div class="hbar">
        <span class="label" title="${esc(a.action)}">${esc(a.label)}</span>
        <span class="bar"><i style="width:${Math.round((a.count / maxAction) * 100)}%"></i></span>
        <span class="n">${fmtNum(a.count)}${a.media ? ` · ${a.media}个` : ''}${a.fail ? ` · ✕${a.fail}` : ''}</span>
      </div>`).join('') || '<div class="empty">暂无动作数据</div>';

    const categoryRows = (d.byCategory || []).map(c => `
      <div class="hbar">
        <span class="label">${esc(c.label)}</span>
        <span class="bar"><i style="width:${Math.round((c.count / Math.max(1, t.operations)) * 100)}%"></i></span>
        <span class="n">${fmtNum(c.count)}</span>
      </div>`).join('') || '<div class="empty">暂无分类数据</div>';

    const userRows = (d.topUsers || []).map(u => `
      <div class="mini-row"><span class="tag">👤 ${esc(u.userId)}</span><span class="t"></span><span class="time">${fmtNum(u.count)} 次</span></div>`
    ).join('') || '<div class="empty">无用户数据</div>';

    const o = state.oplogs;
    const catOptions = [{ v: 'all', l: '全部大类' }].concat(
      Object.entries((d.catalog && d.catalog.categories) || {}).map(([k, l]) => ({ v: k, l }))
    ).map(opt => `<option value="${esc(opt.v)}" ${o.category === opt.v ? 'selected' : ''}>${esc(opt.l)}</option>`).join('');

    const logRows = o.items.map(item => `
      <tr>
        <td class="num">${fmtTime(item.time)}</td>
        <td><span class="tag ${item.result === 'fail' ? 'danger' : ''}">${esc(item.actionLabel)}</span></td>
        <td class="num">${item.userId === null ? '—' : esc(item.userId)}</td>
        <td class="num">${item.target ? esc(item.target.type) + ' · ' + esc(shortId(item.target.id, 22)) : '—'}</td>
        <td class="num">${item.counts ? esc(Object.entries(item.counts).map(([k, v]) => `${k}:${v}`).join(' ')) : '—'}</td>
        <td class="log-detail">${esc(item.error || JSON.stringify(item.detail || {}).slice(0, 120))}</td>
      </tr>`).join('') || '<tr><td colspan="6"><div class="empty">没有符合条件的日志</div></td></tr>';

    $('#view').innerHTML = `
      <div class="toolbar">
        <div class="tabs">
          <button class="${s.period === 'month' ? 'is-active' : ''}" data-action="stats-period" data-period="month">月报</button>
          <button class="${s.period === 'year' ? 'is-active' : ''}" data-action="stats-period" data-period="year">年报</button>
        </div>
        <select id="stats-year" style="width:auto">${years.map(y => `<option value="${y}" ${s.year === y ? 'selected' : ''}>${y} 年</option>`).join('')}</select>
        <select id="stats-month" style="width:auto" ${s.period === 'year' ? 'disabled' : ''}>
          ${Array.from({ length: 12 }, (_, i) => i + 1).map(m => `<option value="${m}" ${s.month === m ? 'selected' : ''}>${m} 月</option>`).join('')}
        </select>
        <span class="tag accent">${esc(d.label)}</span>
        <span class="dim">统计区间 ${fmtTime(d.from)} ~ ${fmtTime(d.to)}${d.truncated ? ' · 仅统计最近 20000 条' : ''}</span>
      </div>
      <div class="report-grid">${cards}</div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>每日操作量</h3><span class="dim">柱高 = 操作次数，悬停看媒体数</span></div>
          <div class="chart">${chart}</div>
        </div>
        <div class="card">
          <div class="card-head"><h3>动作明细</h3><span class="dim">Top 15</span></div>
          ${actionRows}
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>大类分布</h3></div>
          ${categoryRows}
        </div>
        <div class="card">
          <div class="card-head"><h3>活跃用户</h3><span class="dim">按操作次数</span></div>
          <div class="mini-list">${userRows}</div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-head">
          <h3>操作日志明细</h3>
          <select id="oplog-category" style="width:auto">${catOptions}</select>
          <select id="oplog-result" style="width:auto">
            <option value="all" ${o.result === 'all' ? 'selected' : ''}>全部结果</option>
            <option value="ok" ${o.result === 'ok' ? 'selected' : ''}>成功</option>
            <option value="fail" ${o.result === 'fail' ? 'selected' : ''}>失败</option>
          </select>
          <span class="spacer"></span>
          <span class="dim">共 ${fmtNum(o.total)} 条</span>
        </div>
        <div class="table-wrap table-scroll">
          <table>
            <thead><tr><th>时间</th><th>动作</th><th>用户</th><th>对象</th><th>数量</th><th>详情 / 错误</th></tr></thead>
            <tbody>${logRows}</tbody>
          </table>
        </div>
        ${paginationHtml({ page: o.page, totalPages: o.totalPages }, 'oplog-page')}
      </div>`;
    updatePageSub(`${d.label} · 共 ${fmtNum(t.operations)} 次操作`);
  }

  /* ============================ 视图：原始数据 ============================ */

  function docCard(collection, doc, index) {
    const key = `${collection}:${doc._id || index}`;
    return `<div class="doc-card" data-key="${esc(key)}" data-collection="${esc(collection)}" data-json="${esc(JSON.stringify(doc))}">
      <div class="doc-main">
        <div class="doc-json">${esc(JSON.stringify(doc, null, 2))}</div>
        <div class="doc-actions">
          <button class="btn btn-sm" data-action="raw-edit">✏️ 修改</button>
          <button class="btn btn-soft-danger btn-sm" data-action="raw-del">🗑 删除</button>
        </div>
      </div>
    </div>`;
  }

  function renderRaw() {
    const r = state.raw;
    const isAll = r.collection === ALL_KEY;
    const options = [`<option value="${ALL_KEY}" ${isAll ? 'selected' : ''}>全部数据库</option>`]
      .concat(state.collections.map(c => `<option value="${c}" ${r.collection === c ? 'selected' : ''}>${c}</option>`)).join('');

    let listHtml;
    if (isAll) {
      const groups = (r.groups || []).filter(g => g.total > 0);
      listHtml = groups.length ? groups.map(g => `
        <div class="col-summary" data-action="raw-collection" data-collection="${esc(g.collection)}">
          <span>📁</span><b>${esc(g.collection)}</b>
          <span class="count">${fmtNum(g.total)} 条</span>
        </div>`).join('') : '<div class="empty">没有数据</div>';
    } else {
      listHtml = r.items.length
        ? r.items.map((d, i) => docCard(r.collection, d, i)).join('')
        : '<div class="empty">没有数据</div>';
    }

    $('#view').innerHTML = `
      <div class="raw-toolbar">
        <select id="raw-collection" style="width:190px">${options}</select>
        <select id="raw-sort" style="width:132px" ${isAll ? 'disabled' : ''}>
          <option value="-1" ${r.sort === -1 ? 'selected' : ''}>最新在前</option>
          <option value="1" ${r.sort === 1 ? 'selected' : ''}>最早在前</option>
        </select>
        <button class="btn btn-sm" data-action="raw-insert" ${isAll ? 'disabled' : ''}>➕ 插入数据</button>
        <button class="btn btn-sm" data-action="palette">🧠 AI 翻译 / 执行</button>
        <span class="grow"></span>
        <span class="dim">${isAll ? '跨集合浏览（每集合最多 50 条）' : `共 ${fmtNum(r.total)} 条`}</span>
      </div>
      <div class="doc-list">${listHtml}</div>
      ${isAll ? '' : paginationHtml(r, 'raw-page')}`;
    updatePageSub(isAll ? '跨集合浏览原始文档' : `${r.collection} · 共 ${fmtNum(r.total)} 条`);
  }

  /* ============================ 视图：实时日志 ============================ */

  function renderLogs() {
    $('#view').innerHTML = `
      <div class="toolbar">
        <div class="chips">
          ${[['all', '全部'], ['info', '信息'], ['success', '成功'], ['warn', '警告'], ['error', '错误']]
        .map(([v, l]) => `<button class="chip ${state.logFilter === v ? 'is-active' : ''}" data-action="log-filter" data-level="${v}">${l}</button>`).join('')}
        </div>
        <span class="grow"></span>
        <button class="btn btn-sm" data-action="log-pause">${state.logPaused ? '▶ 继续' : '⏸ 暂停'}</button>
        <button class="btn btn-sm" data-action="log-clear">🗑 清空</button>
        <span class="tag ${logConnected ? 'ok' : 'warn'}" id="log-view-status">${logConnected ? '已连接' : '重连中'}</span>
      </div>
      <div class="log-list" id="log-view-list" style="background:var(--surface);border:1px solid var(--border);border-radius:12px;height:calc(100vh - 250px)"></div>`;
    renderLogList();
  }

  /* ============================ 详情对话框（描述 / 标签 / 跳转） ============================ */

  async function openMediaDetail(groupId, opts = {}) {
    const dlg = $('#detail-dialog');
    if (!opts.keepScroll) {
      $('#detail-title').innerHTML = `<span class="mono">${esc(shortId(groupId, 40))}</span>`;
      $('#detail-body').innerHTML = '<div class="loading">正在加载媒体组…</div>';
      $('#detail-foot').innerHTML = '';
      if (!dlg.open) dlg.showModal();
    }

    let data;
    try {
      data = await apiGet('/media/detail?groupId=' + encodeURIComponent(groupId));
    } catch (err) {
      $('#detail-body').innerHTML = `<div class="empty">❌ ${esc(err.message)}</div>`;
      return;
    }
    state.detail = data;

    const g = data.group || {};
    const media = data.media || [];
    const messages = data.messages || [];
    const cleanable = g.cleanable;
    const link = telegramLink(data);

    const strip = media.map(m => `
      <div class="detail-item">
        ${m.thumbable
        ? `<img loading="lazy" decoding="async" src="${thumbUrl(m.file_unique_id)}" alt="">`
        : `<div class="ph">${typeIcon(m.media_type)}</div>`}
        <div class="cap">
          <span>#${m.subgroup} · ${typeLabel(m.media_type)}</span>
          <span class="mono">${m.video_time ? fmtDuration(m.video_time) : 'msg ' + m.message_id}</span>
        </div>
      </div>`).join('') || '<div class="empty">该组没有媒体记录</div>';

    // 每条 message：描述可直接编辑，标签可增删
    const msgBlocks = messages.map(m => `
      <div class="msg-block" data-msg="${esc(m.file_unique_id)}">
        <div class="text" data-role="text">${esc(m.text || '（空描述）')}</div>
        <div class="editor hidden" data-role="editor">
          <textarea data-role="input" placeholder="输入新的描述；留空保存 = 清空描述（该组变为可清理）">${esc(m.text || '')}</textarea>
          <div class="editor-row">
            <button class="btn btn-primary btn-sm" data-action="desc-save" data-file="${esc(m.file_unique_id)}">💾 保存描述</button>
            <button class="btn btn-ghost btn-sm" data-action="desc-cancel">取消</button>
            <span class="dim">保存会同步修改 Telegram 上的描述；超 48 小时的消息只改数据库</span>
          </div>
        </div>
        <div class="foot">
          <span class="tag-edit" data-role="tags">
            ${(m.tags || []).map(t => `<span class="tag-pill">${esc(t)}<button data-action="tag-remove" data-file="${esc(m.file_unique_id)}" data-tag="${esc(t)}" title="移除该标签">✕</button></span>`).join('') || '<span class="dim">（无标签）</span>'}
          </span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-xs" data-action="desc-edit">✏️ 编辑描述</button>
          <button class="btn btn-ghost btn-xs" data-action="tag-add-prompt" data-file="${esc(m.file_unique_id)}">🏷 加标签</button>
        </div>
        <div class="hidden" data-role="tag-picker">
          <div class="editor-row" style="margin-top:8px">
            <input data-role="tag-input" placeholder="输入标签名（回车添加，可新建）" style="flex:1;min-width:160px">
            <button class="btn btn-sm" data-action="tag-add" data-file="${esc(m.file_unique_id)}">➕ 添加</button>
          </div>
          <div class="tag-suggest">
            ${(state.tags || []).filter(t => !(m.tags || []).includes(t.name)).slice(0, 12)
        .map(t => `<button class="chip" data-action="tag-add" data-file="${esc(m.file_unique_id)}" data-tag="${esc(t.name)}">${esc(t.name)}</button>`).join('') || '<span class="dim">标签库为空，直接输入即可新建</span>'}
          </div>
        </div>
        <div class="foot" style="margin-top:4px">
          <span class="mono dim">${esc(m.file_unique_id)}</span>
          <span class="dim">·</span>
          <span class="mono dim">${esc(m.chat_id)} / ${esc(m.message_id)}</span>
        </div>
      </div>`).join('') || '<div class="empty">该组没有描述（空描述 · 可被清理）</div>';

    const positions = [];
    if (g.group_id) positions.push(['group_id', g.group_id]);
    const first = media[0] || {};
    if (first.group) positions.push(['群组位置', `${first.group.chat_id} / ${first.group.message_id}`]);
    if (first.channel) positions.push(['频道位置', `${first.channel.chat_id} / ${first.channel.message_id}`]);

    $('#detail-body').innerHTML = `
      <div class="toolbar">
        <span class="tag ${cleanable ? 'warn' : 'ok'}">${cleanable ? '🟠 可清理' : '🟢 保留（有描述）'}</span>
        <span class="tag">${fmtNum(g.is_group)} 个媒体</span>
        <span class="tag">${fmtNum(new Set(media.map(m => m.subgroup)).size)} 组</span>
        ${g.mark ? `<span class="tag accent">被标记 ${fmtNum(g.mark)} 次</span>` : ''}
        <span class="spacer"></span>
        <span class="dim" style="font-size:11.5px">is_delete = ${esc(String(g.is_delete))}${cleanable ? ` · ${fmtAgo(g.is_delete)}` : ''}</span>
      </div>
      <div class="section">
        <h4>媒体（${media.length}）</h4>
        <div class="detail-strip">${strip}</div>
      </div>
      <div class="section">
        <h4>描述与标签（可直接修改）</h4>
        ${msgBlocks}
        <div class="editor" style="margin-top:12px">
          <div class="editor-row">
            <b style="font-size:12.5px">整组操作</b>
            <input data-role="group-tag-input" placeholder="给组内所有 media 添加同一个标签" style="flex:1;min-width:160px">
            <button class="btn btn-sm" data-action="tag-group-add" data-group="${esc(groupId)}">🏷 添加到整组</button>
          </div>
          <div class="tag-suggest">
            ${(state.tags || []).slice(0, 12).map(t => `<button class="chip" data-action="tag-group-add" data-group="${esc(groupId)}" data-tag="${esc(t.name)}">${esc(t.name)}</button>`).join('') || '<span class="dim">标签库为空，直接输入即可新建</span>'}
          </div>
        </div>
      </div>
      <div class="section">
        <h4>定位信息</h4>
        <div class="kv">${positions.map(([k, v]) => `<span class="k">${k}</span><span class="v mono">${esc(v)}</span>`).join('')}</div>
      </div>`;

    $('#detail-foot').innerHTML = `
      ${link ? `<a class="btn btn-primary btn-sm" href="${esc(link)}" target="_blank" rel="noopener">↗ 跳转 Telegram 查看</a>` : ''}
      <button class="btn btn-ghost btn-sm" data-action="detail-copy" data-group="${esc(groupId)}">📋 复制 group_id</button>
      <span class="spacer"></span>
      ${cleanable
        ? `<button class="btn btn-ghost btn-sm" data-action="detail-keep" data-group="${esc(groupId)}">🟢 标记为保留</button>`
        : `<button class="btn btn-soft-danger btn-sm" data-action="detail-cleanable" data-group="${esc(groupId)}">🟠 标记为可清理</button>`}
      <button class="btn btn-primary btn-sm" data-action="detail-close">关闭</button>`;
  }

  /** 修改描述（空文本 = 清空描述） */
  async function saveDescription(fileUniqueId, block) {
    const text = block.querySelector('[data-role="input"]').value;
    const r = await apiPost('/media/description', { fileUniqueId, text });
    if (r.telegramEdited) toast('✅ 描述已更新（Telegram 同步完成）');
    else toast(`✅ 数据库已更新${r.telegramError ? `（Telegram 未同步：${r.telegramError}）` : ''}`, !r.telegramError ? false : true);
    await loadOverview().catch(() => { });
    await openMediaDetail(state.detail.group.group_id);
  }

  async function applyMediaTags(fileUniqueId, { add = [], remove = [] }) {
    const r = await apiPost('/media/tags', { fileUniqueId, add, remove });
    toast(`🏷 标签已更新（当前：${r.tags.join('、') || '无'}）`);
    await openMediaDetail(state.detail.group.group_id);
  }

  /* ============================ 分页 ============================ */

  function paginationHtml(pager, action) {
    const N = pager.totalPages;
    if (N <= 1) return '';
    const cur = pager.page;
    const btn = (label, page, cls = '') =>
      `<button class="btn btn-sm ${cls}" data-action="${action}" data-page="${page}">${label}</button>`;
    const parts = [btn('1', 1, cur === 1 ? 'page-current' : '')];
    if (cur > 3) parts.push('<span class="ellipsis">···</span>');
    for (let i = Math.max(2, cur - 1); i <= Math.min(N - 1, cur + 1); i++) {
      parts.push(btn(String(i), i, i === cur ? 'page-current' : ''));
    }
    if (cur < N - 2) parts.push('<span class="ellipsis">···</span>');
    parts.push(btn(String(N), N, cur === N ? 'page-current' : ''));
    parts.push(`<input type="number" class="page-input" min="1" max="${N}" placeholder="页码" data-action="${action}-input">`);
    parts.push(`<button class="btn btn-sm" data-action="${action}" data-page-input="1">跳转</button>`);
    return `<div class="pagination">${parts.join('')}</div>`;
  }

  function updatePageSub(text) {
    const el = $('#page-sub');
    if (el) el.textContent = text;
  }

  /* ============================ 视图调度 ============================ */

  const VIEW_META = {
    overview: { title: '概览', load: loadOverview, render: renderOverview },
    media: { title: '媒体库', load: loadMedia, render: renderMedia },
    clean: { title: '清理中心', load: loadClean, render: renderClean },
    tags: {
      title: '标签',
      load: async () => { const d = await apiGet('/tags'); state.tags = d.tags || []; },
      render: renderTags
    },
    users: { title: '用户', load: loadUsers, render: renderUsers },
    chats: {
      title: '群组 / 频道',
      load: async () => { const d = await apiGet('/groups'); state.chats = d.items || []; },
      render: renderChats
    },
    stats: { title: '统计报表', load: loadStats, render: renderStats },
    raw: { title: '原始数据', load: loadRaw, render: renderRaw },
    logs: { title: '实时日志', load: async () => { }, render: renderLogs }
  };

  function setSearchVisible(view) {
    $('#search-wrap').classList.toggle('hidden', !SEARCH_VIEWS.includes(view));
  }

  async function show(view) {
    if (!VIEW_META[view]) return;
    state.view = view;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
    $('#page-title').textContent = VIEW_META[view].title;
    setSearchVisible(view);

    if (state.loading) return;
    state.loading = true;
    $('#view').innerHTML = '<div class="loading">正在加载…</div>';
    try {
      await VIEW_META[view].load();
      VIEW_META[view].render();
    } catch (err) {
      $('#view').innerHTML = `<div class="empty"><div class="empty-ico">⚠️</div><div>${esc(err.message)}</div>
        <button class="btn btn-sm" data-action="retry">重试</button></div>`;
    } finally {
      state.loading = false;
    }
  }

  async function refreshCurrent() {
    if (state.loading) return;
    if (state.view !== 'overview') loadOverview().catch(() => { });
    await show(state.view);
  }

  /* ============================ 事件 ============================ */

  function bindViewEvents() {
    const view = $('#view');

    view.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.dataset.action;

      try {
        switch (action) {
          case 'goto': await show(el.dataset.view); break;
          case 'palette': openPalette(); break;
          case 'retry': await show(state.view); break;
          case 'open-media': await openMediaDetail(el.dataset.group); break;
          case 'media-scope':
            state.media.scope = el.dataset.scope;
            state.media.page = 1;
            await show('media'); break;
          case 'media-page': await pageTo(state.media, el, show); break;
          case 'users-page': await pageTo(state.users, el, show); break;
          case 'raw-page': await pageTo(state.raw, el, show); break;
          case 'oplog-page': await pageTo(state.oplogs, el, async () => { await loadOpLogs(); renderStats(); }); break;
          case 'user-scope':
            state.users.scope = el.dataset.scope;
            state.users.page = 1;
            await show('users'); break;
          case 'clean-run': await runClean(el.dataset.scope); break;
          case 'raw-collection':
            state.raw.collection = el.dataset.collection;
            state.raw.page = 1;
            await show('raw'); break;
          case 'raw-edit': startDocEdit(el); break;
          case 'raw-cancel': cancelDocEdit(el); break;
          case 'raw-save': await saveDocEdit(el); break;
          case 'raw-del': await deleteDoc(el); break;
          case 'raw-insert': insertDoc(); break;
          case 'insert-confirm': await insertConfirm(el); break;
          case 'insert-cancel': el.closest('.doc-card').remove(); break;
          case 'log-filter': state.logFilter = el.dataset.level; renderLogs(); break;
          case 'log-pause': state.logPaused = !state.logPaused; renderLogs(); break;
          case 'log-clear': state.logBuffer = []; renderLogList(); break;
          // 标签 → 媒体组
          case 'tag-media':
            state.media.tag = el.dataset.tag;
            state.media.page = 1;
            await show('media'); break;
          case 'clear-tag':
            state.media.tag = '';
            state.media.page = 1;
            await show('media'); break;
          // 用户 / 聊天 CRUD
          case 'user-create': userForm(null); break;
          case 'user-edit': userForm(state.users.items.find(x => String(x.id) === el.dataset.id)); break;
          case 'user-delete': await deleteUser(el.dataset.id, el.dataset.name); break;
          case 'chat-create': chatForm(null); break;
          case 'chat-edit': chatForm(state.chats.find(c => String(c.id) === el.dataset.id)); break;
          case 'chat-delete': await deleteChat(el.dataset.id, el.dataset.name); break;
          // 报表
          case 'stats-period':
            state.stats.period = el.dataset.period;
            state.stats.data = null;
            await show('stats'); break;
          default: break;
        }
      } catch (err) {
        toast(err.message, true);
      }
    });

    view.addEventListener('keydown', async (e) => {
      const el = e.target;
      if (e.key !== 'Enter' || !el.dataset || !el.dataset.action) return;
      if (!el.dataset.action.endsWith('-input')) return;
      const action = el.dataset.action.replace('-input', '');
      const pager = action === 'media-page' ? state.media
        : action === 'users-page' ? state.users
          : action === 'oplog-page' ? state.oplogs : state.raw;
      const v = parseInt(el.value, 10);
      if (v >= 1 && v <= pager.totalPages) {
        pager.page = v;
        if (action === 'oplog-page') { await loadOpLogs(); renderStats(); }
        else await show(state.view);
      }
    });

    // 缩略图加载失败 → 退化为类型图标占位
    view.addEventListener('error', (e) => {
      const img = e.target;
      if (img && img.tagName === 'IMG' && img.closest('.media-thumb, .detail-item')) {
        const wrap = img.parentElement;
        img.remove();
        if (!wrap.querySelector('.ph')) {
          const span = document.createElement('span');
          span.className = 'ph';
          span.textContent = '🖼';
          wrap.prepend(span);
        }
      }
    }, true);

    view.addEventListener('change', async (e) => {
      const el = e.target;
      if (el.id === 'media-pagesize') {
        state.media.pageSize = parseInt(el.value, 10) || 24;
        state.media.page = 1;
        await show('media');
      } else if (el.id === 'users-pagesize') {
        state.users.pageSize = parseInt(el.value, 10) || 20;
        state.users.page = 1;
        await show('users');
      } else if (el.id === 'raw-collection') {
        state.raw.collection = el.value;
        state.raw.page = 1;
        await show('raw');
      } else if (el.id === 'raw-sort') {
        state.raw.sort = parseInt(el.value, 10) || -1;
        state.raw.page = 1;
        await show('raw');
      } else if (el.id === 'stats-year') {
        state.stats.year = parseInt(el.value, 10);
        state.stats.data = null;
        await show('stats');
      } else if (el.id === 'stats-month') {
        state.stats.month = parseInt(el.value, 10);
        state.stats.data = null;
        await show('stats');
      } else if (el.id === 'oplog-category') {
        state.oplogs.category = el.value;
        state.oplogs.page = 1;
        await loadOpLogs();
        renderStats();
      } else if (el.id === 'oplog-result') {
        state.oplogs.result = el.value;
        state.oplogs.page = 1;
        await loadOpLogs();
        renderStats();
      }
    });
  }

  async function pageTo(pager, el, rerender) {
    let page;
    if (el.dataset.pageInput) {
      const input = el.parentElement.querySelector('.page-input');
      page = parseInt(input && input.value, 10);
    } else {
      page = parseInt(el.dataset.page, 10);
    }
    if (!(page >= 1 && page <= pager.totalPages)) return;
    pager.page = page;
    await rerender(state.view);
  }

  /* ---------------- 原始数据：增删改 ---------------- */

  function startDocEdit(btn) {
    const card = btn.closest('.doc-card');
    card.classList.add('is-editing');
    const jsonEl = card.querySelector('.doc-json');
    jsonEl.contentEditable = 'true';
    jsonEl.focus();
    card.querySelector('.doc-actions').innerHTML = `
      <button class="btn btn-success btn-sm" data-action="raw-save">✓ 保存</button>
      <button class="btn btn-soft-danger btn-sm" data-action="raw-cancel">✕ 取消</button>`;
  }

  function cancelDocEdit(btn) {
    const card = btn.closest('.doc-card');
    card.classList.remove('is-editing');
    const jsonEl = card.querySelector('.doc-json');
    jsonEl.contentEditable = 'false';
    jsonEl.textContent = JSON.stringify(JSON.parse(card.dataset.json), null, 2);
    card.querySelector('.doc-actions').innerHTML = `
      <button class="btn btn-sm" data-action="raw-edit">✏️ 修改</button>
      <button class="btn btn-soft-danger btn-sm" data-action="raw-del">🗑 删除</button>`;
  }

  async function saveDocEdit(btn) {
    const card = btn.closest('.doc-card');
    const collection = card.dataset.collection;
    const origin = JSON.parse(card.dataset.json);
    let data;
    try {
      data = JSON.parse(card.querySelector('.doc-json').textContent);
    } catch (e) {
      throw new Error('JSON 解析失败：' + e.message);
    }
    delete data._id;
    const r = await apiPost('/db/execute', {
      operation: { action: 'update', collection, filter: { _id: origin._id }, data }
    });
    toast(r.matchedCount ? `✅ 已修改（匹配 ${r.matchedCount} 条）` : '⚠️ 未匹配到文档', !r.matchedCount);
    await refreshCurrent();
  }

  async function deleteDoc(btn) {
    const card = btn.closest('.doc-card');
    const collection = card.dataset.collection;
    const doc = JSON.parse(card.dataset.json);
    const ok = await confirmDialog({
      title: `删除 ${collection} 文档`,
      body: `<div class="dim" style="margin-bottom:10px">该操作不可撤销，请确认文档内容：</div>
             <pre class="doc-json" style="max-height:220px">${esc(JSON.stringify(doc, null, 2))}</pre>`
    });
    if (!ok) return;
    const r = await apiPost('/db/execute', {
      operation: { action: 'delete', collection, filter: { _id: doc._id } },
      confirm: true
    });
    toast(r.deletedCount ? '🗑 已删除' : '⚠️ 未匹配到文档', !r.deletedCount);
    await refreshCurrent();
  }

  function insertDoc() {
    const collection = state.raw.collection;
    if (collection === ALL_KEY) return;
    const template = {};
    const first = (state.raw.items || [])[0];
    if (first) for (const k of Object.keys(first)) if (k !== '_id') template[k] = '';
    const card = document.createElement('div');
    card.className = 'doc-card is-editing';
    card.dataset.collection = collection;
    card.innerHTML = `
      <div class="doc-main">
        <div class="doc-json" contenteditable="true">${esc(JSON.stringify(template, null, 2))}</div>
        <div class="doc-actions">
          <button class="btn btn-success btn-sm" data-action="insert-confirm">✓ 插入</button>
          <button class="btn btn-soft-danger btn-sm" data-action="insert-cancel">✕ 取消</button>
        </div>
      </div>`;
    $('#view').querySelector('.doc-list').prepend(card);
    card.querySelector('.doc-json').focus();
  }

  async function insertConfirm(btn) {
    const card = btn.closest('.doc-card');
    const collection = card.dataset.collection;
    let data;
    try {
      data = JSON.parse(card.querySelector('.doc-json').textContent);
    } catch (e) {
      throw new Error('JSON 解析失败：' + e.message);
    }
    const r = await apiPost('/db/execute', { operation: { action: 'insert', collection, data } });
    toast(`✅ 已插入（${r.insertedId}）`);
    await refreshCurrent();
  }

  /* ---------------- 用户 / 聊天 删除 ---------------- */

  async function deleteUser(id, name) {
    const ok = await confirmDialog({
      title: '删除用户记录',
      body: `<div>确定删除用户 <b>${esc(name || id)}</b>（id=${esc(id)}）的数据库记录吗？</div>
             <div class="dim" style="margin-top:8px">仅删除数据库记录，不会在 Telegram 里封禁或踢出该用户。</div>`,
      okText: '确认删除'
    });
    if (!ok) return;
    await apiPost('/users/delete', { id: Number(id), confirm: true });
    toast('🗑 用户记录已删除');
    await loadOverview().catch(() => { });
    await show('users');
  }

  async function deleteChat(id, name) {
    const ok = await confirmDialog({
      title: '删除聊天记录',
      body: `<div>确定删除 <b>${esc(name || id)}</b>（chat_id=${esc(id)}）吗？</div>
             <div class="dim" style="margin-top:8px">对端的绑定关系会一并清除；不会影响 Telegram 里的群组/频道与已收录媒体。</div>`,
      okText: '确认删除'
    });
    if (!ok) return;
    await apiPost('/groups/delete', { id: Number(id), confirm: true });
    toast('🗑 聊天记录已删除');
    await loadOverview().catch(() => { });
    await show('chats');
  }

  /* ---------------- 清理 ---------------- */

  async function runClean(scope) {
    const label = { week: '一周之前', month: '一个月之前', all: '全部' }[scope] || scope;
    const preview = (state.clean.previews || []).find(p => p.scope === scope) || { groups: 0, media: 0 };
    const ok = await confirmDialog({
      title: `清理${label}空数据`,
      body: `<div>将删除 <b>${fmtNum(preview.groups)}</b> 个媒体组的
             <b>${fmtNum(preview.media)}</b> 条媒体记录与对应 group_list 记录。</div>
             <div class="dim" style="margin-top:8px">Telegram 中的消息不会被删除；此操作不可撤销。</div>`,
      okText: '确认清理'
    });
    if (!ok) return;
    const r = await apiPost('/clean', { scope, confirm: true });
    toast(`🧹 已清理 ${fmtNum(r.groups)} 组 / ${fmtNum(r.media)} 个媒体`);
    await loadOverview().catch(() => { });
    await show('clean');
  }

  /* ---------------- AI 操作台 ---------------- */

  function openPalette() {
    $('#palette').classList.remove('hidden');
    $('#palette-prompt').focus();
  }
  function closePalette() {
    $('#palette').classList.add('hidden');
  }

  async function translatePrompt() {
    const prompt = $('#palette-prompt').value.trim();
    if (!prompt) { toast('请输入要执行的操作描述', true); return; }
    const explain = $('#palette-explain');
    explain.classList.remove('hidden');
    explain.textContent = '⏳ 正在翻译…';
    $('#palette-json').classList.add('hidden');
    $('#palette-exec-row').hidden = true;
    try {
      const payload = { prompt };
      if (state.selectedRaw) payload.selected = state.selectedRaw;
      const data = await apiPost('/ai/plan', payload);
      explain.textContent = data.explain || '（AI 未给出说明）';
      const jsonEl = $('#palette-json');
      jsonEl.value = JSON.stringify(data.operation, null, 2);
      jsonEl.classList.remove('hidden');
      $('#palette-exec-row').hidden = false;
      toast('✅ 已翻译，确认无误后点「执行操作」');
    } catch (err) {
      explain.textContent = '❌ ' + err.message;
      toast(err.message, true);
    }
  }

  async function executePlan() {
    let operation;
    try {
      operation = JSON.parse($('#palette-json').value);
    } catch (e) {
      toast('操作 JSON 解析失败：' + e.message, true);
      return;
    }
    if (!operation || !operation.action || !operation.collection) {
      toast('操作 JSON 需要 action 与 collection 字段', true);
      return;
    }
    if (operation.action === 'delete') {
      const ok = await confirmDialog({
        title: '执行删除操作',
        body: `<div>将删除 <code>${esc(operation.collection)}</code> 中匹配的文档：</div>
               <pre class="doc-json" style="margin-top:10px">${esc(JSON.stringify(operation.filter, null, 2))}</pre>`,
        okText: '确认删除'
      });
      if (!ok) return;
    }
    const data = await apiPost('/db/execute', { operation, confirm: operation.action === 'delete' });
    if (data.type === 'query') {
      toast(`✅ 查询到 ${fmtNum(data.total)} 条，已在「原始数据」中展示`);
      closePalette();
      state.raw.collection = operation.collection;
      state.raw.items = data.items || [];
      state.raw.total = data.total || 0;
      state.raw.totalPages = 1;
      state.raw.page = 1;
      state.view = 'raw';
      document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.view === 'raw'));
      $('#page-title').textContent = VIEW_META.raw.title;
      setSearchVisible('raw');
      VIEW_META.raw.render();
    } else {
      toast(`✅ 已执行：${{ insert: '插入', update: '修改', delete: '删除' }[data.type] || data.type}`);
      closePalette();
      await refreshCurrent();
    }
  }

  /* ---------------- 日志流 ---------------- */

  let logSource = null;
  let logConnected = false;

  function startLogStream() {
    stopLogStream();
    const source = new EventSource(`${API}/logs/stream?token=${encodeURIComponent(token())}`);
    source.onopen = () => { logConnected = true; setLogStatus(); };
    source.onmessage = (e) => {
      try { pushLog(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    source.onerror = () => { logConnected = false; setLogStatus(); };
    logSource = source;
  }
  function stopLogStream() {
    if (logSource) { logSource.close(); logSource = null; logConnected = false; }
  }
  function setLogStatus() {
    const t = logConnected ? '已连接' : '重连中…';
    const s = $('#log-status');
    if (s) s.textContent = t;
    const d = $('#log-dot');
    if (d) d.classList.toggle('on', logConnected);
    const vs = $('#log-view-status');
    if (vs) { vs.textContent = t; vs.className = 'tag ' + (logConnected ? 'ok' : 'warn'); }
  }

  function pushLog(entry) {
    state.logBuffer.push(entry);
    if (state.logBuffer.length > 800) state.logBuffer.shift();
    if (state.logPaused) return;
    appendLogLine(entry);
  }

  function logLineClass(level) {
    return { info: 'log-info', success: 'log-success', warn: 'log-warn', error: 'log-error' }[level] || 'log-info';
  }
  function logLineHtml(entry) {
    const time = (entry.timestamp || '').slice(0, 19);
    const level = String(entry.level || 'info').toUpperCase().slice(0, 4);
    return `<span class="log-time">[${esc(time)}]</span> <span class="log-level ${logLineClass(entry.level)}">[${esc(level)}]</span> ${esc(entry.message || '')}`;
  }
  function appendLogLine(entry) {
    const targets = [$('#log-list'), $('#log-view-list')].filter(Boolean);
    for (const list of targets) {
      if (list.id === 'log-view-list' && state.logFilter !== 'all' && entry.level !== state.logFilter) continue;
      const div = document.createElement('div');
      div.className = 'log-line';
      div.innerHTML = logLineHtml(entry);
      list.appendChild(div);
      while (list.children.length > 800) list.removeChild(list.firstChild);
      list.scrollTop = list.scrollHeight;
    }
  }
  function renderLogList() {
    const list = $('#log-view-list');
    if (!list) return;
    const entries = state.logBuffer.filter(e => state.logFilter === 'all' || e.level === state.logFilter);
    list.innerHTML = entries.map(e => `<div class="log-line">${logLineHtml(e)}</div>`).join('')
      || '<div class="empty">暂无日志（后端写入日志时会实时推送）</div>';
    list.scrollTop = list.scrollHeight;
  }

  /* ---------------- 搜索 / 自动刷新 ---------------- */

  function bindSearch() {
    const input = $('#global-search');
    const wrap = $('#search-wrap');
    const sync = () => wrap.classList.toggle('has-text', input.value.length > 0);
    let timer = null;
    const apply = () => {
      const v = input.value.trim();
      state.search = v;
      if (state.view === 'media') { state.media.q = v; state.media.page = 1; show('media'); }
      else if (state.view === 'users') { state.users.q = v; state.users.page = 1; show('users'); }
      else if (state.view === 'tags') { show('tags'); }
    };
    input.addEventListener('input', () => {
      sync();
      clearTimeout(timer);
      if (!SEARCH_VIEWS.includes(state.view)) return;
      timer = setTimeout(apply, 320);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(timer); apply(); }
      if (e.key === 'Escape') { input.value = ''; sync(); apply(); }
    });
    $('#search-clear').addEventListener('click', () => {
      input.value = '';
      sync();
      apply();
      input.focus();
    });
  }

  function bindAutoRefresh() {
    $('#auto-refresh').addEventListener('change', (e) => {
      state.autoRefresh = e.target.checked;
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      if (state.autoRefresh) {
        state.timer = setInterval(() => { if (!document.hidden) refreshCurrent(); }, 5000);
        toast('已开启自动刷新（5 秒）');
      }
    });
  }

  /* ---------------- 详情对话框事件（描述 / 标签） ---------------- */

  function bindDetailEvents() {
    const dlg = $('#detail-dialog');
    dlg.addEventListener('click', async (e) => {
      const el = e.target.closest('[data-action]');
      if (!el && e.target.dataset.close === undefined) return;
      const action = el ? el.dataset.action : 'detail-close';
      const groupId = state.detail && state.detail.group ? state.detail.group.group_id : null;
      try {
        switch (action) {
          case 'detail-close': dlg.close(); break;
          case 'detail-copy':
            try { await navigator.clipboard.writeText(el.dataset.group || groupId); toast('📋 已复制 group_id'); }
            catch { toast('复制失败，请手动选择文本', true); }
            break;
          case 'detail-cleanable': await setGroupCleanable(el.dataset.group, true); break;
          case 'detail-keep': await setGroupCleanable(el.dataset.group, false); break;
          case 'desc-edit': {
            const block = el.closest('.msg-block');
            block.querySelector('[data-role="text"]').classList.add('hidden');
            block.querySelector('[data-role="editor"]').classList.remove('hidden');
            block.querySelector('[data-role="input"]').focus();
            break;
          }
          case 'desc-cancel': {
            const block = el.closest('.msg-block');
            block.querySelector('[data-role="editor"]').classList.add('hidden');
            block.querySelector('[data-role="text"]').classList.remove('hidden');
            break;
          }
          case 'desc-save': await saveDescription(el.dataset.file, el.closest('.msg-block')); break;
          case 'tag-add-prompt': {
            const block = el.closest('.msg-block');
            const picker = block.querySelector('[data-role="tag-picker"]');
            picker.classList.toggle('hidden');
            const input = block.querySelector('[data-role="tag-input"]');
            if (input && !picker.classList.contains('hidden')) input.focus();
            break;
          }
          case 'tag-add': {
            const tag = el.dataset.tag || el.closest('.msg-block').querySelector('[data-role="tag-input"]').value.trim();
            if (!tag) { toast('请输入标签名', true); break; }
            await applyMediaTags(el.dataset.file, { add: [tag] });
            break;
          }
          case 'tag-remove': await applyMediaTags(el.dataset.file, { remove: [el.dataset.tag] }); break;
          case 'tag-group-add': {
            const target = state.detail && state.detail.group ? state.detail.group.group_id : el.dataset.group;
            const groupBlock = el.closest('.editor');
            const tag = el.dataset.tag || (groupBlock.querySelector('[data-role="group-tag-input"]') || {}).value;
            if (!tag || !String(tag).trim()) { toast('请输入标签名', true); break; }
            const r = await apiPost('/media/tags', { groupId: target, add: [String(tag).trim()] });
            toast(`🏷 已给整组添加标签（当前组内标签：${r.tags.join('、') || '无'}）`);
            await openMediaDetail(target);
            break;
          }
          default: break;
        }
      } catch (err) {
        toast(err.message, true);
      }
    });

    // 标签输入框回车 = 添加（单条 message 或整组）
    dlg.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const input = e.target;
      if (!input.dataset) return;
      e.preventDefault();
      try {
        if (input.dataset.role === 'tag-input') {
          const block = input.closest('.msg-block');
          const file = block.querySelector('[data-action="tag-add"]').dataset.file;
          const tag = input.value.trim();
          if (tag) await applyMediaTags(file, { add: [tag] });
        } else if (input.dataset.role === 'group-tag-input') {
          const tag = input.value.trim();
          const groupId = state.detail && state.detail.group ? state.detail.group.group_id : null;
          if (tag && groupId) {
            const r = await apiPost('/media/tags', { groupId, add: [tag] });
            toast(`🏷 已给整组添加标签（当前组内标签：${r.tags.join('、') || '无'}）`);
            await openMediaDetail(groupId);
          }
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  /** 修改 group_list.is_delete：时间戳=可清理，0=保留 */
  async function setGroupCleanable(groupId, cleanable) {
    await apiPost('/db/execute', {
      operation: {
        action: 'update',
        collection: 'group_list',
        filter: { group_id: groupId },
        data: { is_delete: cleanable ? Date.now() : 0 }
      }
    });
    toast(cleanable ? '🟠 已标记为可清理' : '🟢 已标记为保留');
    const dlg = $('#detail-dialog');
    if (dlg.open) dlg.close();
    await refreshCurrent();
  }

  /* ---------------- 选项与快捷键 ---------------- */

  function bindOptions() {
    $('#nav').addEventListener('click', (e) => {
      const btn = e.target.closest('.nav-item');
      if (btn) show(btn.dataset.view);
    });
    $('#refresh-btn').addEventListener('click', () => refreshCurrent());
    $('#dock-toggle').addEventListener('click', () => $('#app-view').classList.toggle('dock-collapsed'));
    $('#log-collapse').addEventListener('click', () => $('#app-view').classList.add('dock-collapsed'));
    $('#theme-btn').addEventListener('click', cycleTheme);
    $('#logout-btn').addEventListener('click', () => logout());
    $('#palette-btn').addEventListener('click', openPalette);
    $('#palette-close').addEventListener('click', closePalette);
    $('#palette').addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      const action = el ? el.dataset.action : (e.target.dataset.close !== undefined ? 'palette-close' : null);
      switch (action) {
        case 'palette-example':
          $('#palette-prompt').value = el.dataset.text || '';
          $('#palette-prompt').focus();
          break;
        case 'palette-close':
          closePalette();
          break;
        default:
          break;
      }
    });
    $('#palette-translate').addEventListener('click', translatePrompt);
    $('#palette-exec').addEventListener('click', executePlan);
    $('#palette-prompt').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); translatePrompt(); }
    });

    // 表单对话框
    $('#form-ok').addEventListener('click', submitForm);
    $('#form-cancel').addEventListener('click', () => { formSubmit = null; $('#form-dialog').close(); });
    $('#form-body').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitForm(); }
    });
    $('#form-dialog').addEventListener('close', () => { formSubmit = null; });

    $('#log-pause').addEventListener('click', () => {
      state.logPaused = !state.logPaused;
      $('#log-pause').textContent = state.logPaused ? '▶' : '⏸';
    });
    $('#log-clear').addEventListener('click', () => {
      state.logBuffer = [];
      $('#log-list').innerHTML = '';
      renderLogList();
    });

    document.addEventListener('keydown', (e) => {
      const active = document.activeElement || {};
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || '') || active.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
      if (typing) return;
      if (e.key === '/') { e.preventDefault(); const el = $('#global-search'); if (el && !el.closest('.hidden')) el.focus(); }
      else if (e.key === 'r' || e.key === 'R') { refreshCurrent(); }
      else if (e.key === 'Escape') { closePalette(); }
    });
  }

  /* ============================ 登录 / 启动 ============================ */

  async function login() {
    const password = $('#login-password').value;
    if (!password) return;
    try {
      const res = await fetch(API + '/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json().catch(() => ({}));
      if (!data.token) throw new Error(data.error || '登录失败');
      localStorage.setItem(TOKEN_KEY, data.token);
      await enterApp();
    } catch (err) {
      const el = $('#login-error');
      el.textContent = err.message;
      el.classList.remove('hidden');
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    stopLogStream();
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
  }

  async function enterApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    try {
      const data = await apiGet('/db/collections');
      state.collections = data.collections || [];
      await loadOverview().catch(() => { });
      // 标签库用于媒体详情里的标签推荐，进入应用时预热
      apiGet('/tags').then(d => { state.tags = d.tags || []; }).catch(() => { });
      startLogStream();
      await show('overview');
    } catch (err) {
      toast(err.message, true);
    }
  }

  function init() {
    applyTheme(themeMode());
    bindSearch();
    bindAutoRefresh();
    bindOptions();
    bindViewEvents();
    bindDetailEvents();
    $('#login-btn').addEventListener('click', login);
    $('#login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
    if (token()) enterApp();
  }

  init();
})();
