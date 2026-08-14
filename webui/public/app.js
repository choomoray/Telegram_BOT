/* Telegram Bot 管理面板逻辑 */
(function () {
  'use strict';

  const TOKEN_KEY = 'webui_token';
  const API = '/api';

  const MEDIA_ICON = { video: '🎬', photo: '🏞', audio: '🎵', document: '📄' };
  const MEDIA_NAMES = { video: '视频', photo: '图片', audio: '音频', document: '文档' };
  const LEVELS = ['S', 'A', 'B', 'C', 'D'];

  const LOG_TYPES = {
    0: '机器人启动', 1: '媒体入库', 2: '媒体编辑', 3: '媒体删除',
    11: '随机视频', 12: '随机图片', 13: '消息回复', 14: '媒体合并',
    15: '媒体遮罩', 16: '帮助', 17: '搜索', 18: '数据库清理',
    19: '删除模式', 20: '标记', 21: '媒体去遮罩', 22: '关键字查询',
    23: '编辑文本', 24: '设置更新'
  };

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 基础 ----------

  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(API + path, { ...options, headers });
    if (res.status === 401) {
      logout();
      throw new Error('会话已过期，请重新登录');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    $('#view-' + name).classList.remove('hidden');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === name));
    renderers[name] && renderers[name]();
  }

  // ---------- 登录 ----------

  async function login() {
    const password = $('#login-password').value;
    if (!password) return;
    try {
      const data = await fetch(API + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      }).then(r => r.json());
      if (!data.token) throw new Error(data.error || '登录失败');
      localStorage.setItem(TOKEN_KEY, data.token);
      enterApp();
    } catch (err) {
      const el = $('#login-error');
      el.textContent = err.message;
      el.classList.remove('hidden');
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
  }

  function enterApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    showView('dashboard');
  }

  // ---------- 分页组件 ----------

  function pagination(container, page, totalPages, onPage) {
    container.innerHTML = '';
    if (totalPages <= 1) return;
    const wrap = document.createElement('div');
    wrap.className = 'pagination';
    const prev = document.createElement('button');
    prev.className = 'btn btn-sm';
    prev.textContent = '⬅ 上一页';
    prev.disabled = page <= 1;
    prev.onclick = () => onPage(page - 1);
    const info = document.createElement('span');
    info.className = 'page-info';
    info.textContent = `${page} / ${totalPages}`;
    const next = document.createElement('button');
    next.className = 'btn btn-sm';
    next.textContent = '下一页 ➡';
    next.disabled = page >= totalPages;
    next.onclick = () => onPage(page + 1);
    wrap.append(prev, info, next);
    container.appendChild(wrap);
  }

  function levelBadge(level) {
    if (!level || !LEVELS.includes(level)) return '';
    const color = { S: 'badge-red', A: 'badge-yellow', B: 'badge-blue', C: 'badge-gray', D: 'badge-gray' }[level];
    return `<span class="badge ${color}">${level}</span>`;
  }

  // ---------- 仪表盘 ----------

  async function renderDashboard() {
    const data = await api('/dashboard');
    const cards = [
      ['群组/频道', data.groups], ['用户', data.users], ['媒体文件', data.media],
      ['消息记录', data.messages], ['已标记组', data.markedGroups], ['今日收录', data.todayMedia],
      ['封禁用户', data.bannedUsers], ['白名单用户', data.whiteUsers], ['操作日志', data.logs],
      ['搬运源', data.transports]
    ];
    $('#view-dashboard').innerHTML = `
      <h2>📈 数据概览</h2>
      <div class="stats-grid">
        ${cards.map(([label, num]) => `<div class="stat-card"><div class="num">${num}</div><div class="label">${label}</div></div>`).join('')}
      </div>
      <div class="card">
        <h3 style="margin-bottom:10px">媒体类型分布</h3>
        ${data.typeDist.length ? `<table><tr><th>类型</th><th>数量</th></tr>${data.typeDist.map(t =>
          `<tr><td>${MEDIA_ICON[t._id] || '📎'} ${MEDIA_NAMES[t._id] || t._id || '未知'}</td><td>${t.count}</td></tr>`).join('')}</table>`
          : '<div class="empty">暂无数据</div>'}
      </div>`;
  }

  // ---------- 媒体库 ----------

  let mediaState = { page: 1, pageSize: 20, keyword: '', type: '', level: '', totalPages: 1 };

  async function renderMedia() {
    const q = new URLSearchParams({ page: mediaState.page, pageSize: mediaState.pageSize });
    if (mediaState.keyword) q.set('keyword', mediaState.keyword);
    if (mediaState.type) q.set('type', mediaState.type);
    if (mediaState.level) q.set('level', mediaState.level);

    const data = await api('/media?' + q.toString());
    mediaState.totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

    $('#view-media').innerHTML = `
      <h2>🎞 媒体库（共 ${data.total} 条）</h2>
      <div class="toolbar">
        <input id="media-keyword" placeholder="搜索文本..." value="${esc(mediaState.keyword)}">
        <select id="media-type">
          <option value="">全部类型</option>
          ${Object.entries(MEDIA_NAMES).map(([k, v]) => `<option value="${k}" ${mediaState.type === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <select id="media-level">
          <option value="">全部等级</option>
          ${LEVELS.map(l => `<option value="${l}" ${mediaState.level === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="btn" id="media-search">搜索</button>
      </div>
      <div class="card">
        ${data.items.length ? `<table>
          <tr><th></th><th>文本</th><th>类型</th><th>等级</th><th>原文</th><th>操作</th></tr>
          ${data.items.map(m => `<tr>
            <td>${MEDIA_ICON[m.media_type] || '📎'}</td>
            <td class="text-truncate">${esc(m.text) || '<span class="text-dim">（无文本）</span>'}</td>
            <td>${MEDIA_NAMES[m.media_type] || m.media_type || '-'}</td>
            <td>${levelBadge(m.level)}</td>
            <td><a href="https://t.me/c/${String(m.chat_id).replace(/^-100?/, '')}/${m.message_id}" target="_blank">查看 ↗</a></td>
            <td><button class="btn btn-danger btn-sm" data-del="${esc(m.file_unique_id)}">删除</button></td>
          </tr>`).join('')}
        </table>` : '<div class="empty">暂无数据</div>'}
        <div id="media-pagination"></div>
      </div>`;

    $('#media-search').onclick = () => {
      mediaState.keyword = $('#media-keyword').value.trim();
      mediaState.type = $('#media-type').value;
      mediaState.level = $('#media-level').value;
      mediaState.page = 1;
      renderMedia();
    };
    $('#media-keyword').addEventListener('keydown', e => { if (e.key === 'Enter') $('#media-search').click(); });
    pagination($('#media-pagination'), mediaState.page, mediaState.totalPages, p => { mediaState.page = p; renderMedia(); });
    document.querySelectorAll('[data-del]').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm('确定删除该媒体记录吗？（同步清理 media/message/group_list 计数）')) return;
        try {
          await api('/media/' + encodeURIComponent(btn.dataset.del), { method: 'DELETE' });
          toast('已删除');
          renderMedia();
        } catch (err) { toast(err.message, true); }
      };
    });
  }

  // ---------- 用户 ----------

  let userState = { page: 1, pageSize: 20, keyword: '', totalPages: 1 };

  async function renderUsers() {
    const q = new URLSearchParams({ page: userState.page, pageSize: userState.pageSize });
    if (userState.keyword) q.set('keyword', userState.keyword);
    const data = await api('/users?' + q.toString());
    userState.totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

    $('#view-users').innerHTML = `
      <h2>👥 用户（共 ${data.total} 人）</h2>
      <div class="toolbar">
        <input id="user-keyword" placeholder="搜索 ID 或名称..." value="${esc(userState.keyword)}">
        <button class="btn" id="user-search">搜索</button>
      </div>
      <div class="card">
        ${data.items.length ? `<table>
          <tr><th>ID</th><th>名称</th><th>状态</th><th>白名单</th><th>群组数</th><th>最近活跃</th><th>操作</th></tr>
          ${data.items.map(u => `<tr>
            <td>${u.id}</td>
            <td>${esc(u.name)}</td>
            <td>${u.state === 0 ? '<span class="badge badge-red">已封禁</span>' : '<span class="badge badge-green">正常</span>'}</td>
            <td>${u.white === 1 ? '<span class="badge badge-blue">白名单</span>' : '<span class="badge badge-gray">-</span>'}</td>
            <td>${(u.group || []).length}</td>
            <td class="text-dim">${fmtTime(u.last_seen)}</td>
            <td>${u.state === 0
              ? `<button class="btn btn-sm" data-unban="${u.id}">解封</button>`
              : `<button class="btn btn-danger btn-sm" data-ban="${u.id}">封禁</button>`}</td>
          </tr>`).join('')}
        </table>` : '<div class="empty">暂无用户</div>'}
        <div id="user-pagination"></div>
      </div>`;

    $('#user-search').onclick = () => { userState.keyword = $('#user-keyword').value.trim(); userState.page = 1; renderUsers(); };
    $('#user-keyword').addEventListener('keydown', e => { if (e.key === 'Enter') $('#user-search').click(); });
    pagination($('#user-pagination'), userState.page, userState.totalPages, p => { userState.page = p; renderUsers(); });

    document.querySelectorAll('[data-ban]').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm(`确定封禁用户 ${btn.dataset.ban} 吗？将从所有群组踢出`)) return;
        try { await api('/users/ban', { method: 'POST', body: JSON.stringify({ userId: Number(btn.dataset.ban) }) }); toast('已封禁'); renderUsers(); }
        catch (err) { toast(err.message, true); }
      };
    });
    document.querySelectorAll('[data-unban]').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm(`确定解封用户 ${btn.dataset.unban} 吗？`)) return;
        try { await api('/users/unban', { method: 'POST', body: JSON.stringify({ userId: Number(btn.dataset.unban) }) }); toast('已解封'); renderUsers(); }
        catch (err) { toast(err.message, true); }
      };
    });
  }

  // ---------- 标记记录 ----------

  let markSort = 'count';

  async function renderMarks() {
    const data = await api('/mark-records');
    const items = [...data.items].sort((a, b) => markSort === 'time'
      ? (b.last_mark_time || 0) - (a.last_mark_time || 0)
      : (b.mark || 0) - (a.mark || 0));

    $('#view-marks').innerHTML = `
      <h2>🔖 标记记录（共 ${data.total} 组）</h2>
      <div class="mark-sort-bar">
        <button class="btn btn-sm" id="mark-sort-btn">🔄 ${markSort === 'count' ? '按最后标记时间' : '按标记次数'}</button>
        <span class="text-dim">当前：${markSort === 'count' ? '按标记次数降序' : '按最后标记时间降序'}</span>
      </div>
      <div class="card">
        ${items.length ? `<table>
          <tr><th>次数</th><th></th><th>文本</th><th>类型</th><th>等级</th><th>最后标记时间</th></tr>
          ${items.map(m => `<tr>
            <td><span class="badge badge-yellow">${m.mark || 0} 次</span></td>
            <td>${MEDIA_ICON[m.media_type] || '📎'}</td>
            <td class="text-truncate">${m.chat_id && m.message_id
              ? `<a href="https://t.me/c/${String(m.chat_id).replace(/^-100?/, '')}/${m.message_id}" target="_blank">${esc(m.text) || '<span class="text-dim">（无标题）</span>'}</a>`
              : esc(m.text) || '<span class="text-dim">（无标题）</span>'}</td>
            <td>${MEDIA_NAMES[m.media_type] || '-'}</td>
            <td>${levelBadge(m.level)}</td>
            <td class="text-dim">${fmtTime(m.last_mark_time)}</td>
          </tr>`).join('')}
        </table>` : '<div class="empty">暂无标记记录</div>'}
      </div>`;

    $('#mark-sort-btn').onclick = () => { markSort = markSort === 'count' ? 'time' : 'count'; renderMarks(); };
  }

  // ---------- 群组 ----------

  async function renderGroups() {
    const data = await api('/groups');
    $('#view-groups').innerHTML = `
      <h2>🏘 群组/频道（共 ${data.total} 个）</h2>
      <div class="card">
        ${data.items.length ? `<table>
          <tr><th>ID</th><th>名称</th><th>类型</th><th>绑定频道</th><th>是否已绑定</th></tr>
          ${data.items.map(g => `<tr>
            <td>${g.id}</td>
            <td>${esc(g.name)}</td>
            <td>${g.type === 'channel' ? '<span class="badge badge-blue">频道</span>' : '<span class="badge badge-gray">群组</span>'}</td>
            <td>${g.bind_id || '-'}</td>
            <td>${g.is_bound ? '<span class="badge badge-green">已绑定</span>' : '<span class="badge badge-gray">未绑定</span>'}</td>
          </tr>`).join('')}
        </table>` : '<div class="empty">暂无群组</div>'}
      </div>`;
  }

  // ---------- 日志 ----------

  let logState = { page: 1, pageSize: 30, type: '', totalPages: 1 };

  async function renderLogs() {
    const q = new URLSearchParams({ page: logState.page, pageSize: logState.pageSize });
    if (logState.type) q.set('type', logState.type);
    const data = await api('/logs?' + q.toString());
    logState.totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

    $('#view-logs').innerHTML = `
      <h2>📜 操作日志（共 ${data.total} 条）</h2>
      <div class="toolbar">
        <select id="log-type">
          <option value="">全部类型</option>
          ${Object.entries(LOG_TYPES).map(([k, v]) => `<option value="${k}" ${logState.type === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <button class="btn" id="log-filter">筛选</button>
      </div>
      <div class="card">
        ${data.items.length ? `<table>
          <tr><th>时间</th><th>类型</th><th>用户</th><th>附加信息</th></tr>
          ${data.items.map(l => `<tr>
            <td class="text-dim">${fmtTime(l.time)}</td>
            <td>${LOG_TYPES[l.type] || l.type}</td>
            <td>${l.userId || '-'}</td>
            <td class="text-truncate">${esc(l.queryText || JSON.stringify(Object.fromEntries(Object.entries(l).filter(([k]) => !['_id', 'type', 'time', 'userId'].includes(k))))) || '-'}</td>
          </tr>`).join('')}
        </table>` : '<div class="empty">暂无日志</div>'}
        <div id="log-pagination"></div>
      </div>`;

    $('#log-filter').onclick = () => { logState.type = $('#log-type').value; logState.page = 1; renderLogs(); };
    pagination($('#log-pagination'), logState.page, logState.totalPages, p => { logState.page = p; renderLogs(); });
  }

  // ---------- 设置 ----------

  async function renderSettings() {
    const settings = await api('/settings');
    const rows = Object.entries(settings).filter(([k]) => k !== '_id');

    $('#view-settings').innerHTML = `
      <h2>⚙️ 全局设置</h2>
      <div class="card">
        ${rows.map(([key, value]) => `
          <div class="setting-row" data-key="${esc(key)}">
            <div class="setting-label">
              <div class="key">${esc(key)}</div>
              <div class="desc">当前值：<code>${esc(String(value))}</code></div>
            </div>
            <div class="setting-value" data-type="${typeof value}">
              ${typeof value === 'boolean'
                ? `<label class="switch"><input type="checkbox" ${value ? 'checked' : ''}><span class="slider"></span></label>`
                : `<input type="${typeof value === 'number' ? 'number' : 'text'}" value="${esc(value)}" style="width:160px;padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text)">`}
              <button class="btn btn-sm" data-save="${esc(key)}">保存</button>
            </div>
          </div>`).join('')}
      </div>
      <p class="text-dim">⚠️ 修改全局设置会立即生效并影响机器人行为。</p>`;

    document.querySelectorAll('[data-save]').forEach(btn => {
      btn.onclick = async () => {
        const row = btn.closest('.setting-row');
        const type = row.querySelector('.setting-value').dataset.type;
        let value;
        if (type === 'boolean') value = row.querySelector('input[type=checkbox]').checked;
        else if (type === 'number') value = Number(row.querySelector('input').value);
        else value = row.querySelector('input').value;
        try {
          await api('/settings', { method: 'POST', body: JSON.stringify({ key: btn.dataset.save, value }) });
          toast(`已更新 ${btn.dataset.save}`);
          renderSettings();
        } catch (err) { toast(err.message, true); }
      };
    });
  }

  // ---------- 搬运源 ----------

  async function renderTransports() {
    const data = await api('/transports');
    $('#view-transports').innerHTML = `
      <h2>🚚 搬运源（共 ${data.total} 个）</h2>
      <div class="card">
        ${data.items.length ? `<table>
          <tr><th>chat_id</th><th>名称</th><th>链接</th></tr>
          ${data.items.map(t => `<tr>
            <td>${t.chat_id}</td>
            <td>${esc(t.name || '-')}</td>
            <td class="text-truncate">${esc(t.url || t.link || '-')}</td>
          </tr>`).join('')}
        </table>` : '<div class="empty">暂无搬运源</div>'}
      </div>`;
  }

  // ---------- 工具 ----------

  function fmtTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ---------- 初始化 ----------

  const renderers = {
    dashboard: renderDashboard,
    media: renderMedia,
    users: renderUsers,
    marks: renderMarks,
    groups: renderGroups,
    logs: renderLogs,
    settings: renderSettings,
    transports: renderTransports
  };

  document.querySelectorAll('.nav-item').forEach(item => {
    item.onclick = () => showView(item.dataset.view);
  });
  $('#login-btn').onclick = login;
  $('#login-password').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('#logout-btn').onclick = logout;

  if (localStorage.getItem(TOKEN_KEY)) {
    api('/dashboard').then(() => enterApp()).catch(() => logout());
  }
})();
