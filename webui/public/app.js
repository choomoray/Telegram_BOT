/* Telegram Bot 数据库控制台 */
(function () {
  'use strict';

  const TOKEN_KEY = 'webui_token';
  const API = '/api';
  const ALL_KEY = '__all__';

  const $ = (sel) => document.querySelector(sel);

  const state = {
    collections: [],
    collection: ALL_KEY,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    selected: null,       // { collection, doc }
    logCount: 0
  };

  // ---------- 基础 ----------

  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  async function api(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(API + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 401) {
      logout();
      throw new Error('会话已过期，请重新登录');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  function parseJson(text, label = 'JSON') {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`${label}解析失败: ${e.message}`);
    }
  }

  // ---------- 登录 ----------

  async function login() {
    const password = $('#login-password').value;
    if (!password) return;
    try {
      const res = await fetch(API + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
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
    stopLogStream();
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
  }

  async function enterApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    try {
      const data = await api('/db/collections');
      state.collections = data.collections;
      const sel = $('#collection-select');
      sel.innerHTML = `<option value="${ALL_KEY}">全部数据库</option>` +
        data.collections.map(c => `<option value="${c}">${c}</option>`).join('');
      startLogStream();
      await runQuery(1);
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- 查询与渲染 ----------

  async function runQuery(page = state.page) {
    state.page = page;
    const data = await api('/db/query', { collection: state.collection, page: state.page, pageSize: state.pageSize });
    renderData(data);
  }

  function renderData(data) {
    const list = $('#data-list');
    const meta = $('#data-meta');

    if (data.all) {
      meta.textContent = `跨集合浏览（每集合最多显示 ${data.limit} 条，点击文档可选中）`;
      const groups = data.groups.filter(g => g.items.length > 0 || g.total > 0);
      if (!groups.length) {
        list.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center">未找到数据</div>';
        state.totalPages = 1;
        renderPagination();
        return;
      }
      state.totalPages = 1;
      list.innerHTML = groups.map(g => `
        <div class="col-group">
          <div class="col-group-title">📁 ${g.collection} <span class="count">共 ${g.total} 条${g.items.length < g.total ? `，显示前 ${g.items.length} 条` : ''}</span></div>
          ${g.items.map(doc => docCard(g.collection, doc)).join('')}
        </div>`).join('');
    } else {
      state.totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
      meta.textContent = `集合 ${data.collection}：共 ${data.total} 条，第 ${data.page}/${state.totalPages} 页（每页 ${data.pageSize} 条）`;
      list.innerHTML = data.items.length
        ? data.items.map(doc => docCard(data.collection, doc)).join('')
        : '<div class="text-dim" style="padding:20px;text-align:center">未找到数据</div>';
      renderPagination();
    }

    bindDocCards();
    updateSelectedUI();
  }

  function docCard(collection, doc) {
    const key = collection + ':' + (doc._id || JSON.stringify(doc).slice(0, 20));
    return `<div class="doc-card" data-key="${esc(key)}" data-collection="${esc(collection)}" data-json="${esc(JSON.stringify(doc))}">
      <div class="doc-json">${esc(JSON.stringify(doc, null, 2))}</div>
    </div>`;
  }

  function bindDocCards() {
    document.querySelectorAll('.doc-card').forEach(card => {
      card.onclick = () => {
        const collection = card.dataset.collection;
        const doc = JSON.parse(card.dataset.json);
        toggleSelect(collection, doc);
      };
    });
  }

  function renderPagination() {
    const wrap = $('#pagination');
    wrap.innerHTML = '';
    if (state.totalPages <= 1) return;
    const prev = document.createElement('button');
    prev.className = 'btn btn-sm';
    prev.textContent = '⬅ 上一页';
    prev.disabled = state.page <= 1;
    prev.onclick = () => runQuery(state.page - 1);
    const info = document.createElement('span');
    info.className = 'page-info';
    info.textContent = `${state.page} / ${state.totalPages}`;
    const next = document.createElement('button');
    next.className = 'btn btn-sm';
    next.textContent = '下一页 ➡';
    next.disabled = state.page >= state.totalPages;
    next.onclick = () => runQuery(state.page + 1);
    wrap.append(prev, info, next);
  }

  // ---------- 选中 ----------

  function toggleSelect(collection, doc) {
    const key = collection + ':' + (doc._id || JSON.stringify(doc).slice(0, 20));
    if (state.selected && state.selected.collection === collection &&
        (state.selected.doc._id || 'x') === (doc._id || 'y') && state.selected._key === key) {
      state.selected = null; // 再次点击取消选中
    } else {
      state.selected = { collection, doc, _key: key };
    }
    updateSelectedUI();
  }

  function updateSelectedUI() {
    const btn = $('#selected-btn');
    if (state.selected) {
      btn.classList.remove('selected-off');
      btn.classList.add('selected-on');
      btn.textContent = '✅ 已选中';
      btn.title = `已选中 ${state.selected.collection} 中的文档`;
    } else {
      btn.classList.remove('selected-on');
      btn.classList.add('selected-off');
      btn.textContent = '未选中';
      btn.title = '点击右侧数据可选中';
    }
    document.querySelectorAll('.doc-card').forEach(el => {
      el.classList.toggle('selected', el.dataset.key === (state.selected ? state.selected._key : ''));
    });
  }

  // ---------- AI 翻译与执行 ----------

  async function aiTranslate() {
    const prompt = $('#prompt-input').value.trim();
    if (!prompt) { toast('请输入自然语言操作描述', true); return; }
    try {
      const payload = { prompt };
      if (state.selected) {
        payload.selected = { collection: state.selected.collection, doc: state.selected.doc };
      }
      const data = await api('/ai/plan', payload);
      $('#op-json').value = JSON.stringify(data.operation, null, 2);
      showResult(`🔍 AI 翻译：${data.explain}\n\n（可编辑上方 JSON，点【执行】执行）`, false);
      toast('✅ 已翻译，确认后点【执行】');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function doExecute() {
    let operation;
    try {
      operation = parseJson($('#op-json').value.trim(), '操作');
    } catch (e) {
      showResult(e.message, true);
      return;
    }
    if (!operation || !operation.action || !operation.collection) {
      showResult('❌ 操作 JSON 缺少 action / collection 字段', true);
      return;
    }
    try {
      let confirm = false;
      if (operation.action === 'delete') {
        confirm = window.confirm(`⚠️ 二次确认：确定执行删除操作吗？\n\n${JSON.stringify(operation, null, 2)}`);
        if (!confirm) { toast('已取消删除', true); return; }
      }
      const data = await api('/db/execute', { operation, confirm });
      showResult(`✅ 执行成功：\n${JSON.stringify(data, null, 2)}`, false);
      toast('✅ 执行完成');
      await runQuery(1); // 执行后刷新数据
    } catch (err) {
      showResult(`❌ 执行失败：${err.message}`, true);
    }
  }

  function showResult(text, isError) {
    const box = $('#result-box');
    box.classList.toggle('error', isError);
    box.textContent = text;
  }

  // ---------- SSE 日志流 ----------

  let logSource = null;

  function startLogStream() {
    stopLogStream();
    const token = localStorage.getItem(TOKEN_KEY);
    const source = new EventSource(`${API}/logs/stream?token=${encodeURIComponent(token)}`);
    source.onopen = () => { $('#log-status').textContent = '已连接'; };
    source.onmessage = (e) => {
      try { appendLog(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    source.onerror = () => { $('#log-status').textContent = '重连中...'; };
    logSource = source;
  }

  function stopLogStream() {
    if (logSource) { logSource.close(); logSource = null; }
  }

  function appendLog(entry) {
    const list = $('#log-list');
    const levelClass = { info: 'log-info', success: 'log-success', warn: 'log-warn', error: 'log-error' }[entry.level] || 'log-info';
    const time = (entry.timestamp || '').slice(0, 19) || '';
    const div = document.createElement('div');
    div.className = `log-line ${levelClass}`;
    div.innerHTML = `<span class="log-time">[${esc(time)}]</span> [${esc((entry.level || 'info').toUpperCase())}] ${esc(entry.message || '')}`;
    list.appendChild(div);
    // 限制最多 600 条
    while (list.children.length > 600) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
    state.logCount++;
  }

  // ---------- 工具 ----------

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 事件绑定 ----------

  $('#login-btn').onclick = login;
  $('#login-password').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('#logout-btn').onclick = logout;
  $('#refresh-btn').onclick = () => runQuery(state.page);

  $('#collection-select').onchange = () => {
    state.collection = $('#collection-select').value;
    runQuery(1);
  };

  $('#selected-btn').onclick = () => {
    // 点击选中按钮：取消选中（若有）
    if (state.selected) {
      state.selected = null;
      updateSelectedUI();
      toast('已取消选中');
    }
  };

  $('#ai-btn').onclick = aiTranslate;
  $('#prompt-input').addEventListener('keydown', e => { if (e.key === 'Enter') aiTranslate(); });
  $('#exec-btn').onclick = doExecute;

  // 初始化：有 token 则验证进入，否则显示登录页（login-view 默认可见）
  if (localStorage.getItem(TOKEN_KEY)) {
    enterApp();
  }
})();
