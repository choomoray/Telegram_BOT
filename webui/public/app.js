/* Telegram Bot 数据库控制台 */
(function () {
  'use strict';

  const TOKEN_KEY = 'webui_token';
  const API = '/api';

  const $ = (sel) => document.querySelector(sel);

  const state = {
    collection: '',
    filterText: '',
    page: 1,
    pageSize: 20,
    totalPages: 1,
    autoRefresh: false,
    timer: null
  };

  // ---------- 基础 ----------

  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 3000);
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

  function parseJson(text) {
    try {
      const v = JSON.parse(text);
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('需要 JSON 对象');
      return v;
    } catch (e) {
      throw new Error(`JSON 解析失败: ${e.message}`);
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
    stopAutoRefresh();
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
  }

  async function loadCollections() {
    const data = await api('/db/collections');
    const sel = $('#collection-select');
    sel.innerHTML = data.collections.map(c => `<option value="${c}">${c}</option>`).join('');
    state.collection = data.collections[0] || '';
    await runQuery(1);
  }

  async function enterApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    try {
      await loadCollections();
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- 查询 ----------

  async function runQuery(page = state.page) {
    if (!state.collection) return;
    state.page = page;
    let filter = {};
    if (state.filterText.trim()) {
      try {
        filter = parseJson(state.filterText);
      } catch (e) {
        toast(e.message, true);
        return;
      }
    }
    try {
      const data = await api('/db/query', {
        collection: state.collection,
        filter,
        page: state.page,
        pageSize: state.pageSize
      });
      state.totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
      renderTable(data);
      renderPagination();
      $('#op-collection').textContent = state.collection;
    } catch (err) {
      toast(err.message, true);
    }
  }

  function renderTable(data) {
    const tbody = $('#data-tbody');
    const empty = $('#data-empty');
    $('#data-meta').textContent = `集合 ${state.collection}：共 ${data.total} 条，第 ${data.page}/${state.totalPages} 页（每页 ${data.pageSize} 条）`;
    if (!data.items.length) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    tbody.innerHTML = data.items.map((doc, i) => {
      const globalIdx = (data.page - 1) * data.pageSize + i + 1;
      return `<tr><td class="text-dim">${globalIdx}</td><td><div class="doc-json">${esc(JSON.stringify(doc, null, 2))}</div></td></tr>`;
    }).join('');
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

  // ---------- AI 查询 ----------

  async function aiGenerate() {
    const prompt = $('#ai-prompt').value.trim();
    if (!prompt) { toast('请输入自然语言查询描述', true); return; }
    const status = $('#ai-status');
    status.textContent = 'AI 翻译中...';
    try {
      const data = await api('/ai/query', { collection: state.collection, prompt });
      $('#filter-input').value = JSON.stringify(data.filter);
      state.filterText = $('#filter-input').value;
      toast(`✅ ${data.explain || '已生成查询条件（未执行，可编辑后点查询）'}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      status.textContent = '';
    }
  }

  // ---------- 数据库操作 ----------

  async function doInsert() {
    try {
      const data = parseJson($('#insert-data').value);
      const r = await api('/db/insert', { collection: state.collection, data });
      showResult(r);
      toast('✅ 插入成功');
      $('#insert-data').value = '';
      await runQuery(1);
    } catch (err) { showResult({ error: err.message }, true); }
  }

  async function doUpdate() {
    try {
      const filter = getCurrentFilter();
      const data = parseJson($('#update-data').value);
      const r = await api('/db/update', { collection: state.collection, filter, data });
      showResult(r);
      toast(r.matchedCount ? '✅ 更新成功' : '⚠️ 未匹配到文档');
      if (r.matchedCount) $('#update-data').value = '';
      await runQuery();
    } catch (err) { showResult({ error: err.message }, true); }
  }

  async function doDelete() {
    try {
      const filter = getCurrentFilter();
      if (!confirm(`⚠️ 二次确认：确定删除 ${state.collection} 中满足以下条件的文档吗？\n\n${JSON.stringify(filter, null, 2)}`)) return;
      const r = await api('/db/delete', { collection: state.collection, filter, confirm: true });
      showResult(r);
      toast(r.deletedCount ? '🗑️ 删除成功' : '⚠️ 未匹配到文档');
      await runQuery(1);
    } catch (err) { showResult({ error: err.message }, true); }
  }

  function getCurrentFilter() {
    if (!state.filterText.trim()) throw new Error('查询栏 filter 为空，请先填写条件（修改/删除需精确定位）');
    return parseJson(state.filterText);
  }

  function showResult(data, isError = false) {
    const box = $('#result-box');
    box.classList.toggle('error', isError);
    box.textContent = JSON.stringify(data, null, 2);
  }

  // ---------- 自动刷新 ----------

  function toggleAutoRefresh() {
    state.autoRefresh = $('#auto-refresh').checked;
    if (state.autoRefresh) {
      stopAutoRefresh();
      state.timer = setInterval(() => { if (!document.hidden) runQuery(state.page); }, 5000);
      toast('已开启自动刷新（5秒）');
    } else {
      stopAutoRefresh();
    }
  }

  function stopAutoRefresh() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  // ---------- 工具 ----------

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 事件绑定 ----------

  $('#login-btn').onclick = login;
  $('#login-password').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('#logout-btn').onclick = logout;

  $('#collection-select').onchange = () => {
    state.collection = $('#collection-select').value;
    state.filterText = '';
    $('#filter-input').value = '';
    runQuery(1);
  };
  $('#query-btn').onclick = () => {
    state.filterText = $('#filter-input').value;
    runQuery(1);
  };
  $('#filter-input').addEventListener('keydown', e => { if (e.key === 'Enter') { state.filterText = e.target.value; runQuery(1); } });
  $('#refresh-btn').onclick = () => runQuery(state.page);
  $('#auto-refresh').onchange = toggleAutoRefresh;

  $('#ai-query-btn').onclick = () => {
    const area = $('#ai-input-area');
    area.classList.toggle('hidden');
    if (!area.classList.contains('hidden')) $('#ai-prompt').focus();
  };
  $('#ai-generate-btn').onclick = aiGenerate;
  $('#ai-prompt').addEventListener('keydown', e => { if (e.key === 'Enter') aiGenerate(); });

  $('#insert-btn').onclick = doInsert;
  $('#update-btn').onclick = doUpdate;
  $('#delete-btn').onclick = doDelete;

  // 初始化：有 token 则验证进入，否则显示登录页（login-view 默认可见）
  if (localStorage.getItem(TOKEN_KEY)) {
    enterApp();
  }
})();
