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
  const SEARCH_VIEWS = ['media', 'users', 'tags', 'transport', 'articles', 'collections']; // 支持顶部搜索的视图
  const SEARCH_PLACEHOLDER = {
    media: '搜索描述 / 标签，回车查询',
    users: '搜索用户名 / ID，回车查询',
    tags: '过滤标签名',
    transport: '搜索名称 / 链接 / chat_id',
    articles: '搜索文章标题 / 链接',
    collections: '搜索合集名称'
  };
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
    transport: { q: '', status: 'all', page: 1, pageSize: 20, total: 0, totalPages: 1, items: [], counts: { all: 0, alive: 0, dead: 0, unchecked: 0 } },
    articles: { q: '', page: 1, pageSize: 20, total: 0, totalPages: 1, items: [] },
    collections: [],                       // 「原始数据」/ AI 面板用的集合名列表
    collectionsView: { q: '', type: 'all', items: [], counts: { all: 0, collection: 0, misc: 0 } }, // 「合集 / 杂集」视图数据
    dbstats: { data: null },
    random: {
      types: [], tags: [], tagMode: 'any', q: '', duration: 'all', scope: 'all', count: 6,
      items: [], total: 0
    },
    stats: { year: new Date().getFullYear(), metric: 'all', data: null },
    oplogs: { page: 1, pageSize: 30, total: 0, totalPages: 1, items: [], category: 'all', result: 'all', q: '' },
    selectedRaw: null,
    detail: null,
    detailSelectedFile: null,          // 媒体详情里当前选中的媒体（决定哪条标签可改）
    detailTag: null,                   // 标签详情里当前查看的标签（异步加载媒体列表时防串台）
    tagsMode: 'normal',                // 标签视图模式：normal | delete | sort
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

  /* ---------------- 预览图悬停放大（媒体库卡片 / 媒体详情条） ----------------
     缩略图用 object-fit: cover 裁切显示，鼠标移上去时：
       1) 缩略图本身切到 contain，不再裁切；
       2) 在旁边弹出一个固定定位的浮层，用完整比例的图片展示放大预览（不裁切）。
     浮层挂在 body 上；若此时有对话框打开（原生 dialog 在顶层，挂 body 会被盖住），就挂进该对话框。 */

  const ZOOM_MAX = 460;   // 放大预览最大边长（px）
  const ZOOM_GAP = 14;    // 与缩略图的间距 / 距视口边缘的安全距离
  let zoomLayer = null;   // 浮层元素（懒创建）
  let zoomImg = null;     // 当前正在放大的缩略图

  /** 触屏设备没有 hover，不启用（避免点一下浮层不消失） */
  function hoverEnabled() {
    try {
      return !(window.matchMedia && window.matchMedia('(hover: none)').matches);
    } catch (e) {
      return true;
    }
  }

  /** 从事件目标找到它所属的缩略图 <img>（媒体库卡片 / 详情媒体条） */
  function thumbImgFrom(target) {
    if (!target || !target.closest) return null;
    const wrap = target.closest('.media-thumb') || target.closest('.detail-item');
    if (!wrap) return null;
    const img = wrap.querySelector ? wrap.querySelector('img') : null;
    return img && img.src ? img : null;
  }

  /** 浮层挂载点：有打开的对话框就挂进对话框（原生 dialog 在顶层，挂 body 会被盖住），否则挂 body */
  function zoomHost() {
    const dlg = $('#detail-dialog');
    if (dlg && dlg.open) return dlg;
    const anyOpen = document.querySelector ? document.querySelector('dialog[open]') : null;
    if (anyOpen && anyOpen.open !== false) return anyOpen;
    return document.body || document.documentElement;
  }

  function ensureZoomLayer() {
    if (!zoomLayer) {
      zoomLayer = document.createElement('div');
      zoomLayer.className = 'thumb-zoom';
      zoomLayer.innerHTML = '<img alt="">';
    }
    const host = zoomHost();
    if (zoomLayer.parentElement !== host) host.appendChild(zoomLayer);
    return zoomLayer;
  }

  /** 弹出放大预览（整图可见） */
  function showThumbZoom(img) {
    if (!hoverEnabled()) return;
    const rect = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
    if (!rect || !rect.width || !rect.height) return;
    const right = rect.right === undefined ? rect.left + rect.width : rect.right;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    // 原图宽高比（拿不到原始尺寸时退回缩略图比例）
    const ratio = (img.naturalWidth && img.naturalHeight)
      ? img.naturalWidth / img.naturalHeight
      : rect.width / rect.height;
    const maxW = Math.max(180, Math.min(ZOOM_MAX, Math.round(vw * 0.6)));
    const maxH = Math.max(180, Math.min(ZOOM_MAX, Math.round(vh * 0.72)));
    let w = maxW;
    let h = Math.round(w / ratio);
    if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
    // 位置：优先贴在缩略图右侧，右边放不下改放左侧，最后夹进视口内
    let left = right + ZOOM_GAP;
    if (left + w > vw - ZOOM_GAP) left = rect.left - ZOOM_GAP - w;
    if (left < ZOOM_GAP) left = Math.max(ZOOM_GAP, Math.min(vw - w - ZOOM_GAP, rect.left + rect.width / 2 - w / 2));
    let top = rect.top + rect.height / 2 - h / 2;
    top = Math.max(ZOOM_GAP, Math.min(vh - h - ZOOM_GAP, top));

    const layer = ensureZoomLayer();
    const view = layer.querySelector('img');
    if (view && view.src !== img.src) view.src = img.src;
    layer.style.left = `${Math.round(left)}px`;
    layer.style.top = `${Math.round(top)}px`;
    layer.style.width = `${w}px`;
    layer.style.height = `${h}px`;
    layer.classList.add('is-on');
    zoomImg = img;
  }

  function hideThumbZoom() {
    zoomImg = null;
    if (zoomLayer) zoomLayer.classList.remove('is-on');
  }

  /** 绑定悬停放大：媒体库 #view 与媒体详情对话框都要有（对话框在顶层，不在 #view 内） */
  function bindThumbZoomEvents(root) {
    if (!root || !root.addEventListener) return;
    root.addEventListener('mouseover', (e) => {
      const img = thumbImgFrom(e.target);
      if (!img || img === zoomImg) return;
      showThumbZoom(img);
    });
    root.addEventListener('mouseout', (e) => {
      const img = thumbImgFrom(e.target);
      if (!img || img !== zoomImg) return;
      const to = e.relatedTarget;
      // 在同一条预览内部移动（缩略图 → 徽标 / 说明）不算离开
      if (to && img.parentElement && img.parentElement.contains && img.parentElement.contains(to)) return;
      hideThumbZoom();
    });
    // 滚动 / 点击后缩略图位置会变，直接收起
    root.addEventListener('scroll', hideThumbZoom, true);
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
  /** 字节数 → 人类可读（B / KB / MB / GB）；null 返回 '—' */
  function fmtBytes(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    if (v < 1024) return `${v} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let val = v / 1024;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val >= 100 ? val.toFixed(0) : val.toFixed(val >= 10 ? 1 : 2)} ${units[i]}`;
  }

  /** 与 fmtBytes 相同，但固定保留两位小数（集合明细等需要精确读数的列） */
  function fmtBytesFixed(n, digits = 2) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    if (v < 1024) return `${v.toFixed(digits)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let val = v / 1024;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(digits)} ${units[i]}`;
  }
  function shortId(id, len = 22) {
    const s = String(id ?? '');
    return s.length > len ? s.slice(0, len) + '…' : s;
  }
  function typeIcon(t) { return (TYPE_META[t] || { icon: '📎' }).icon; }
  function typeLabel(t) { return (TYPE_META[t] || { label: t || '未知' }).label; }
  /** 预览图右下角的文件类型角标：图片 / 视频 / 音频 / 文件（未知类型不显示） */
  function typeBadgeHtml(mediaType) {
    if (!mediaType || !TYPE_META[mediaType]) return '';
    return `<span class="thumb-type" title="${esc(typeLabel(mediaType))}">${typeIcon(mediaType)} ${esc(typeLabel(mediaType))}</span>`;
  }
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
    // 数据库占用（失败不影响概览；服务端有缓存，不会每次打库）
    state.dbstats.data = await apiGet('/db-stats').catch(() => state.dbstats.data);
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

  async function loadTransport() {
    const t = state.transport;
    const params = new URLSearchParams({ status: t.status, page: String(t.page), pageSize: String(t.pageSize) });
    if (t.q) params.set('q', t.q);
    const data = await apiGet('/transport?' + params.toString());
    t.items = data.items || [];
    t.total = data.total || 0;
    t.page = data.page || 1;
    t.totalPages = data.totalPages || 1;
    t.counts = data.counts || t.counts;
    return data;
  }

  async function loadArticles() {
    const a = state.articles;
    const params = new URLSearchParams({ withSubs: '1', page: String(a.page), pageSize: String(a.pageSize) });
    if (a.q) params.set('q', a.q);
    const data = await apiGet('/articles?' + params.toString());
    a.items = data.items || [];
    a.total = data.total || 0;
    a.page = data.page || 1;
    a.totalPages = data.totalPages || 1;
    return data;
  }

  async function loadCollections() {
    const c = state.collectionsView;
    const params = new URLSearchParams({ withSubs: '1', type: c.type });
    if (c.q) params.set('q', c.q);
    const data = await apiGet('/collections?' + params.toString());
    c.items = data.items || [];
    c.counts = data.counts || c.counts;
    c.subTotal = data.subTotal || 0;
    return data;
  }

  async function loadDbStats(force = false) {
    const data = await apiGet('/db-stats' + (force ? '?force=1' : ''));
    state.dbstats.data = data;
    return data;
  }

  async function loadRaw() {
    const r = state.raw;
    // 「全部数据库」不再拉跨集合数据：集合明细表已列出全部集合，点行/下拉选择即可浏览
    if (r.collection === ALL_KEY) {
      r.groups = [];
      r.items = [];
      r.total = 0;
      r.totalPages = 1;
      return { all: true, groups: [] };
    }
    const data = await apiPost('/db/query', {
      collection: r.collection,
      filter: {},
      sort: { _id: r.sort },
      page: r.page,
      pageSize: r.pageSize
    });
    if (data.all) {
      // 兜底：后端返回跨集合结构时也不展示（视图只浏览单个集合）
      r.groups = [];
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
    // 报表统一按「年」统计：方格图与图表都覆盖整年（年份由顶栏 ◀ ▶ 切换）
    const params = new URLSearchParams({ period: 'year', year: String(s.year) });
    const [report] = await Promise.all([apiGet('/stats?' + params.toString()), loadOpLogs()]);
    s.data = report;
    return report;
  }

  /** 随机推荐：按当前筛选条件抽一批（类型 / 标签 / 关键词 / 时长 / 范围 / 数量） */
  async function loadRandom() {
    const r = state.random;
    const params = new URLSearchParams({ count: String(r.count) });
    if (r.types.length) params.set('types', r.types.join(','));
    if (r.tags.length) {
      params.set('tags', r.tags.join(','));
      params.set('tagMode', r.tagMode);
    }
    if (r.q) params.set('q', r.q);
    if (r.duration && r.duration !== 'all') params.set('duration', r.duration);
    if (r.scope && r.scope !== 'all') params.set('scope', r.scope);
    const [data] = await Promise.all([
      apiGet('/random?' + params.toString()),
      (state.tags && state.tags.length)
        ? Promise.resolve()
        : apiGet('/tags').then(d => { state.tags = d.tags || []; }).catch(() => { })
    ]);
    r.items = data.items || [];
    r.total = data.total || 0;
    return data;
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

  /** 字节类统计卡：值用 fmtBytes 渲染（statCard 会走千分位，不适合字节） */
  function sizeCard(k, bytes, s, cls = '') {
    return `<div class="stat ${cls}">
      <div class="k">${k}</div>
      <div class="v">${fmtBytes(bytes)}</div>
      ${s ? `<div class="s">${esc(s)}</div>` : ''}
    </div>`;
  }

  function renderOverview() {
    const o = state.overview || {};
    const c = o.counts || {};
    const byType = o.mediaByType || {};
    const typeTotal = Object.values(byType).reduce((a, b) => a + b, 0) || 1;
    const typeOrder = ['photo', 'video', 'audio', 'document'];

    const db = state.dbstats.data;
    const dbCard = (db && db.available && db.totals)
      ? sizeCard('🗄 数据库占用', db.totals.storageSize, `${fmtNum(db.totals.objects)} 个文档 · 索引 ${fmtBytes(db.totals.indexSize)}`)
      : statCard('🗄 数据库占用', null, db && db.reason ? '当前套餐不可读取大小' : '统计中…', 'is-warn');

    const stats = [
      statCard('🖼 媒体总数', c.media, `共 ${fmtNum(c.groupList)} 个媒体组`),
      statCard('📝 有描述', c.kept, `占 ${c.groupList ? Math.round((c.kept / c.groupList) * 100) : 0}%`),
      statCard('🧹 可清理组', c.cleanable, '空描述 · 可被 /clean 清理', 'is-warn'),
      statCard('👥 用户', c.users, `白名单 ${fmtNum(c.whitelist)} · 封禁 ${fmtNum(c.banned)}`),
      statCard('🏷 标签', c.tags, '独立标签库'),
      statCard('📢 群组 / 频道', c.chats, `绑定对 ${fmtNum(c.bound)}`),
      statCard('📊 操作日志', c.logs, '累计记录'),
      dbCard
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
            <button class="chip" data-action="goto" data-view="transport">🚚 搬运收录</button>
            <button class="chip" data-action="goto" data-view="articles">📄 文章</button>
            <button class="chip" data-action="goto" data-view="collections">📚 合集</button>
            <button class="chip" data-action="goto" data-view="raw">🗄 数据库</button>
            <button class="chip" data-action="goto" data-view="stats">📈 统计报表</button>
            <button class="chip" data-action="palette">🧠 AI 翻译</button>
          </div>
        </div>
      </div>`;
  }

  /* ============================ 视图：媒体库 ============================ */

  /**
   * 媒体组卡片（媒体库 / 标签详情共用同一套方块界面）
   * @param {Object} item - /api/media 返回的媒体组
   * @param {string} action - data-action 名（媒体库用 open-media；详情对话框内用 tag-media-open）
   */
  function mediaCard(item, action = 'open-media') {
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

    return `<article class="media-card" data-action="${esc(action)}" data-group="${esc(item.group_id)}">
      <div class="media-thumb">
        ${thumb}
        ${typeBadgeHtml(p ? p.media_type : null)}
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
      ? `<div class="media-grid">${m.items.map(it => mediaCard(it)).join('')}</div>`
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
    const mode = state.tagsMode || 'normal';
    // 排序模式忽略搜索过滤：拖拽顺序必须是完整的标签顺序
    const tags = mode === 'sort' ? state.tags.slice() : state.tags.filter(t => !q || t.name.toLowerCase().includes(q));
    const maxUse = Math.max(1, ...state.tags.map(t => t.usage || 0));
    const pinnedCount = state.tags.filter(t => t.pin > 0).length;

    const cards = tags.map(t => {
      const cls = ['tag-card'];
      if (mode === 'delete') cls.push('is-deleting');
      const action = mode === 'delete' ? 'tag-delete' : (mode === 'sort' ? '' : 'tag-card-open');
      const title = mode === 'sort' ? '按住拖动调整顺序'
        : (mode === 'delete' ? '点击删除该标签' : '点击查看标签详情 / 置顶状态');
      return `<div class="${cls.join(' ')}"${action ? ` data-action="${action}"` : ''} data-tag="${esc(t.name)}"
           ${mode === 'sort' ? 'draggable="true"' : ''} title="${title}">
        <div class="top">
          <span class="name" title="${esc(t.name)}">${esc(t.name)}</span>
          ${mode === 'sort'
          ? '<span class="drag-hint">☰ 拖动</span>'
          : (t.pin > 0 ? `<span class="tag accent pin-badge">📍 置顶 ${t.pin}</span>` : '')}
        </div>
        <div class="bar"><i style="width:${Math.round(((t.usage || 0) / maxUse) * 100)}%"></i></div>
        <div class="stat-row">
          <span>使用 <span class="mono">${fmtNum(t.usage)}</span> 次</span>
          <span>计数 <span class="mono">${fmtNum(t.count)}</span></span>
        </div>
      </div>`;
    }).join('');

    $('#view').innerHTML = `
      <div class="toolbar">
        <button class="btn btn-sm" data-action="tag-create">➕ 添加标签</button>
        <button class="btn btn-sm ${mode === 'delete' ? 'btn-danger' : ''}" data-action="tag-mode" data-mode="delete">🗑️ 删除标签</button>
        <button class="btn btn-sm ${mode === 'sort' ? 'btn-primary' : ''}" data-action="tag-mode" data-mode="sort">⭐ 置顶排序</button>
        ${mode === 'sort'
        ? '<button class="btn btn-primary btn-sm" data-action="tag-sort-save">💾 保存排序</button><button class="btn btn-ghost btn-sm" data-action="tag-sort-cancel">取消</button>'
        : ''}
        <span class="grow"></span>
        <span class="dim">共 ${fmtNum(state.tags.length)} 个标签 · 置顶 ${fmtNum(pinnedCount)} 个${q && mode !== 'sort' ? ` · 过滤出 ${fmtNum(tags.length)} 个` : ''}</span>
      </div>
      ${mode === 'sort' ? '<div class="tag-hint">☰ 按住卡片拖动调整顺序（已忽略搜索过滤），松手后点「💾 保存排序」写入置顶位置：顺序 = 置顶 1..N，最多 40 个</div>' : ''}
      ${mode === 'delete' ? '<div class="tag-hint">🗑️ 删除模式：点击卡片删除该标签，会同步从所有消息里移除；再点一次「🗑️ 删除标签」退出该模式</div>' : ''}
      ${mode === 'normal' ? '<div class="tag-hint">💡 点击标签卡片查看详情（顶栏可一键切换置顶）；「⭐ 置顶排序」可拖动排序</div>' : ''}
      ${tags.length ? `<div class="tag-grid${mode === 'sort' ? ' is-sorting' : ''}">${cards}</div>` : '<div class="empty"><div class="empty-ico">🏷</div><div>没有标签</div></div>'}`;
    updatePageSub(`共 ${fmtNum(state.tags.length)} 个标签 · 置顶 ${fmtNum(pinnedCount)} 个`);
  }

  /** 重新拉取标签库并重渲染当前视图 */
  async function reloadTags() {
    const d = await apiGet('/tags');
    state.tags = d.tags || [];
  }

  /**
   * 标签详情（复用详情对话框）：
   * 顶栏显示置顶状态（点击切换），正文直接列出该标签下的媒体组（无需再跳转媒体库）
   */
  function openTagDetail(name) {
    const tag = state.tags.find(t => t.name === name);
    if (!tag) { toast('标签不存在，请刷新后重试', true); return; }
    state.detailTag = name;
    const pinned = tag.pin > 0;
    const dlg = $('#detail-dialog');
    $('#detail-title').innerHTML = `🏷 ${esc(tag.name)}`;
    // 正文一次渲染：顶部信息 + 媒体列表区（列表异步填充同一段 HTML，避免子元素引用失效）
    $('#detail-body').innerHTML = tagDetailHtml(tag, pinned, '<div class="loading">正在加载媒体…</div>');
    $('#detail-foot').innerHTML = `
      <button class="btn btn-primary btn-sm" data-action="tag-detail-media" data-tag="${esc(tag.name)}">🖼 在媒体库中筛选</button>
      <span class="spacer"></span>
      <button class="btn btn-soft-danger btn-sm" data-action="tag-detail-delete" data-tag="${esc(tag.name)}">🗑 删除标签</button>
      <button class="btn btn-ghost btn-sm" data-action="detail-close">关闭</button>`;
    if (!dlg.open) dlg.showModal();
    loadTagMediaInto(name);
  }

  /** 标签详情正文（媒体区内容由异步加载后整体重渲染） */
  function tagDetailHtml(tag, pinned, mediaSection) {
    return `
      <div class="toolbar">
        <button class="chip ${pinned ? 'is-active' : ''}" data-action="tag-detail-pin" data-tag="${esc(tag.name)}"
                title="点击${pinned ? '取消置顶' : '置顶该标签'}">${pinned ? `📍 已置顶（位置 ${tag.pin}） · 点击取消` : '⭐ 未置顶 · 点击置顶'}</button>
        <span class="spacer"></span>
        <span class="dim">标签库 <code>tags</code></span>
      </div>
      <div class="stats">
        ${statCard('📎 被引用', tag.usage, '含该标签的消息条数')}
        ${statCard('🔢 使用计数', tag.count, '打标签 +1 / 移除 -1')}
        ${statCard('📍 置顶位置', pinned ? tag.pin : null, pinned ? '按钮网格位置（每行 4 个）' : '未置顶')}
      </div>
      <div class="section" style="margin-top:14px">
        <h4>该标签下的媒体组</h4>
        ${mediaSection}
      </div>
      <div class="callout" style="margin-top:14px"><span>🏷</span><div>标签名统一大写；删除会同步从所有消息的 <code>tags</code> 中移除。</div></div>`;
  }

  /** 标签详情里的媒体组列表：与「媒体库」一致的方块卡片，点击直接打开媒体详情 */
  async function loadTagMediaInto(name, limit = 12) {
    let section;
    try {
      const d = await apiGet(`/media?scope=all&tag=${encodeURIComponent(name)}&page=1&pageSize=${limit}`);
      const items = d.items || [];
      section = items.length
        ? `<div class="dim" style="font-size:11.5px;margin-bottom:10px">共 <b>${fmtNum(d.total)}</b> 个媒体组带该标签，此处显示最近 ${items.length} 个 · 点卡片直接打开媒体详情</div>
           <div class="media-grid">${items.map(it => mediaCard(it, 'tag-media-open')).join('')}</div>
           ${d.total > items.length ? `<div class="dim" style="margin-top:10px;font-size:11.5px">还有 ${fmtNum(d.total - items.length)} 个未显示，可点下方「🖼 在媒体库中筛选」查看全部</div>` : ''}`
        : '<div class="empty">还没有任何媒体组使用该标签</div>';
    } catch (err) {
      section = `<div class="empty">❌ ${esc(err.message)}</div>`;
    }
    // 期间可能已经切到别的标签 / 打开媒体详情，避免把旧结果写进新内容
    if (state.detailTag !== name) return;
    const tag = state.tags.find(t => t.name === name);
    if (!tag) return;
    $('#detail-body').innerHTML = tagDetailHtml(tag, tag.pin > 0, section);
  }

  /** 切换标签置顶：置顶时取下一个空位（1..40），已置顶则取消 */
  async function toggleTagPin(name) {
    const tag = state.tags.find(t => t.name === name);
    if (!tag) return;
    let pin = 0;
    if (!(tag.pin > 0)) {
      const maxPin = Math.max(0, ...state.tags.map(t => t.pin || 0));
      if (maxPin >= 40) { toast('置顶位置已满（最多 40 个）', true); return; }
      pin = maxPin + 1;
    }
    const r = await apiPost('/tags/pin', { name, pin });
    toast(pin > 0 ? `📍 「${name}」已置顶到位置 ${pin}` : `已取消「${name}」的置顶`);
    await reloadTags();
    if (state.view === 'tags') renderTags();
    openTagDetail(name);
  }

  async function createTag() {
    openForm({
      title: '添加标签',
      okText: '创建',
      fields: [{ key: 'name', label: '标签名', required: true, hint: '最长 20 个字符，自动转大写；重名会被拒绝' }],
      onSubmit: async (v) => {
        const name = String(v.name || '').trim();
        if (!name) { toast('请输入标签名', true); return; }
        await apiPost('/tags/create', { name });
        toast(`✅ 标签「${name.toUpperCase()}」已创建`);
        await reloadTags();
        if (state.view === 'tags') renderTags();
      }
    });
  }

  async function deleteTag(name) {
    const tag = state.tags.find(t => t.name === name);
    const ok = await confirmDialog({
      title: '删除标签',
      body: `<div>确定删除标签 <b>${esc(name)}</b> 吗？</div>
             <div class="dim" style="margin-top:8px">会同步从 ${fmtNum(tag ? tag.usage : 0)} 条消息中移除该标签，且不可恢复。</div>`,
      okText: '确认删除'
    });
    if (!ok) return;
    const r = await apiPost('/tags/delete', { name, confirm: true });
    toast(`🗑 标签已删除${r.synced ? `（同步清理 ${r.synced} 条消息）` : ''}`);
    await reloadTags();
    if (state.view === 'tags') renderTags();
  }

  /** 保存拖拽后的置顶顺序 */
  async function saveTagOrder() {
    const names = [...$('#view').querySelectorAll('.tag-card')].map(el => el.dataset.tag).filter(Boolean);
    if (!names.length) { toast('没有可保存的顺序', true); return; }
    const r = await apiPost('/tags/reorder', { names });
    toast(`✅ 排序已保存（${fmtNum(r.updated)} 个标签写入置顶位置）`);
    state.tagsMode = 'normal';
    await reloadTags();
    if (state.view === 'tags') renderTags();
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

  /* ---------- 每日操作量：GitHub 贡献方格 ---------- */

  const CG_DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

  /** UTC 毫秒 → 北京时间 'YYYY-MM-DD' */
  function cgDayKey(ms) {
    return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  /** 格林威治星期（0=周日）→ 以周一为首列的索引 */
  function cgWeekIndex(dow) {
    return (dow + 6) % 7;
  }

  /**
   * 生成方格日历所需的自然日列表（整年：当年每一天 + 首尾周补齐的空格）
   * @param {number} year
   * @returns {Array<string|null>} 7 的整数倍，每 7 个为一列（周一→周日）
   */
  function cgBuildDays(year) {
    const days = [];
    const start = new Date(Date.UTC(year, 0, 1)).getUTCDay();
    for (let i = 0; i < cgWeekIndex(start); i++) days.push(null);
    for (let m = 1; m <= 12; m++) {
      const total = new Date(Date.UTC(year, m, 0)).getUTCDate();
      for (let d = 1; d <= total; d++) days.push(cgDayKey(Date.UTC(year, m - 1, d)));
    }
    while (days.length % 7 !== 0) days.push(null);
    return days;
  }

  /**
   * 按操作量分级（GitHub 式 5 档）：
   * 0 = 空格底；其余按区间等分，量越大色越深（全部相同时统一 lv4）
   * @param {number} count
   * @param {number} max
   * @returns {number} 0-4
   */
  function cgLevel(count, max) {
    if (!count || count <= 0) return 0;
    if (!max || max <= 0) return 1;
    if (count >= max) return 4;
    const step = max / 4;
    return Math.min(4, Math.floor((count - 1) / step) + 1);
  }

  /** 查看项的中文名与单位（方格图图例 / 悬停提示用） */
  function cgMetricMeta(metric, d) {
    if (metric === 'media') return { label: '媒体', unit: '个' };
    if (metric && metric.startsWith('action:')) {
      const key = metric.slice(7);
      const row = (((d || {}).byAction) || []).find(a => a.action === key);
      return { label: row ? row.label : key, unit: '次' };
    }
    if (metric && metric.startsWith('category:')) {
      const key = metric.slice(9);
      const cat = ((d || {}).catalog && d.catalog.categories) || {};
      return { label: cat[key] || key, unit: '次' };
    }
    return { label: '操作', unit: '次' };
  }

  /**
   * 方格「查看项」取值：默认全部操作；可按系统指标（媒体数）、大类、单个动作（如 mark）单独看
   * @param {Object} row - 服务端 byDay 的一行 { day, count, media, groups, actions, categories }
   * @param {string} metric - 'all' | 'media' | 'action:<key>' | 'category:<key>'
   * @returns {number}
   */
  function cgMetricValue(row, metric) {
    if (!row) return 0;
    if (!metric || metric === 'all') return row.count || 0;
    if (metric === 'media') return row.media || 0;
    if (metric.startsWith('action:')) return (row.actions && row.actions[metric.slice(7)]) || 0;
    if (metric.startsWith('category:')) return (row.categories && row.categories[metric.slice(9)]) || 0;
    return 0;
  }

  /** 方格总览（统计报表「每日操作量」）
   * 版面：GitHub 全年贡献图 —— 7 行 = 周一…周日，每列一周，整年铺满；列宽自适应撑满卡片
   * @param {number} year
   * @param {Array} byDay - 服务端聚合的每日数据 [{day, count, media, actions, categories}]
   * @param {string} [metric] - 查看项（'all' 默认全部操作 / 'media' / 'action:xxx' / 'category:xxx'）
   * @param {string} [metricLabel] - 查看项名称（悬停提示与图例用）
   * @param {string} [metricUnit] - 单位（次 / 个）
   */
  function contribGridHtml(year, byDay, metric = 'all', metricLabel = '操作', metricUnit = '次') {
    const rows = cgBuildDays(year);
    const map = new Map((byDay || []).map(x => [x.day, x]));
    const valueOf = (row) => cgMetricValue(row, metric);
    const max = Math.max(0, ...(byDay || []).map(x => valueOf(x)));
    const cols = Math.max(1, rows.length / 7);
    const cells = rows.map(day => {
      if (!day) return '<i class="cg-cell" data-empty="1" title=""></i>';
      const row = map.get(day) || { count: 0, media: 0 };
      const value = valueOf(row);
      const lv = cgLevel(value, max);
      const title = `${day} 周${CG_DAY_LABELS[cgWeekIndex(new Date(day + 'T00:00:00Z').getUTCDay())]} · ${metricLabel} ${value} ${metricUnit} · 当天共 ${row.count || 0} 次操作 · ${row.media || 0} 个媒体`;
      return `<i class="cg-cell${lv ? ` lv${lv}` : ''}" title="${esc(title)}"></i>`;
    }).join('');

    // 每列上方标注月份（该列 7 天里首次出现的「1 号」或当年首日）
    const labels = [];
    for (let c = 0; c < cols; c++) {
      let label = '';
      for (const d of rows.slice(c * 7, c * 7 + 7)) {
        if (!d) continue;
        const mm = Number(d.slice(5, 7));
        if (d.endsWith('-01') || d === `${year}-01-01`) { label = `${mm}月`; break; }
      }
      labels.push(`<span>${label}</span>`);
    }

    const legend = `<div class="cg-leg">
      <span>少</span>
      <i></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i>
      <span>多</span>
      <span class="cg-tip">最高 ${fmtNum(max)} ${metricUnit}/天 · 色深随${metricLabel}递增</span>
    </div>`;

    return `<div class="cg-wrap">
      <div class="cg-months">${labels.join('')}</div>
      <div class="cg-row">
        <div class="cg-days">${CG_DAY_LABELS.map(l => `<span>${l}</span>`).join('')}</div>
        <div class="cg-grid">${cells}</div>
      </div>
      ${legend}
    </div>`;
  }

  /**
   * 活跃时间：北京时间每小时操作量（24 根柱，绿色 = 高峰）
   * 高度用「行 = 1fr」精确换算比例，柱顶不会因 flex 收缩而失真；0 次的小时用底色短桩区分
   */
  function hourChartHtml(byHour) {
    const hours = Array.from({ length: 24 }, (_, h) => {
      const found = (byHour || []).find(x => Number(x.hour) === h);
      return found ? { hour: h, count: found.count || 0, media: found.media || 0 } : { hour: h, count: 0, media: 0 };
    });
    const max = Math.max(0, ...hours.map(x => x.count));
    const ranked = hours.slice().sort((a, b) => b.count - a.count);
    const peak = ranked[0] || { hour: 0, count: 0 };
    const second = ranked[1] || { hour: 0, count: 0 };
    const total = hours.reduce((sum, x) => sum + x.count, 0);

    const bars = hours.map(x => {
      const h = max > 0 && x.count > 0 ? Math.max(3, Math.round((x.count / max) * 100)) : 0;
      const isPeak = max > 0 && x.count > 0 && x.count === peak.count;
      const label = `${String(x.hour).padStart(2, '0')}:00`;
      const cls = ['col'];
      if (isPeak) cls.push('is-peak');
      if (x.count === 0) cls.push('is-zero');
      if (x.hour % 6 === 0) cls.push('is-group');
      return `<div class="${cls.join(' ')}" title="${label} · ${x.count} 次操作 · ${x.media} 个媒体">
        <span class="v">${isPeak ? fmtNum(x.count) : ''}</span>
        <i style="height:${x.count > 0 ? h : 0}%"></i>
        <span class="h">${String(x.hour).padStart(2, '0')}</span>
      </div>`;
    }).join('');

    let summary;
    if (max > 0) {
      const share = total > 0 ? Math.round((peak.count / total) * 100) : 0;
      const pad = (n) => String(n).padStart(2, '0');
      summary = `高峰 ${pad(peak.hour)}:00 · ${fmtNum(peak.count)} 次（占 ${share}%）`;
      if (second.count > 0 && second.count !== peak.count) summary += ` · 次高 ${pad(second.hour)}:00 · ${fmtNum(second.count)} 次`;
    } else {
      summary = '本期没有操作记录';
    }
    return { bars, summary };
  }

  function renderStats() {
    const s = state.stats;
    const d = s.data;
    if (!d) { $('#view').innerHTML = '<div class="loading">正在统计…</div>'; return; }

    const t = d.totals || {};
    const prev = d.previous || {};

    const cards = [
      `<div class="report-card"><div class="label">📊 操作总数</div><div class="value">${fmtNum(t.operations)}</div>${deltaHtml(prev.operationsDelta)}</div>`,
      `<div class="report-card"><div class="label">🖼 收录/发送媒体</div><div class="value">${fmtNum(t.media || 0)}</div>${deltaHtml(prev.mediaDelta)}</div>`,
      `<div class="report-card"><div class="label">🗂 媒体组产出</div><div class="value">${fmtNum(t.groups || 0)}</div><div class="sub">含收录、发送、回复</div></div>`,
      `<div class="report-card"><div class="label">📅 活跃天数</div><div class="value">${fmtNum(t.activeDays || 0)}</div><div class="sub">日均 ${t.avgPerDay || 0} 次操作</div></div>`,
      `<div class="report-card"><div class="label">⚠️ 失败操作</div><div class="value">${fmtNum((d.failures && d.failures.count) || 0)}</div><div class="sub">${d.failures && d.failures.count ? '可在下方日志中查看原因' : '全部成功'}</div></div>`
    ].join('');

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

    const hourChart = hourChartHtml(d.byHour);

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

    // 每日操作量「查看项」：默认全部操作；可按大类 / 单个动作（如「媒体标记」）单独看
    const metricFixed = [{ v: 'all', l: '全部操作' }, { v: 'media', l: '媒体数' }];
    const metricCategories = Object.entries((d.catalog && d.catalog.categories) || {})
      .map(([k, l]) => ({ v: `category:${k}`, l }));
    const metricActions = (d.byAction || [])
      .map(a => ({ v: `action:${a.action}`, l: `${a.label}（${fmtNum(a.count)}）` }));
    // 切换年份后原来的查看项可能没有数据了 → 回到默认「全部操作」
    const metricAvailable = new Set([...metricFixed, ...metricCategories, ...metricActions].map(x => x.v));
    if (!metricAvailable.has(s.metric)) s.metric = 'all';
    const cgMetric = { value: s.metric, ...cgMetricMeta(s.metric, d) };
    const metricOpt = (x) => `<option value="${esc(x.v)}" ${s.metric === x.v ? 'selected' : ''}>${esc(x.l)}</option>`;
    const metricSelectOptions = [
      metricFixed.map(metricOpt).join(''),
      metricCategories.length ? `<optgroup label="按大类">${metricCategories.map(metricOpt).join('')}</optgroup>` : '',
      metricActions.length ? `<optgroup label="按动作">${metricActions.map(metricOpt).join('')}</optgroup>` : ''
    ].join('');

    $('#view').innerHTML = `
      <div class="toolbar">
        <span class="tag accent">${esc(d.label)}</span>
        <span class="dim">统计区间 ${fmtTime(d.from)} ~ ${fmtTime(d.to)}${d.truncated ? ' · 仅统计最近 20000 条' : ''}</span>
        <span class="grow"></span>
        <span class="year-picker">
          <button class="btn btn-sm" data-action="stats-year-prev" title="上一年" ${s.year <= 2000 ? 'disabled' : ''}>◀</button>
          <b class="year-label">${s.year} 年</b>
          <button class="btn btn-sm" data-action="stats-year-next" title="下一年" ${s.year >= 2100 ? 'disabled' : ''}>▶</button>
        </span>
      </div>
      <div class="report-grid">${cards}</div>
      <div class="card" style="margin-top:16px">
        <div class="card-head">
          <h3>每日操作量</h3>
          <select id="contrib-metric" style="width:auto" title="选择方格图查看项（默认全部操作，可只看某类或某个动作，如「媒体标记」）">
            ${metricSelectOptions}
          </select>
          <span class="dim">每格 = 一天，颜色越深「${esc(cgMetric.label)}」越多（悬停看当天详情）· 7 行 = 周一…周日 · 每列一周</span>
          <span class="spacer"></span>
          <span class="dim">${s.year} 全年</span>
        </div>
        ${contribGridHtml(s.year, d.byDay, cgMetric.value, cgMetric.label, cgMetric.unit)}
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>动作明细</h3><span class="dim">Top 15</span></div>
          ${actionRows}
        </div>
        <div class="card">
          <div class="card-head"><h3>大类分布</h3></div>
          ${categoryRows}
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>活跃用户</h3><span class="dim">按操作次数</span></div>
          <div class="mini-list">${userRows}</div>
        </div>
        <div class="card">
          <div class="card-head">
            <h3>活跃时间</h3>
            <span class="dim">北京时间每小时操作量 · 绿色 = 高峰</span>
          </div>
          <div class="chart">${hourChart.bars}</div>
          <div class="hour-summary">${hourChart.summary}</div>
        </div>
      </div>
      <div class="card stats-logs-card" style="margin-top:16px">
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
      // 「全部数据库」不再列一遍集合文件夹列表（上面「集合明细」表已经列出全部集合，点行即可浏览）
      listHtml = `<div class="empty"><div class="empty-ico">👆</div>
        <div>点上方「集合明细」里的任意一行（或在右上角下拉选集合），即可在下方浏览该集合的原始文档</div></div>`;
    } else {
      listHtml = r.items.length
        ? r.items.map((d, i) => docCard(r.collection, d, i)).join('')
        : '<div class="empty">没有数据</div>';
    }

    $('#view').innerHTML = `
      ${dbToolbarHtml(options, isAll, r)}
      <div class="doc-list">${listHtml}</div>
      ${isAll ? '' : paginationHtml(r, 'raw-page')}`;

    const db = state.dbstats.data;
    updatePageSub(db && db.available && db.totals
      ? `数据库 ${db.database} · ${fmtNum(db.totals.objects)} 个文档 · ${fmtBytes(db.totals.storageSize)} 存储占用 · ${isAll ? '跨集合浏览' : `${r.collection} 共 ${fmtNum(r.total)} 条`}`
      : (isAll ? '跨集合浏览原始文档' : `${r.collection} · 共 ${fmtNum(r.total)} 条`));
  }

  /* ============================ 视图：随机推荐 ============================ */

  const RANDOM_DURATIONS = [
    ['all', '全部时长'], ['<1min', '1 分钟以内'], ['<3min', '3 分钟以内'],
    ['1-5min', '1-5 分钟'], ['5-30min', '5-30 分钟'], ['>30min', '30 分钟以上'], ['>1h', '1 小时以上']
  ];

  /** 随机推荐卡片：单条媒体（点卡片进媒体组详情，↗ 直接跳 Telegram） */
  function randomCardHtml(item) {
    const thumb = item.thumbable
      ? `<img loading="lazy" decoding="async" src="${thumbUrl(item.file_unique_id)}" alt="">`
      : `<span class="ph">${typeIcon(item.media_type)}</span>`;
    const link = item.chat_id && item.message_id
      ? `https://t.me/c/${toLinkChatId(item.chat_id)}/${item.message_id}`
      : null;
    const text = item.text
      ? esc(item.text.length > 90 ? item.text.slice(0, 90) + '…' : item.text)
      : '空描述（可清理）';
    const tags = (item.tags || []).slice(0, 4).map(t => `<span class="tag-pill">${esc(t)}</span>`).join('');
    return `<article class="media-card" data-action="open-media" data-group="${esc(item.group_id)}" title="打开该媒体组详情（可改描述 / 改标签）">
      <div class="media-thumb">
        ${thumb}
        ${typeBadgeHtml(item.media_type)}
        <div class="badges">
          <span class="tag ${item.cleanable ? 'warn' : 'ok'}">${item.cleanable ? '可清理' : '保留'}</span>
          ${item.mark ? `<span class="tag">★ ${fmtNum(item.mark)}</span>` : ''}
        </div>
      </div>
      <div class="media-body">
        <div class="media-text ${item.text ? '' : 'is-empty'}">${text}</div>
        <div class="tags-line">${tags}</div>
        <div class="media-meta">
          <span>${typeIcon(item.media_type)} ${typeLabel(item.media_type)}</span>
          ${item.video_time ? `<span>· ${fmtDuration(item.video_time)}</span>` : ''}
          <span class="spacer"></span>
          ${link ? `<a class="btn btn-ghost btn-xs" href="${link}" target="_blank" rel="noopener" title="在 Telegram 打开">↗</a>` : ''}
        </div>
      </div>
    </article>`;
  }

  function renderRandom() {
    const r = state.random;
    const items = r.items || [];
    const chip = (active, action, data, label) =>
      `<button class="chip ${active ? 'is-active' : ''}" data-action="${action}" ${data}>${label}</button>`;

    const typeChips = Object.keys(TYPE_META)
      .map(t => chip(r.types.includes(t), 'random-type', `data-type="${t}"`, `${typeIcon(t)} ${typeLabel(t)}`))
      .join('') + chip(!r.types.length, 'random-type', 'data-type=""', '全部类型');
    const scopeChips = [['all', '全部'], ['kept', '保留（有描述）'], ['cleanable', '可清理']]
      .map(([v, l]) => chip(r.scope === v, 'random-scope', `data-scope="${v}"`, l)).join('');
    const tagChips = (state.tags || []).slice(0, 30)
      .map(t => chip(r.tags.includes(t.name), 'random-tag', `data-tag="${esc(t.name)}"`, esc(t.name))).join('');
    const durationOptions = RANDOM_DURATIONS
      .map(([v, l]) => `<option value="${v}" ${r.duration === v ? 'selected' : ''}>${l}</option>`).join('');
    const countOptions = [3, 6, 12, 24]
      .map(n => `<option value="${n}" ${r.count === n ? 'selected' : ''}>抽 ${n} 个</option>`).join('');

    const cards = items.length
      ? items.map(randomCardHtml).join('')
      : `<div class="empty"><div class="empty-ico">🎲</div><div>这组条件下一个都没抽到，换个筛选或点「重置条件」再试</div></div>`;

    $('#view').innerHTML = `
      <div class="toolbar">
        <span class="tag accent">🎲 随机推荐</span>
        <span class="dim">候选 ${fmtNum(r.total)} 个 · 本次抽出 ${fmtNum(items.length)} 个</span>
        <span class="grow"></span>
        <button class="btn btn-primary btn-sm" data-action="random-roll">🎲 换一批</button>
        <button class="btn btn-sm" data-action="random-reset">↺ 重置条件</button>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <h3>筛选条件</h3>
          <span class="dim">类型 / 标签 / 关键词 / 时长 / 范围 / 数量 可任意组合（比机器人上的两个随机更自由）</span>
        </div>
        <div class="filter-rows">
          <div class="filter-row"><span class="k">类型</span><div class="chips">${typeChips}</div></div>
          <div class="filter-row"><span class="k">时长</span>
            <select id="random-duration" style="width:auto">${durationOptions}</select>
            <select id="random-count" style="width:auto">${countOptions}</select>
            <span class="dim">时长只对带时长的视频生效</span>
          </div>
          <div class="filter-row"><span class="k">范围</span><div class="chips">${scopeChips}</div></div>
          <div class="filter-row"><span class="k">标签</span>
            <div class="chips">
              ${tagChips || '<span class="dim">标签库为空</span>'}
              ${tagChips ? chip(r.tagMode === 'all', 'random-tagmode', '', r.tagMode === 'all' ? '需同时含全部标签' : '含任一标签') : ''}
            </div>
          </div>
          <div class="filter-row"><span class="k">关键词</span>
            <input id="random-q" value="${esc(r.q)}" placeholder="匹配描述，回车生效" style="flex:1;min-width:180px">
            <button class="btn btn-sm" data-action="random-roll">🔍 抽取</button>
          </div>
        </div>
      </div>
      <div class="media-grid">${cards}</div>`;
    updatePageSub(`随机推荐 · 候选 ${fmtNum(r.total)} 个 · 本次 ${fmtNum(items.length)} 个`);
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

  /* ---------------- 详情：描述与标签区块 ---------------- */

  const TAG_REMOVE_PREFIX = /^[-－−]/;

  /**
   * 解析标签输入（与机器人端 utils/tagUi.js: parseTagInput 同一套规则）
   * 空格 / 、 / , / ， 分隔，可一次输入多个；前缀 `-` 表示移除
   *   `xx yy`      → { add: ['xx','yy'], remove: [] }
   *   `xx -yy -zz` → { add: ['xx'], remove: ['yy','zz'] }
   * 同名同时出现时以移除为准，各自去重（大小写不敏感，保留首现）
   * @param {string} text
   * @returns {{add: string[], remove: string[]}}
   */
  function parseTagInput(text) {
    const add = [];
    const remove = [];
    if (!text || typeof text !== 'string') return { add, remove };
    for (const p of text.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean)) {
      const isRemove = TAG_REMOVE_PREFIX.test(p);
      const name = (isRemove ? p.replace(TAG_REMOVE_PREFIX, '') : p).trim();
      if (!name) continue;
      const bucket = isRemove ? remove : add;
      if (!bucket.some(n => n.toLowerCase() === name.toLowerCase())) bucket.push(name);
    }
    const removed = new Set(remove.map(n => n.toLowerCase()));
    return { add: add.filter(n => !removed.has(n.toLowerCase())), remove };
  }

  /** 提交标签输入：解析出「添加 / 移除」后走 POST /api/media/tags */
  async function submitTagInput(block, file, rawText) {
    const text = String(rawText === undefined || rawText === null ? '' : rawText).trim();
    const { add, remove } = parseTagInput(text);
    if (!add.length && !remove.length) { toast('请输入标签名（多个用空格分隔，-标签 表示移除）', true); return; }
    if (!file) { toast('未找到目标媒体，请重新打开详情', true); return; }
    await applyMediaTags(file, { add, remove });
  }

  /**
   * 单条 message 的描述 + 标签编辑块
   * @param {Object} m - { file_unique_id, text, tags, chat_id, message_id }
   * @param {Object} [opts]
   *   - noRecord: true 表示该媒体还没有文本记录（数据库里没有 message 文档），
   *     保存描述时由后端自动补建 message
   *   - isDraft: true 表示这是「点选无描述媒体」时临时生成的置顶新增块（全局只有一个）
   *   - idx: 原始顺序（重排时用来还原顺序）
   */
  function msgBlockHtml(m, opts = {}) {
    const file = esc(m.file_unique_id);
    const text = m.text || '';
    const tags = m.tags || [];
    const cls = ['msg-block'];
    if (opts.noRecord) cls.push('no-record');
    if (opts.isDraft) cls.push('is-draft');
    const placeholder = opts.isDraft
      ? '输入该媒体的描述，保存后自动建立文本记录'
      : '输入新的描述；留空保存 = 清空描述（该组变为可清理）';
    return `
      <div class="${cls.join(' ')}" data-msg="${file}" data-idx="${opts.idx === undefined ? '' : opts.idx}" data-action="detail-pick" data-file="${file}">
        <div class="text msg-text" data-role="text">${text ? esc(text) : (opts.noRecord ? '（暂无描述 · 点选后可在下方补描述并打标签）' : '（空描述）')}</div>
        <div class="editor msg-editor hidden" data-role="editor">
          <textarea class="msg-input" data-role="input" placeholder="${placeholder}">${esc(text)}</textarea>
          <div class="editor-row">
            <button class="btn btn-primary btn-sm" data-action="desc-save" data-file="${file}">💾 保存描述</button>
            <button class="btn btn-ghost btn-sm" data-action="desc-cancel">取消</button>
            <span class="dim">保存会同步修改 Telegram 上的描述；超 48 小时的消息只改数据库</span>
          </div>
        </div>
        <div class="foot">
          <span class="tag-edit is-locked" data-role="tags">
            <button class="btn btn-ghost btn-xs tag-add-btn" data-action="tag-add-prompt" data-file="${file}" disabled>➕ 添加标签</button>
            <button class="btn btn-ghost btn-xs tag-cancel-btn hidden" data-action="tag-cancel" data-file="${file}">取消</button>
            ${tags.map(t => `<span class="tag-pill">${esc(t)}<button data-action="tag-rename" data-file="${file}" data-tag="${esc(t)}" title="重命名「${esc(t)}」（同步所有消息）">✎</button><button data-action="tag-remove" data-file="${file}" data-tag="${esc(t)}" title="移除该标签">✕</button></span>`).join('')}
          </span>
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-xs" data-action="desc-edit">✏️ 编辑描述</button>
        </div>
        <div class="tag-picker hidden" data-role="tag-picker">
          <div class="editor-row" style="margin-top:8px">
            <input class="tag-input" data-role="tag-input" placeholder="标签名，空格分隔可填多个；-标签 表示移除（如 xx yy -zz）" style="flex:1;min-width:160px">
            <button class="btn btn-sm btn-primary tag-add-submit" data-action="tag-add" data-file="${file}">➕ 添加</button>
            <button class="btn btn-sm tag-cancel-submit" data-action="tag-cancel" data-file="${file}">取消</button>
          </div>
          <div class="tag-suggest">
            ${(state.tags || []).filter(t => !tags.includes(t.name)).slice(0, 12)
        .map(t => `<button class="chip" data-action="tag-add" data-file="${file}" data-tag="${esc(t.name)}">${esc(t.name)}</button>`).join('') || '<span class="dim">标签库为空，直接输入即可新建</span>'}
          </div>
        </div>
        <div class="foot" style="margin-top:4px">
          <span class="mono dim">${file}</span>
          <span class="dim">·</span>
          <span class="mono dim">${m.chat_id === null || m.chat_id === undefined ? '—' : esc(m.chat_id)} / ${m.message_id === null || m.message_id === undefined ? '—' : esc(m.message_id)}</span>
          ${opts.isDraft ? '<span class="tag accent">🆕 新增描述</span>' : ''}
          ${opts.noRecord && !opts.isDraft ? '<span class="tag warn">无文本记录</span>' : ''}
        </div>
      </div>`;
  }

  /** 详情里已渲染的 message 块（按 file_unique_id） */
  function detailMsgBlock(file) {
    const body = $('#detail-body');
    if (!body || !file) return null;
    return [...body.querySelectorAll('.msg-block')].find(el => el.dataset.msg === file) || null;
  }

  /**
   * 展开 / 收起某条媒体的标签选择区
   * 展开时把「➕ 添加标签」右侧的「取消」一起显示出来（收起时隐藏并清空输入）
   */
  function setTagPicker(block, open) {
    if (!block) return;
    const picker = block.querySelector('.tag-picker');
    if (!picker) return;
    picker.classList.toggle('hidden', !open);
    // 两处取消按钮：标签行「➕ 添加标签」后面 / 输入框「➕ 添加」后面
    const cancelBtns = [block.querySelector('.tag-cancel-btn'), block.querySelector('.tag-cancel-submit')];
    cancelBtns.forEach(el => { if (el) el.classList.toggle('hidden', !open); });
    const input = block.querySelector('.tag-input');
    if (!input) return;
    if (open) input.focus();
    else input.value = '';
  }

  /** 「描述与标签」区里承载所有 message 块的容器 */
  function detailMsgList() {
    const body = $('#detail-body');
    if (!body) return null;
    return body.querySelector('.detail-msg-list');
  }

  /** 把一段 HTML 变成可插入的节点（真实浏览器用 template，桩环境退化到 div） */
  function elementFromHtml(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    return wrap.firstElementChild || (wrap.children && wrap.children[0]) || null;
  }

  /**
   * 重排「描述与标签」区（该区域位于媒体条下方，与原有描述块同区）：
   *  1. 选中的媒体**还没有描述** → 在区域**置顶**放一个「新增描述」块；
   *     全局只有这一个，点另一条没有描述的媒体时它跟着切换过去；
   *  2. 选中的媒体**已有描述** → 它自己的块**置顶显示**（不新增块）；
   *  3. 没选中（或选中被取消）→ 不显示新增块，块回到原始顺序。
   * 只重建「新增块」，已有块靠移动排序，避免打断用户正在输入的内容。
   */
  function layoutDetailBlocks() {
    const list = detailMsgList();
    if (!list) return null;
    const file = state.detailSelectedFile;

    // 1) 清掉上一次的新增块（保证任何时候最多一个）
    [...list.querySelectorAll('.is-draft')].forEach(el => el.remove());

    // 2) 已有块按渲染时的原始顺序排好（data-idx）
    const blocks = [...list.querySelectorAll('.msg-block')]
      .sort((a, b) => Number(a.dataset.idx || 0) - Number(b.dataset.idx || 0));

    // 3) 选中的媒体没有文本记录时才新建「新增描述」块
    const pinned = file ? blocks.find(el => el.dataset.msg === file) : null;
    let draft = null;
    if (file && !pinned) {
      const media = ((state.detail && state.detail.media) || []).find(m => m.file_unique_id === file);
      if (media) {
        const pos = media.group || media.channel || {};
        draft = elementFromHtml(msgBlockHtml({
          file_unique_id: file,
          text: '',
          tags: [],
          chat_id: pos.chat_id !== undefined ? pos.chat_id : media.message_id,
          message_id: pos.message_id !== undefined ? pos.message_id : media.message_id
        }, { noRecord: true, isDraft: true, idx: -1 }));
      }
    }

    // 4) 排序：新增块/选中块置顶，其余保持原始顺序
    const ordered = [];
    if (draft) ordered.push(draft);
    if (pinned) ordered.push(pinned);
    for (const el of blocks) if (el !== pinned) ordered.push(el);
    ordered.forEach(el => list.appendChild(el));

    // 5) 空态提示：区域里有块时隐藏
    const emptyEl = list.querySelector('.empty');
    if (emptyEl) emptyEl.classList.toggle('hidden', ordered.length > 0);

    // 6) 新增块直接进入编辑态（省掉一次「✏️ 编辑描述」）
    if (draft) {
      const textEl = draft.querySelector('.msg-text');
      const editorEl = draft.querySelector('.msg-editor');
      if (textEl) textEl.classList.add('hidden');
      if (editorEl) editorEl.classList.remove('hidden');
    }
    return draft;
  }

  /* ============================ 详情对话框（描述 / 标签 / 跳转） ============================ */

  async function openMediaDetail(groupId, opts = {}) {
    const dlg = $('#detail-dialog');
    state.detailTag = null;
    const prevGroupId = state.detail && state.detail.group ? state.detail.group.group_id : null;
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
    // 换了一个媒体组：清掉上一次的媒体选中态
    if (prevGroupId !== groupId) state.detailSelectedFile = null;

    const g = data.group || {};
    const media = data.media || [];
    const messages = data.messages || [];
    const cleanable = g.cleanable;
    const link = telegramLink(data);

    // 只有「1 个媒体 + 1 条文本」时直接帮用户选中：这种组改标签是唯一意图，省一次点击
    if (!state.detailSelectedFile && media.length === 1 && messages.length === 1
      && media[0].file_unique_id === messages[0].file_unique_id) {
      state.detailSelectedFile = media[0].file_unique_id;
    }

    // 媒体缩略图条：点击即选中该媒体，随后即可补描述 / 改标签
    // 没有文本记录的媒体同样可点选（选中后会在「描述与标签」区自动补出编辑块）
    const msgFiles = new Set(messages.map(m => m.file_unique_id));
    const strip = media.map(m => {
      const hasMsg = msgFiles.has(m.file_unique_id);
      return `
      <div class="detail-item${hasMsg ? '' : ' no-msg'}"
           data-action="detail-pick" data-file="${esc(m.file_unique_id)}"
           title="${hasMsg ? '点击选中该媒体，随后可补描述 / 修改它的标签' : '该媒体还没有文本记录，点选后可补描述并打标签'}">
        <div class="detail-thumb">
          ${m.thumbable
        ? `<img loading="lazy" decoding="async" src="${thumbUrl(m.file_unique_id)}" alt="">`
        : `<div class="ph">${typeIcon(m.media_type)}</div>`}
          ${typeBadgeHtml(m.media_type)}
        </div>
        <div class="cap">
          <span>#${m.subgroup} · ${typeLabel(m.media_type)}</span>
          <span class="mono">${m.video_time ? fmtDuration(m.video_time) : 'msg ' + m.message_id}</span>
        </div>
      </div>`;
    }).join('') || '<div class="empty">该组没有媒体记录</div>';

    // 每条 message：点选对应媒体后才解锁标签编辑（未选中时灰色不可点）
    // data-idx 记录原始顺序，供「选中的块置顶」重排时还原
    const msgBlocks = messages.map((m, i) => msgBlockHtml(m, { idx: i })).join('')
      || '<div class="empty">该组没有描述（空描述 · 可被清理）</div>';

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
        <div class="dim" style="font-size:11.5px;margin-top:8px">👆 点击上方任一媒体即可补描述、改标签：点没有描述的媒体会在下面「描述与标签」顶部出现一个新增编辑区（同一时间只有一个，保存时自动补建记录）；点已有描述的媒体则把它自己的编辑区置顶</div>
      </div>
      <div class="section">
        <h4>描述与标签</h4>
        <div class="detail-msg-list">${msgBlocks}</div>
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

    // 恢复上一次的媒体选中态（改完标签会整块重渲染）
    applyDetailSelection();
  }

  /**
   * 详情里的「选中媒体 → 高亮可改标签」状态：
   *   未选中（常规）：所有标签区灰掉、不可点
   *   选中且有标签：标签胶囊高亮，✕ 可直接移除
   *   选中且没有标签：高亮「➕ 添加标签」按钮
   *   选中且该媒体没有文本记录：自动补出可写描述 / 打标签的区块
   */
  function applyDetailSelection() {
    const body = $('#detail-body');
    const file = state.detailSelectedFile;
    body.querySelectorAll('.detail-item').forEach(el => el.classList.remove('is-active'));
    body.querySelectorAll('.msg-block').forEach(el => el.classList.remove('is-active'));
    // 未选中的标签区加回 is-locked（CSS 里 pointer-events: none，防止误点）
    body.querySelectorAll('.tag-edit').forEach(el => { el.classList.remove('is-active'); el.classList.add('is-locked'); });
    body.querySelectorAll('.tag-add-btn').forEach(el => { el.disabled = true; el.classList.remove('is-highlight'); });

    // 「描述与标签」区重排：新增块只跟着选中的无描述媒体，已有描述则把它的块置顶
    layoutDetailBlocks();

    if (!file) return;

    const strip = [...body.querySelectorAll('.detail-item')].find(el => el.dataset.file === file);
    if (strip) strip.classList.add('is-active');
    const block = detailMsgBlock(file);
    if (!block) return;

    block.classList.add('is-active');
    const tagEdit = block.querySelector('.tag-edit');
    const addBtn = block.querySelector('.tag-add-btn');
    if (tagEdit) {
      // 关键：移除 is-locked，否则 pointer-events: none 会让标签按钮全都点不动
      tagEdit.classList.remove('is-locked');
      tagEdit.classList.add('is-active');
    }
    if (addBtn) {
      addBtn.disabled = false;
      // 该媒体还没有标签 → 高亮「添加标签」
      if (!block.querySelector('.tag-pill')) addBtn.classList.add('is-highlight');
    }
  }

  /** 点击媒体（缩略图或描述块）：选中/取消选中 */
  function selectDetailMedia(file) {
    if (!file) return;
    const detail = state.detail || {};
    const media = (detail.media || []).find(m => m.file_unique_id === file);
    if (!media) {
      toast('该媒体不在当前媒体组里', true);
      return;
    }
    state.detailSelectedFile = state.detailSelectedFile === file ? null : file;
    applyDetailSelection();
  }

  /** 修改描述（空文本 = 清空描述） */
  async function saveDescription(fileUniqueId, block) {
    const text = block.querySelector('.msg-input').value;
    const r = await apiPost('/media/description', { fileUniqueId, text });
    if (r.telegramEdited) toast('✅ 描述已更新（Telegram 同步完成）');
    else toast(`✅ 数据库已更新${r.telegramError ? `（Telegram 未同步：${r.telegramError}）` : ''}`, !r.telegramError ? false : true);
    await loadOverview().catch(() => { });
    await openMediaDetail(state.detail.group.group_id);
  }

  async function applyMediaTags(fileUniqueId, { add = [], remove = [] }) {
    const r = await apiPost('/media/tags', { fileUniqueId, add, remove });
    const parts = [];
    if ((r.added || []).length) parts.push(`添加 ${r.added.join('、')}`);
    if ((r.removed || []).length) parts.push(`移除 ${r.removed.join('、')}`);
    toast(`🏷 ${parts.join(' · ') || '标签已更新'}（当前：${(r.tags || []).join('、') || '无'}）`);
    await openMediaDetail(state.detail.group.group_id);
  }

  /**
   * 标签改名（全局）：媒体详情里点标签上的 ✎ 触发
   * 会同步改写所有消息里的该标签，改完刷新标签库与当前详情
   */
  function renameTagForm(oldName) {
    const groupId = state.detail && state.detail.group ? state.detail.group.group_id : null;
    openForm({
      title: `重命名标签「${oldName}」`,
      okText: '改名',
      fields: [{
        key: 'name',
        label: '新标签名',
        value: oldName,
        required: true,
        hint: '最长 20 个字符，自动转大写；改名会同步所有消息里的该标签'
      }],
      onSubmit: async (v) => {
        const to = String(v.name || '').trim();
        if (!to) { toast('请输入新标签名', true); return; }
        if (to.toUpperCase() === oldName.toUpperCase()) { toast('新名字与原名字相同'); return; }
        const r = await apiPost('/tags/rename', { name: oldName, to });
        toast(`✅ 标签「${oldName}」已改名为「${r.name}」，同步 ${fmtNum(r.synced || 0)} 条消息`);
        await reloadTags();
        if (state.view === 'tags') renderTags();
        if (groupId) await openMediaDetail(groupId);
      }
    });
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

  /* ============================ 搬运收录 ============================ */

  function transportStatusTag(it) {
    if (it.alive === true) return '<span class="tag ok">✅ 有效</span>';
    if (it.alive === false) return '<span class="tag danger">❌ 失效</span>';
    return '<span class="tag">❔ 未检查</span>';
  }

  function renderTransport() {
    const t = state.transport;
    const c = t.counts || {};
    const chips = [
      ['all', `全部 ${fmtNum(c.all)}`],
      ['alive', `✅ 有效 ${fmtNum(c.alive)}`],
      ['dead', `❌ 失效 ${fmtNum(c.dead)}`],
      ['unchecked', `❔ 未检查 ${fmtNum(c.unchecked)}`]
    ].map(([v, label]) => `<button class="chip ${t.status === v ? 'is-active' : ''}" data-action="transport-status" data-status="${v}">${label}</button>`).join('');

    const rows = t.items.map(it => `<tr>
      <td>${transportStatusTag(it)}</td>
      <td><b>${esc(it.chat_name)}</b></td>
      <td class="num mono">${esc(it.chat_id)}</td>
      <td><button class="btn btn-ghost btn-xs" data-action="transport-open" data-id="${esc(it.chat_id)}" ${it.link ? '' : 'disabled'}>↗ Telegram</button></td>
      <td class="num">${fmtNum(it.num)}</td>
      <td class="dim" style="font-size:11.5px">${it.last_check_at
        ? `${fmtAgo(it.last_check_at)}${it.last_check_error ? `<br><span class="muted-2" title="${esc(it.last_check_error)}">${esc(shortId(it.last_check_error, 36))}</span>` : ''}`
        : '—'}</td>
      <td class="right">
        <button class="btn btn-ghost btn-xs" data-action="transport-check" data-id="${esc(it.chat_id)}" title="检查该链接活性">🔄</button>
        <button class="btn btn-ghost btn-xs" data-action="transport-edit" data-id="${esc(it.chat_id)}" title="编辑">✏️</button>
        <button class="btn btn-ghost btn-xs" data-action="transport-delete" data-id="${esc(it.chat_id)}" data-name="${esc(it.chat_name)}" title="删除">🗑</button>
      </td>
    </tr>`).join('');

    $('#view').innerHTML = `
      <div class="toolbar">
        <div class="chips">${chips}</div>
        <button class="btn btn-sm" data-action="transport-create">➕ 新增收录</button>
        <button class="btn btn-sm" data-action="transport-check-all">🔍 全部检查活性</button>
        <span class="dim">共 ${fmtNum(t.total)} 条${t.q ? ` · 搜索「${esc(t.q)}」` : ''}</span>
        <span class="grow"></span>
        <label class="switch">每页
          <select id="transport-pagesize" style="width:auto">
            ${[20, 50, 100].map(n => `<option value="${n}" ${t.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>活性</th><th>名称</th><th>chat_id</th><th>跳转</th><th>搬运次数</th><th>最近检查</th><th class="right">操作</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7"><div class="empty">没有符合条件的收录记录</div></td></tr>'}</tbody>
        </table>
      </div>
      ${paginationHtml(t, 'transport-page')}`;
    updatePageSub(`搬运收录 ${fmtNum(c.all)} 条 · ✅ 有效 ${fmtNum(c.alive)} ／ ❌ 失效 ${fmtNum(c.dead)} ／ ❔ 未检查 ${fmtNum(c.unchecked)}`);
  }

  function transportForm(item) {
    const existing = !!item;
    openForm({
      title: existing ? `编辑收录 ${item.chat_name || item.chat_id}` : '新增搬运收录',
      okText: existing ? '保存修改' : '创建',
      fields: [
        { key: 'chat_id', label: 'chat_id', type: 'number', value: existing ? item.chat_id : '', required: true, readonly: existing, hint: existing ? 'chat_id 为唯一键，不可修改' : '被搬运的频道/群组 ID，如 -1001234567890' },
        { key: 'chat_name', label: '名称', value: existing ? item.chat_name : '' },
        { key: 'url', label: '收录链接', value: existing ? item.url : '', required: true, hint: 't.me 链接或频道 ID；用于跳转与活性检查' },
        { key: 'num', label: '搬运次数', type: 'number', value: existing ? item.num : 0, hint: '仅影响排序与展示，不触发搬运' }
      ],
      onSubmit: async (v) => {
        if (existing) {
          await apiPost('/transport/update', {
            chat_id: Number(item.chat_id),
            patch: { chat_name: v.chat_name, url: v.url, num: Number(v.num) || 0 }
          });
          toast('✅ 收录已更新');
        } else {
          await apiPost('/transport/create', {
            chat_id: Number(v.chat_id), chat_name: v.chat_name, url: v.url, num: Number(v.num) || 0
          });
          toast('✅ 收录已创建');
        }
        await show('transport');
      }
    });
  }

  async function deleteTransport(id, name) {
    const ok = await confirmDialog({
      title: '删除搬运收录',
      body: `<div>确定删除 <b>${esc(name || id)}</b>（chat_id=${esc(id)}）的收录记录吗？</div>
             <div class="dim" style="margin-top:8px">仅删除搬运列表中的这一条，不影响 Telegram 里的频道与已收录媒体。</div>`,
      okText: '确认删除'
    });
    if (!ok) return;
    await apiPost('/transport/delete', { chat_id: Number(id), confirm: true });
    toast('🗑 已删除收录记录');
    await show('transport');
  }

  async function checkTransport(id) {
    toast('🔍 正在检查该链接…');
    const r = await apiPost('/transport/check', { chat_id: Number(id) });
    const it = r.item || {};
    if (it.alive === true) toast('✅ 链接有效');
    else if (it.alive === false) toast(`❌ 链接已失效：${shortId(it.last_check_error || '不可访问', 60)}`, true);
    else toast(`❔ 暂时无法判定：${shortId(it.last_check_error || '', 60)}`, true);
    await show('transport');
  }

  async function checkAllTransport() {
    toast('🔍 正在检查全部收录链接，请稍候…');
    const r = await apiPost('/transport/check', {});
    const s = r.summary || {};
    toast(`🔍 检查完成：✅ 有效 ${s.ok || 0} ／ ❌ 失效 ${s.dead || 0} ／ ❔ 未知 ${s.unknown || 0}`, (s.dead || 0) > 0);
    await show('transport');
  }

  /* ============================ 文章 ============================ */

  function renderArticles() {
    const a = state.articles;
    const cards = a.items.map(it => {
      const title = esc(it.title || '（无标题）');
      const head = it.link
        ? `<a href="${esc(it.link)}" target="_blank" rel="noopener">${title}</a>`
        : title;
      const subs = (it.subs || []).map(s => `<div class="mini-row">
          <span class="t">${s.link ? `<a href="${esc(s.link)}" target="_blank" rel="noopener">${esc(s.title || s.link)}</a>` : esc(s.title || '（无标题）')}</span>
          <span class="time mono">#${esc(s.id)}</span>
          <button class="btn btn-ghost btn-xs" data-action="article-sub-edit" data-id="${esc(s.id)}" title="编辑子文章">✏️</button>
          <button class="btn btn-ghost btn-xs" data-action="article-sub-delete" data-id="${esc(s.id)}" data-name="${esc(s.title || '')}" title="删除子文章">🗑</button>
        </div>`).join('') || '<div class="dim" style="font-size:12px">（暂无子文章）</div>';
      return `<div class="card" style="margin-bottom:12px">
        <div class="card-head">
          <h3>#${esc(it.id)} ${head}</h3>
          <span class="dim">${fmtNum(it.subCount)} 篇子文章 · 更新 ${fmtAgo(it.updated_at)}</span>
        </div>
        <div class="mini-list">${subs}</div>
        <div class="editor-row" style="margin-top:8px">
          <button class="btn btn-ghost btn-xs" data-action="article-sub-add" data-id="${esc(it.id)}">➕ 子文章</button>
          <button class="btn btn-ghost btn-xs" data-action="article-edit" data-id="${esc(it.id)}">✏️ 编辑</button>
          <button class="btn btn-ghost btn-xs" data-action="article-delete" data-id="${esc(it.id)}" data-name="${esc(it.title || '')}">🗑 删除</button>
        </div>
      </div>`;
    }).join('');

    $('#view').innerHTML = `
      <div class="toolbar">
        <button class="btn btn-sm" data-action="article-create">➕ 新增文章</button>
        <span class="dim">共 ${fmtNum(a.total)} 篇文章${a.q ? ` · 搜索「${esc(a.q)}」` : ''} · 子文章随文章一起增删改</span>
        <span class="grow"></span>
        <label class="switch">每页
          <select id="articles-pagesize" style="width:auto">
            ${[20, 50, 100].map(n => `<option value="${n}" ${a.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
        </label>
      </div>
      ${a.items.length ? cards : '<div class="empty"><div class="empty-ico">📄</div><div>还没有文章，点「➕ 新增文章」创建</div></div>'}
      ${paginationHtml(a, 'articles-page')}`;
    updatePageSub(`文章 ${fmtNum(a.total)} 篇`);
  }

  function articleForm(item) {
    const existing = !!item;
    openForm({
      title: existing ? `编辑文章 #${item.id}` : '新增文章',
      okText: existing ? '保存修改' : '创建',
      fields: [
        { key: 'title', label: '标题', value: existing ? item.title : '', required: true },
        { key: 'link', label: '链接', value: existing ? item.link : '', placeholder: 'https://telegra.ph/...' }
      ],
      onSubmit: async (v) => {
        if (existing) {
          await apiPost('/articles/update', { id: Number(item.id), patch: { title: v.title, link: v.link } });
          toast('✅ 文章已更新');
        } else {
          await apiPost('/articles/create', { title: v.title, link: v.link });
          toast('✅ 文章已创建');
        }
        await show('articles');
      }
    });
  }

  function subArticleForm(articleId, sub) {
    const existing = !!sub;
    openForm({
      title: existing ? `编辑子文章 #${sub.id}` : `新增子文章（文章 #${articleId}）`,
      okText: existing ? '保存修改' : '创建',
      fields: [
        { key: 'title', label: '标题', value: existing ? sub.title : '', required: true },
        { key: 'link', label: '链接', value: existing ? sub.link : '', placeholder: 'https://telegra.ph/...' }
      ],
      onSubmit: async (v) => {
        if (existing) {
          await apiPost('/articles/sub/update', { id: Number(sub.id), patch: { title: v.title, link: v.link } });
          toast('✅ 子文章已更新');
        } else {
          await apiPost('/articles/sub/create', { article_id: Number(articleId), title: v.title, link: v.link });
          toast('✅ 子文章已创建');
        }
        await show('articles');
      }
    });
  }

  async function deleteArticle(id, name) {
    const ok = await confirmDialog({
      title: '删除文章',
      body: `<div>确定删除文章 <b>${esc(name || `#${id}`)}</b>（#${esc(id)}）吗？</div>
             <div class="dim" style="margin-top:8px">该文章下的所有子文章会一并删除，且不可恢复。</div>`,
      okText: '确认删除'
    });
    if (!ok) return;
    const r = await apiPost('/articles/delete', { id: Number(id), confirm: true });
    toast(`🗑 文章已删除${r.removedSubs ? `（含 ${r.removedSubs} 篇子文章）` : ''}`);
    await show('articles');
  }

  async function deleteSubArticle(id, name) {
    const ok = await confirmDialog({
      title: '删除子文章',
      body: `<div>确定删除子文章 <b>${esc(name || `#${id}`)}</b> 吗？</div>`,
      okText: '确认删除'
    });
    if (!ok) return;
    await apiPost('/articles/sub/delete', { id: Number(id), confirm: true });
    toast('🗑 子文章已删除');
    await show('articles');
  }

  /* ============================ 合集 / 杂集 ============================ */

  function renderCollections() {
    const c = state.collectionsView;
    const counts = c.counts || {};
    const chips = [['all', `全部 ${fmtNum(counts.all)}`], ['collection', `📚 合集 ${fmtNum(counts.collection)}`], ['misc', `📦 杂集 ${fmtNum(counts.misc)}`]]
      .map(([v, label]) => `<button class="chip ${c.type === v ? 'is-active' : ''}" data-action="collection-type" data-type="${v}">${label}</button>`).join('');

    const cards = c.items.map(it => {
      const subs = (it.subs || []).map(s => `<div class="mini-row">
          <span class="t">${s.link ? `<a href="${esc(s.link)}" target="_blank" rel="noopener">${esc(s.name || s.link)}</a>` : esc(s.name || '（未命名）')}</span>
          <span class="time mono">#${esc(s.id)}</span>
          <button class="btn btn-ghost btn-xs" data-action="collection-sub-edit" data-id="${esc(s.id)}" title="编辑子项">✏️</button>
          <button class="btn btn-ghost btn-xs" data-action="collection-sub-delete" data-id="${esc(s.id)}" data-name="${esc(s.name || '')}" title="删除子项">🗑</button>
        </div>`).join('') || '<div class="dim" style="font-size:12px">（暂无子项）</div>';
      return `<div class="card" style="margin-bottom:12px">
        <div class="card-head">
          <h3>#${esc(it.id)} ${esc(it.name || '（未命名）')}</h3>
          <span class="dim">${it.type === 'misc' ? '📦 杂集' : '📚 合集'} · ${fmtNum(it.subCount)} 个子项 · 更新 ${fmtAgo(it.updated_at)}</span>
        </div>
        <div class="mini-list">${subs}</div>
        <div class="editor-row" style="margin-top:8px">
          <button class="btn btn-ghost btn-xs" data-action="collection-sub-add" data-id="${esc(it.id)}">➕ 子项</button>
          <button class="btn btn-ghost btn-xs" data-action="collection-edit" data-id="${esc(it.id)}">✏️ 编辑</button>
          <button class="btn btn-ghost btn-xs" data-action="collection-delete" data-id="${esc(it.id)}" data-name="${esc(it.name || '')}">🗑 删除</button>
        </div>
      </div>`;
    }).join('');

    $('#view').innerHTML = `
      <div class="toolbar">
        <div class="chips">${chips}</div>
        <button class="btn btn-sm" data-action="collection-create" data-type="collection">➕ 新增合集</button>
        <button class="btn btn-sm" data-action="collection-create" data-type="misc">➕ 新增杂集</button>
        <span class="dim">共 ${fmtNum(c.items.length)} 个${c.q ? ` · 搜索「${esc(c.q)}」` : ''} · 子项共 ${fmtNum(c.subTotal || 0)} 个</span>
      </div>
      ${c.items.length ? cards : '<div class="empty"><div class="empty-ico">📚</div><div>还没有合集 / 杂集，点上方按钮创建</div></div>'}`;
    updatePageSub(`合集 ${fmtNum(counts.collection)} 个 · 杂集 ${fmtNum(counts.misc)} 个`);
  }

  function collectionForm(item, defaultType) {
    const existing = !!item;
    openForm({
      title: existing ? `编辑${item.type === 'misc' ? '杂集' : '合集'} #${item.id}` : `新增${defaultType === 'misc' ? '杂集' : '合集'}`,
      okText: existing ? '保存修改' : '创建',
      fields: [
        { key: 'name', label: '名称', value: existing ? item.name : '', required: true },
        {
          key: 'type', label: '类型', type: 'select', value: existing ? item.type : (defaultType || 'collection'),
          options: [{ v: 'collection', l: '📚 合集' }, { v: 'misc', l: '📦 杂集' }]
        }
      ],
      onSubmit: async (v) => {
        if (existing) {
          await apiPost('/collections/update', { id: Number(item.id), patch: { name: v.name, type: v.type } });
          toast('✅ 已更新');
        } else {
          await apiPost('/collections/create', { name: v.name, type: v.type });
          toast('✅ 已创建');
        }
        await show('collections');
      }
    });
  }

  function subCollectionForm(collectionId, sub) {
    const existing = !!sub;
    openForm({
      title: existing ? `编辑子项 #${sub.id}` : `新增子项（合集 #${collectionId}）`,
      okText: existing ? '保存修改' : '创建',
      fields: [
        { key: 'name', label: '名称', value: existing ? sub.name : '', required: true },
        { key: 'link', label: '链接', value: existing ? sub.link : '', placeholder: 'https://t.me/...' }
      ],
      onSubmit: async (v) => {
        if (existing) {
          await apiPost('/collections/sub/update', { id: Number(sub.id), patch: { name: v.name, link: v.link } });
          toast('✅ 子项已更新');
        } else {
          await apiPost('/collections/sub/create', { collection_id: Number(collectionId), name: v.name, link: v.link });
          toast('✅ 子项已创建');
        }
        await show('collections');
      }
    });
  }

  async function deleteCollection(id, name) {
    const ok = await confirmDialog({
      title: '删除合集',
      body: `<div>确定删除 <b>${esc(name || `#${id}`)}</b>（#${esc(id)}）吗？</div>
             <div class="dim" style="margin-top:8px">该合集下的所有子项会一并删除，且不可恢复。</div>`,
      okText: '确认删除'
    });
    if (!ok) return;
    const r = await apiPost('/collections/delete', { id: Number(id), confirm: true });
    toast(`🗑 已删除${r.removedSubs ? `（含 ${r.removedSubs} 个子项）` : ''}`);
    await show('collections');
  }

  async function deleteSubCollection(id, name) {
    const ok = await confirmDialog({
      title: '删除子项',
      body: `<div>确定删除子项 <b>${esc(name || `#${id}`)}</b> 吗？</div>`,
      okText: '确认删除'
    });
    if (!ok) return;
    await apiPost('/collections/sub/delete', { id: Number(id), confirm: true });
    toast('🗑 子项已删除');
    await show('collections');
  }

  /* ============================ 数据库视图（集合浏览 + 集合明细整合） ============================ */

  /**
   * 数据库视图的整合版面：
   *   上栏 = 集合浏览控制（选集合 / 排序 / 插入 / AI / 重新统计）+ 库信息
   *   中部 = 整库汇总卡片（不含「平均文档」）
   *   下方 = 各集合明细表（表格化，点行即切换集合浏览）
   */
  function dbToolbarHtml(options, isAll, r) {
    const d = state.dbstats.data;
    const t = d && d.totals;

    const cards = !d
      ? '<div class="callout" style="margin-bottom:14px"><span>🗄</span><div>数据库统计加载中…</div></div>'
      : (d.available && t
        ? `<div class="stats">${[
          statCard('🗄 集合数', t.collections, 'database: ' + (d.database || '—')),
          statCard('📄 文档总数', t.objects, '整库 objects'),
          sizeCard('💾 存储占用', t.storageSize, 'storageSize（磁盘实际占用）', 'is-accent'),
          sizeCard('📦 数据体积', t.dataSize, 'dataSize（未压缩）'),
          sizeCard('🔑 索引占用', t.indexSize, `${fmtNum(t.indexes)} 个索引`)
        ].join('')}</div>`
        : `<div class="stats">${statCard('🗄 数据库统计', null, '当前套餐不允许读取存储大小', 'is-warn')}</div>
           <div class="callout" style="margin:14px 0"><span>⚠️</span><div><b>无法读取存储大小：</b>${esc(d.reason || '未知原因')}<br>
           当前仅在支持 <code>dbStats</code> / <code>collStats</code> 的 MongoDB 部署上显示大小；文档数仍可在下方浏览中查看。</div></div>`);

    const isCurrent = (name) => !isAll && r.collection === name;
    const rows = ((d && d.collections) || []).map(c => `<tr data-action="raw-collection" data-collection="${esc(c.name)}" class="${isCurrent(c.name) ? 'is-active' : ''}" title="点这一行 → 在下方浏览 ${esc(c.name)}">
      <td><b class="mono">${esc(c.name)}</b> <span class="dim">${esc(c.label)}</span></td>
      <td class="num">${fmtNum(c.count)}</td>
      <td class="num">${fmtBytes(c.size)}</td>
      <td class="num">${fmtBytes(c.storageSize)}</td>
      <td class="num">${fmtBytes(c.indexSize)}</td>
      <td class="num">${fmtNum(c.nindexes)}</td>
    </tr>`).join('');

    return `
      <div class="toolbar db-toolbar">
        <b style="font-size:13px">🗄 数据库</b>
        <select id="raw-collection" style="width:190px" title="选择要浏览的集合">${options}</select>
        <select id="raw-sort" style="width:132px" title="排序方式" ${isAll ? 'disabled' : ''}>
          <option value="-1" ${r.sort === -1 ? 'selected' : ''}>最新在前</option>
          <option value="1" ${r.sort === 1 ? 'selected' : ''}>最早在前</option>
        </select>
        <button class="btn btn-sm" data-action="raw-insert" ${isAll ? 'disabled' : ''}>➕ 插入数据</button>
        <button class="btn btn-sm" data-action="palette">🧠 AI 翻译 / 执行</button>
        <button class="btn btn-sm" data-action="dbstats-refresh">🔄 重新统计</button>
        <span class="grow"></span>
        <span class="dim">库名 <code>${esc((d && d.database) || '—')}</code>${d && d.at ? ` · 统计 ${fmtTime(d.at)}` : ''} · ${isAll ? '跨集合浏览（每集合最多 50 条）' : `${esc(r.collection)} 共 ${fmtNum(r.total)} 条`}</span>
      </div>
      ${cards}
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <h3>集合明细</h3>
          <span class="dim">按数据体积降序 · 点任意一行即在下方浏览该集合</span>
        </div>
        <div class="table-wrap table-scroll">
          <table class="db-table">
            <thead><tr><th>集合</th><th class="num">文档数</th><th class="num">数据体积</th><th class="num">存储占用</th><th class="num">索引占用</th><th class="num">索引数</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6"><div class="empty">没有集合数据</div></td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  }

  async function refreshDbStats() {
    toast('🔄 正在重新统计…');
    await loadDbStats(true);
    if (state.view === 'raw') renderRaw(); else await show(state.view);
    toast('✅ 统计已更新');
  }

  /* ============================ 视图调度 ============================ */

  const VIEW_META = {
    overview: { title: '概览', load: loadOverview, render: renderOverview },
    media: { title: '媒体库', load: loadMedia, render: renderMedia },
    random: { title: '随机推荐', load: loadRandom, render: renderRandom },
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
    transport: { title: '搬运收录', load: loadTransport, render: renderTransport },
    articles: { title: '文章', load: loadArticles, render: renderArticles },
    collections: { title: '合集 / 杂集', load: loadCollections, render: renderCollections },
    stats: { title: '统计报表', load: loadStats, render: renderStats },
    raw: {
      title: '数据库',
      // 数据库视图 = 集合浏览（上栏）+ 集合明细表 + 原始文档浏览（增删改）
      load: async () => { await Promise.all([loadRaw(), loadDbStats(false).catch(() => { })]); },
      render: renderRaw
    },
    logs: { title: '实时日志', load: async () => { }, render: renderLogs }
  };

  function setSearchVisible(view) {
    const visible = SEARCH_VIEWS.includes(view);
    $('#search-wrap').classList.toggle('hidden', !visible);
    if (visible) {
      const input = $('#global-search');
      if (input) input.placeholder = SEARCH_PLACEHOLDER[view] || '搜索，回车查询';
    }
  }

  async function show(view) {
    if (!VIEW_META[view]) return;
    hideThumbZoom(); // 视图要整体重渲染，旧的缩略图马上就不存在了，先收起悬停放大浮层
    state.view = view;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
    $('#page-title').textContent = VIEW_META[view].title;
    // 统计报表：让底部「操作日志明细」撑满剩余高度（否则内容悬在中间、不贴底）
    $('#view').classList.toggle('view-fill', view === 'stats');
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
    let dragTagName = null; // 标签排序：正在拖拽的标签名

    // 标签「置顶排序」：拖动卡片即时换位，松手后由「保存排序」落库
    view.addEventListener('dragstart', (e) => {
      if (state.view !== 'tags' || state.tagsMode !== 'sort') return;
      const card = e.target && e.target.closest ? e.target.closest('.tag-card') : null;
      if (!card) return;
      dragTagName = card.dataset.tag;
      card.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', dragTagName); } catch { /* 某些浏览器会抛错 */ }
      }
    });
    view.addEventListener('dragover', (e) => {
      if (state.view !== 'tags' || state.tagsMode !== 'sort' || !dragTagName) return;
      const card = e.target && e.target.closest ? e.target.closest('.tag-card') : null;
      if (!card) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const dragging = view.querySelector('.tag-card.is-dragging');
      if (!dragging || dragging === card) return;
      const rect = typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect() : null;
      const after = rect && rect.width > 0 ? (e.clientX - rect.left) > rect.width / 2 : false;
      const grid = card.parentElement;
      if (grid) grid.insertBefore(dragging, after ? card.nextSibling : card);
    });
    view.addEventListener('drop', (e) => {
      if (state.view === 'tags' && state.tagsMode === 'sort') e.preventDefault();
    });
    view.addEventListener('dragend', () => {
      const dragging = view.querySelector('.tag-card.is-dragging');
      if (dragging) dragging.classList.remove('is-dragging');
      dragTagName = null;
    });

    view.addEventListener('click', async (e) => {
      hideThumbZoom(); // 点击后可能重渲染 / 弹窗，悬停放大浮层先收起
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
          // 随机推荐：筛选条件变化后立即重抽
          case 'random-roll':
            if (state.view === 'random') {
              const qInput = $('#random-q');
              if (qInput) state.random.q = String(qInput.value || '').trim();
            }
            await loadRandom();
            renderRandom();
            break;
          case 'random-type': {
            const t = el.dataset.type || '';
            state.random.types = !t ? []
              : (state.random.types.includes(t)
                ? state.random.types.filter(x => x !== t)
                : [...state.random.types, t]);
            await loadRandom(); renderRandom(); break;
          }
          case 'random-tag': {
            const t = el.dataset.tag;
            state.random.tags = state.random.tags.includes(t)
              ? state.random.tags.filter(x => x !== t)
              : [...state.random.tags, t];
            await loadRandom(); renderRandom(); break;
          }
          case 'random-tagmode':
            state.random.tagMode = state.random.tagMode === 'all' ? 'any' : 'all';
            await loadRandom(); renderRandom(); break;
          case 'random-scope':
            state.random.scope = el.dataset.scope || 'all';
            await loadRandom(); renderRandom(); break;
          case 'random-reset':
            state.random = {
              types: [], tags: [], tagMode: 'any', q: '', duration: 'all', scope: 'all', count: 6,
              items: [], total: 0
            };
            await loadRandom(); renderRandom(); break;
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
            if ($('#detail-dialog').open) $('#detail-dialog').close();
            await show('media'); break;
          // 标签视图：详情 / 增删 / 置顶排序
          case 'tag-card-open': openTagDetail(el.dataset.tag); break;
          case 'tag-create': createTag(); break;
          case 'tag-delete': await deleteTag(el.dataset.tag); break;
          case 'tag-mode': {
            const mode = el.dataset.mode;
            state.tagsMode = state.tagsMode === mode ? 'normal' : mode;
            renderTags();
            break;
          }
          case 'tag-sort-save': await saveTagOrder(); break;
          case 'tag-sort-cancel':
            state.tagsMode = 'normal';
            renderTags();
            break;
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
          // 搬运收录 CRUD + 链接活性检查
          case 'transport-create': transportForm(null); break;
          case 'transport-edit': transportForm(state.transport.items.find(x => String(x.chat_id) === el.dataset.id)); break;
          case 'transport-delete': await deleteTransport(el.dataset.id, el.dataset.name); break;
          case 'transport-check': await checkTransport(el.dataset.id); break;
          case 'transport-check-all': await checkAllTransport(); break;
          case 'transport-status':
            state.transport.status = el.dataset.status;
            state.transport.page = 1;
            await show('transport'); break;
          case 'transport-page': await pageTo(state.transport, el, show); break;
          case 'transport-open': {
            const it = state.transport.items.find(x => String(x.chat_id) === el.dataset.id);
            if (it && it.link) window.open(it.link, '_blank', 'noopener');
            break;
          }
          // 文章 / 子文章 CRUD
          case 'article-create': articleForm(null); break;
          case 'article-edit': articleForm(state.articles.items.find(x => String(x.id) === el.dataset.id)); break;
          case 'article-delete': await deleteArticle(el.dataset.id, el.dataset.name); break;
          case 'article-sub-add': subArticleForm(el.dataset.id, null); break;
          case 'article-sub-edit': {
            const parent = state.articles.items.find(x => (x.subs || []).some(s => String(s.id) === el.dataset.id));
            const sub = parent && (parent.subs || []).find(s => String(s.id) === el.dataset.id);
            subArticleForm(parent ? parent.id : null, sub);
            break;
          }
          case 'article-sub-delete': await deleteSubArticle(el.dataset.id, el.dataset.name); break;
          case 'articles-page': await pageTo(state.articles, el, show); break;
          // 合集 / 杂集 CRUD
          case 'collection-create': collectionForm(null, el.dataset.type); break;
          case 'collection-edit': collectionForm(state.collectionsView.items.find(x => String(x.id) === el.dataset.id), null); break;
          case 'collection-delete': await deleteCollection(el.dataset.id, el.dataset.name); break;
          case 'collection-type':
            state.collectionsView.type = el.dataset.type;
            await show('collections'); break;
          case 'collection-sub-add': subCollectionForm(el.dataset.id, null); break;
          case 'collection-sub-edit': {
            const parent = state.collectionsView.items.find(x => (x.subs || []).some(s => String(s.id) === el.dataset.id));
            const sub = parent && (parent.subs || []).find(s => String(s.id) === el.dataset.id);
            subCollectionForm(parent ? parent.id : null, sub);
            break;
          }
          case 'collection-sub-delete': await deleteSubCollection(el.dataset.id, el.dataset.name); break;
          // 数据库存储统计
          case 'dbstats-refresh': await refreshDbStats(); break;
          // 报表：统一按年统计，顶栏 ◀ ▶ 切换年份
          case 'stats-year-prev':
            state.stats.year = Math.max(2000, state.stats.year - 1);
            state.stats.data = null;
            await show('stats'); break;
          case 'stats-year-next':
            state.stats.year = Math.min(2100, state.stats.year + 1);
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
      // 随机推荐关键词：回车即重抽（与全局搜索一致的交互）
      if (e.key === 'Enter' && el && el.id === 'random-q') {
        state.random.q = String(el.value || '').trim();
        await loadRandom();
        renderRandom();
        return;
      }
      if (e.key !== 'Enter' || !el.dataset || !el.dataset.action) return;
      if (!el.dataset.action.endsWith('-input')) return;
      const action = el.dataset.action.replace('-input', '');
      const pager = action === 'media-page' ? state.media
        : action === 'users-page' ? state.users
          : action === 'transport-page' ? state.transport
            : action === 'articles-page' ? state.articles
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
      } else if (el.id === 'transport-pagesize') {
        state.transport.pageSize = parseInt(el.value, 10) || 20;
        state.transport.page = 1;
        await show('transport');
      } else if (el.id === 'articles-pagesize') {
        state.articles.pageSize = parseInt(el.value, 10) || 20;
        state.articles.page = 1;
        await show('articles');
      } else if (el.id === 'raw-collection') {
        state.raw.collection = el.value;
        state.raw.page = 1;
        await show('raw');
      } else if (el.id === 'raw-sort') {
        state.raw.sort = parseInt(el.value, 10) || -1;
        state.raw.page = 1;
        await show('raw');
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
      } else if (el.id === 'contrib-metric') {
        // 每日操作量方格图：切换查看项（纯前端重绘，不重新请求）
        state.stats.metric = el.value || 'all';
        renderStats();
      } else if (el.id === 'random-duration') {
        state.random.duration = el.value || 'all';
        await loadRandom();
        renderRandom();
      } else if (el.id === 'random-count') {
        state.random.count = parseInt(el.value, 10) || 6;
        await loadRandom();
        renderRandom();
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
      else if (state.view === 'transport') { state.transport.q = v; state.transport.page = 1; show('transport'); }
      else if (state.view === 'articles') { state.articles.q = v; state.articles.page = 1; show('articles'); }
      else if (state.view === 'collections') { state.collectionsView.q = v; show('collections'); }
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
      hideThumbZoom(); // 选中媒体 / 关闭对话框前先收起悬停放大浮层
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
            block.querySelector('.msg-text').classList.add('hidden');
            block.querySelector('.msg-editor').classList.remove('hidden');
            block.querySelector('.msg-editor textarea').focus();
            break;
          }
          case 'desc-cancel': {
            const block = el.closest('.msg-block');
            block.querySelector('.msg-editor').classList.add('hidden');
            block.querySelector('.msg-text').classList.remove('hidden');
            break;
          }
          case 'desc-save': await saveDescription(el.dataset.file, el.closest('.msg-block')); break;
          case 'detail-pick': {
            // 点媒体/描述块 = 选中；点编辑区、标签区、表单控件不算（避免误取消选中）
            const t = e.target;
            if (t.closest('.msg-editor, .tag-picker, .tag-edit')) break;
            if (/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test(t.tagName || '')) break;
            // 标签区的按钮虽在 .tag-edit 内，但按钮本身已由上面拦下；
            // 这里再兜一层：按钮/链接的点击永远不改变选中态
            if (t.closest('button, a, label, .btn')) break;
            selectDetailMedia(el.dataset.file);
            break;
          }
          case 'tag-add-prompt': {
            const block = el.closest('.msg-block');
            const picker = block.querySelector('.tag-picker');
            setTagPicker(block, picker.classList.contains('hidden'));
            break;
          }
          case 'tag-cancel': {
            // 取消：收起标签选择区、清空输入（不写库）
            setTagPicker(el.closest('.msg-block'), false);
            break;
          }
          case 'tag-add': {
            // 定点按钮带 data-tag（推荐标签）；输入框的「➕ 添加」解析整段输入
            // 支持一次多个（空格分隔）与 -标签 移除
            const block = el.closest('.msg-block');
            const input = block && block.querySelector('.tag-input');
            const file = el.dataset.file || (block ? block.dataset.msg : '');
            if (el.dataset.tag) {
              if (!file) { toast('未找到目标媒体，请重新打开详情', true); break; }
              await applyMediaTags(file, { add: [el.dataset.tag] });
              break;
            }
            await submitTagInput(block, file, input ? input.value : '');
            break;
          }
          case 'tag-remove': await applyMediaTags(el.dataset.file, { remove: [el.dataset.tag] }); break;
          case 'tag-rename': {
            const oldName = el.dataset.tag;
            renameTagForm(oldName);
            break;
          }
          // 标签详情：顶栏切换置顶 / 直接打开该标签下的媒体 / 删除
          case 'tag-detail-pin': await toggleTagPin(el.dataset.tag); break;
          case 'tag-media-open': {
            const groupId2 = el.dataset.group;
            dlg.close();
            await openMediaDetail(groupId2);
            break;
          }
          case 'tag-detail-media': {
            const name = el.dataset.tag;
            dlg.close();
            state.media.tag = name;
            state.media.page = 1;
            await show('media');
            break;
          }
          case 'tag-detail-delete': await deleteTag(el.dataset.tag); break;
          default: break;
        }
      } catch (err) {
        toast(err.message, true);
      }
    });

    // 标签输入框回车 = 添加（作用于选中的那条 message）
    dlg.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const input = e.target;
      if (!input.dataset) return;
      e.preventDefault();
      try {
        if (input.dataset.role === 'tag-input') {
          const block = input.closest ? input.closest('.msg-block') : null;
          const file = (block && block.dataset.msg) || '';
          await submitTagInput(block, file, input.value);
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
    // 缩略图悬停放大：媒体库在 #view 内，媒体详情在对话框（顶层）里，两处都要绑
    bindThumbZoomEvents($('#view'));
    bindThumbZoomEvents($('#detail-dialog'));
    if (window.addEventListener) {
      window.addEventListener('scroll', hideThumbZoom, true);
      window.addEventListener('resize', hideThumbZoom);
    }
    $('#login-btn').addEventListener('click', login);
    $('#login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
    if (token()) enterApp();
  }

  init();
})();
