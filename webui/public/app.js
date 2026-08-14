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
    sort: { _id: -1 },        // 排序：默认最新在前（_id 倒序）
    page: 1,
    pageSize: 50,
    totalPages: 1,
    selected: null,       // { collection, doc, key }
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
    stopAutoRefresh();
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
  }

  async function enterApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    try {
      const data = await api('/db/collections');
      state.collections = data.collections;
      const options = `<option value="${ALL_KEY}">全部数据库</option>` +
        data.collections.map(c => `<option value="${c}">${c}</option>`).join('');
      $('#collection-select-top').innerHTML = options;
      $('#collection-select-op').innerHTML = options;
      startLogStream();
      await runQuery(1);
    } catch (err) {
      toast(err.message, true);
    }
  }

  // 两个数据库选择（顶部 + 操作区）双向同步
  function syncCollectionSelect(from) {
    const top = $('#collection-select-top');
    const op = $('#collection-select-op');
    const val = from === 'top' ? top.value : op.value;
    if (top.value !== val) top.value = val;
    if (op.value !== val) op.value = val;
    state.collection = val;
    updateInsertBtn();
  }

  function updateInsertBtn() {
    $('#insert-btn').disabled = state.collection === ALL_KEY;
  }

  // ---------- 定时刷新 ----------

  function toggleAutoRefresh() {
    state.autoRefresh = $('#auto-refresh').checked;
    if (state.autoRefresh) {
      stopAutoRefresh();
      state.timer = setInterval(() => { if (!document.hidden) runQuery(state.page); }, 5000);
      toast('已开启定时刷新（5 秒）');
    } else {
      stopAutoRefresh();
    }
  }

  function stopAutoRefresh() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  // ---------- 查询与渲染 ----------

  async function runQuery(page = state.page) {
    state.page = page;
    try {
      const data = await api('/db/query', { collection: state.collection, sort: state.sort, page: state.page, pageSize: state.pageSize });
      renderData(data);
    } catch (err) {
      toast(err.message, true);
    }
  }

  function renderData(data) {
    const list = $('#data-list');
    const meta = $('#data-meta');

    if (data.all) {
      // 全部数据库模式：仅显示集合名 + 条数，点击切换
      meta.textContent = '跨集合浏览（每集合最多显示 50 条，点击文档可选中）';
      $('#sort-select').style.display = 'none';
      list.innerHTML = '';
      $('#pagination').innerHTML = '';
      const groups = data.groups.filter(g => g.total > 0);
      if (!groups.length) {
        list.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center">未找到数据</div>';
        return;
      }
      groups.forEach(g => {
        const row = document.createElement('div');
        row.className = 'col-summary';
        row.innerHTML = `📁 <b>${esc(g.collection)}</b> <span class="count">共 ${g.total} 条</span>`;
        row.onclick = () => {
          syncCollectionSelectTo(g.collection);
          runQuery(1);
        };
        list.appendChild(row);
      });
      state.totalPages = 1;
      return;
    }

    // 指定集合模式：文档卡片 + 分页（顶部靠右）
    state.totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    $('#sort-select').style.display = '';
    meta.textContent = `集合 ${data.collection}：共 ${data.total} 条`;
    if (!data.items.length) {
      list.innerHTML = '<div class="text-dim" style="padding:20px;text-align:center">未找到数据</div>';
    } else {
      list.innerHTML = data.items.map(doc => docCard(data.collection, doc)).join('');
    }
    renderPagination();
    bindDocEvents();
    updateSelectedUI();
  }

  function docCard(collection, doc) {
    const key = collection + ':' + (doc._id || JSON.stringify(doc).slice(0, 20));
    return `<div class="doc-card" data-key="${esc(key)}" data-collection="${esc(collection)}" data-json="${esc(JSON.stringify(doc))}">
      <div class="doc-main">
        <div class="doc-json">${esc(JSON.stringify(doc, null, 2))}</div>
        <div class="doc-side">
          <div class="doc-actions">
            <button class="btn btn-sm" data-action="edit" title="修改数据">✏️ 修改数据</button>
            <button class="btn btn-danger btn-sm" data-action="del" title="删除数据">🗑️ 删除数据</button>
          </div>
        </div>
      </div>
      <div class="doc-edit">
        <textarea class="doc-edit-input" spellcheck="false"></textarea>
        <div class="doc-edit-actions">
          <button class="btn btn-success btn-sm" data-action="edit-confirm">✓ 确认</button>
          <button class="btn btn-ghost btn-sm" data-action="edit-cancel">✕ 取消</button>
        </div>
      </div>
    </div>`;
  }

  // 数据区事件委托：选中 / 修改 / 删除 / 插入
  function bindDocEvents() {
    const list = $('#data-list');
    list.querySelectorAll('.doc-card').forEach(card => {
      card.addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        if (btn) {
          await handleCardAction(card, btn.dataset.action);
          return;
        }
        // 点击卡片本体（非按钮）：选中 / 取消选中
        const collection = card.dataset.collection;
        const doc = JSON.parse(card.dataset.json);
        toggleSelect(collection, doc);
      });
    });
  }

  async function handleCardAction(card, action) {
    const collection = card.dataset.collection;
    // 插入卡片没有 data-json，容错处理
    let doc = {};
    try { doc = JSON.parse(card.dataset.json); } catch { /* ignore */ }
    const jsonEl = card.querySelector('.doc-json');
    const editBox = card.querySelector('.doc-edit');
    const actionsEl = card.querySelector('.doc-actions');

    switch (action) {
      case 'edit': {
        card.classList.add('editing');
        const clean = { ...doc };
        delete clean._id;
        const ta = card.querySelector('.doc-edit-input');
        ta.value = JSON.stringify(clean, null, 2);
        autoResizeTextarea(ta);
        break;
      }
      case 'edit-cancel': {
        card.classList.remove('editing');
        break;
      }
      case 'edit-confirm': {
        try {
          const data = parseJson(card.querySelector('.doc-edit-input').value, '数据');
          delete data._id;
          const r = await api('/db/execute', {
            operation: { action: 'update', collection, filter: { _id: doc._id }, data }
          });
          showResult(r.matchedCount ? `✅ 修改成功（匹配 ${r.matchedCount} 条）` : '⚠️ 未匹配到文档', !r.matchedCount);
          toast(r.matchedCount ? '✅ 修改成功' : '⚠️ 未匹配到文档', !r.matchedCount);
          await runQuery(state.page);
        } catch (err) { showResult(`❌ 修改失败：${err.message}`, true); }
        break;
      }
      case 'del': {
        // 进入删除确认态：按钮变为 确认删除 / 取消
        actionsEl.innerHTML = `
          <button class="btn btn-danger btn-sm" data-action="del-confirm">⚠️ 确认删除</button>
          <button class="btn btn-ghost btn-sm" data-action="del-cancel">✕ 取消</button>`;
        card.classList.add('del-confirming');
        break;
      }
      case 'del-cancel': {
        actionsEl.innerHTML = `
          <button class="btn btn-sm" data-action="edit">✏️ 修改数据</button>
          <button class="btn btn-danger btn-sm" data-action="del">🗑️ 删除数据</button>`;
        card.classList.remove('del-confirming');
        break;
      }
      case 'del-confirm': {
        if (!window.confirm(`⚠️ 二次确认：确定删除 ${collection} 中的该文档吗？\n\n${JSON.stringify(doc, null, 2)}`)) {
          actionsEl.innerHTML = `
            <button class="btn btn-sm" data-action="edit">✏️ 修改数据</button>
            <button class="btn btn-danger btn-sm" data-action="del">🗑️ 删除数据</button>`;
          card.classList.remove('del-confirming');
          return;
        }
        try {
          const r = await api('/db/execute', {
            operation: { action: 'delete', collection, filter: { _id: doc._id } },
            confirm: true
          });
          showResult(r.deletedCount ? `🗑️ 删除成功（${r.deletedCount} 条）` : '⚠️ 未匹配到文档', !r.deletedCount);
          toast(r.deletedCount ? '🗑️ 删除成功' : '⚠️ 未匹配到文档', !r.deletedCount);
          if (state.selected && state.selected.key === card.dataset.key) state.selected = null;
          await runQuery(1);
        } catch (err) { showResult(`❌ 删除失败：${err.message}`, true); }
        break;
      }
      case 'insert-confirm': {
        try {
          const data = parseJson(card.querySelector('.doc-edit-input').value, '数据');
          const r = await api('/db/execute', { operation: { action: 'insert', collection, data } });
          showResult(`✅ 插入成功（${r.insertedId}）`, false);
          toast('✅ 插入成功');
          card.remove();
          await runQuery(1);
        } catch (err) { showResult(`❌ 插入失败：${err.message}`, true); }
        break;
      }
      case 'insert-cancel': {
        card.remove();
        showResult('—', false);
        break;
      }
      default:
        break;
    }
  }

  // ---------- 选中 ----------

  function toggleSelect(collection, doc) {
    const key = collection + ':' + (doc._id || JSON.stringify(doc).slice(0, 20));
    if (state.selected && state.selected.key === key) {
      state.selected = null; // 再次点击取消选中
    } else {
      state.selected = { collection, doc, key };
    }
    updateSelectedUI();
  }

  function updateSelectedUI() {
    const btn = $('#selected-btn');
    if (state.selected) {
      btn.disabled = false;
      btn.classList.remove('selected-off');
      btn.classList.add('selected-on');
      btn.textContent = '✅ 已选中';
      btn.title = `已选中 ${state.selected.collection} 中的文档，点击取消`;
    } else {
      btn.disabled = true;
      btn.classList.remove('selected-on');
      btn.classList.add('selected-off');
      btn.textContent = '未选中';
      btn.title = '点击右侧数据可选中';
    }
    document.querySelectorAll('.doc-card').forEach(el => {
      el.classList.toggle('selected', el.dataset.key === (state.selected ? state.selected.key : ''));
    });
  }

  // ---------- AI 翻译与执行 ----------

  async function aiTranslate() {
    const prompt = $('#prompt-input').value.trim();
    if (!prompt) { toast('请输入自然语言操作描述', true); return; }
    // 立即弹出 AI 翻译面板，显示等待状态
    openAiPanel();
    $('#ai-explain').textContent = '⏳ 正在 AI 翻译，请稍等...';
    $('#op-json').value = '';
    try {
      const payload = { prompt };
      if (state.selected) {
        payload.selected = { collection: state.selected.collection, doc: state.selected.doc };
      }
      const data = await api('/ai/plan', payload);
      $('#ai-explain').textContent = data.explain || '';
      $('#op-json').value = JSON.stringify(data.operation, null, 2);
      autoResizeTextarea($('#op-json'));
      showResult(`✅ AI 已翻译，确认后点【执行】`, false);
      toast('✅ 已翻译，确认后点【执行】');
    } catch (err) {
      $('#ai-explain').textContent = '❌ 翻译失败';
      showResult(`❌ AI 翻译失败：${err.message}`, true);
      toast(err.message, true);
    }
  }

  function openAiPanel() {
    $('#ai-panel').classList.remove('hidden');
    document.querySelector('.panel-left').classList.add('ai-open');
  }

  function closeAiPanel() {
    $('#ai-panel').classList.add('hidden');
    document.querySelector('.panel-left').classList.remove('ai-open');
  }

  // textarea 高度自适应：按内容行数，最大 10 行
  function autoResizeTextarea(el) {
    el.style.height = 'auto';
    const lineHeight = 18;
    const maxH = lineHeight * 10 + 14; // 最多 10 行
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
  }

  async function doExecute() {
    let operation;
    try {
      operation = parseJson($('#op-json').value.trim(), '操作');
    } catch (e) {
      showResult(`❌ ${e.message}`, true);
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
        if (!confirm) { showResult('已取消删除', true); return; }
      }
      const data = await api('/db/execute', { operation, confirm });
      if (data.type === 'query') {
        // 查询结果渲染到右侧数据区（支持修改/删除）
        renderExecResult(data.items, operation.collection);
        showResult(`✅ 执行成功：查询 ${data.total} 条`, false);
      } else {
        const brief = {
          insert: `插入成功 ${data.insertedId}`,
          update: `修改 ${data.modifiedCount} 条（匹配 ${data.matchedCount}）`,
          delete: `删除 ${data.deletedCount} 条`
        }[data.type] || JSON.stringify(data);
        showResult(`✅ 执行成功：${brief}`, false);
        await runQuery(1);
      }
      toast('✅ 执行完成');
    } catch (err) {
      showResult(`❌ 执行失败：${err.message}`, true);
    }
  }

  // 执行查询后：结果渲染到右侧数据区（复用卡片，支持修改/删除）
  function renderExecResult(items, collection) {
    state.totalPages = 1;
    $('#pagination').innerHTML = '';
    $('#data-meta').textContent = `执行结果：查询 ${items.length} 条（集合 ${collection}）`;
    $('#data-list').innerHTML = items.length
      ? items.map(doc => docCard(collection, doc)).join('')
      : '<div class="text-dim" style="padding:20px;text-align:center">未找到数据</div>';
    bindDocEvents();
    updateSelectedUI();
  }

  function showResult(text, isError) {
    const box = $('#result-line');
    box.classList.toggle('error', isError);
    box.textContent = text;
  }

  // ---------- 插入数据 ----------

  function insertData() {
    if (state.collection === ALL_KEY) return;
    // 生成字段模板：取当前列表第一条文档的字段（值置空）
    let template = {};
    const firstJson = document.querySelector('.doc-card .doc-json');
    if (firstJson) {
      try {
        const doc = JSON.parse(firstJson.textContent);
        for (const k of Object.keys(doc)) {
          if (k !== '_id') template[k] = '';
        }
      } catch { /* ignore */ }
    }
    const list = $('#data-list');
    const card = document.createElement('div');
    card.className = 'doc-card insert-card';
    card.dataset.collection = state.collection;
    card.innerHTML = `
      <div class="doc-main">
        <div class="doc-json"></div>
        <div class="doc-side">
          <div class="doc-edit">
            <textarea class="doc-edit-input" spellcheck="false">${esc(JSON.stringify(template, null, 2))}</textarea>
          </div>
          <div class="doc-actions">
            <button class="btn btn-success btn-sm" data-action="insert-confirm" title="确认插入">✅ 确认</button>
            <button class="btn btn-ghost btn-sm" data-action="insert-cancel" title="取消">✕ 取消</button>
          </div>
        </div>
      </div>`;
    card.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (btn) await handleCardAction(card, btn.dataset.action);
    });
    list.prepend(card);
    autoResizeTextarea(card.querySelector('.doc-edit-input'));
    toast('请填写数据后点【确认】插入，或点【取消】放弃');
  }

  // ---------- 分页 ----------

  function renderPagination() {
    const wrap = $('#pagination');
    wrap.innerHTML = '';
    const N = state.totalPages;
    if (N <= 1) return;

    const addBtn = (label, page, cls) => {
      const b = document.createElement('button');
      b.className = 'btn btn-sm' + (cls ? ' ' + cls : '');
      b.textContent = label;
      if (!cls) b.onclick = () => runQuery(page);
      wrap.appendChild(b);
    };
    const addEllipsis = () => {
      const el = document.createElement('span');
      el.className = 'page-ellipsis';
      el.textContent = '···';
      wrap.appendChild(el);
    };

    // 格式：1 ··· 12 13 14 ··· 123 [输入][跳转]
    addBtn('1', 1, state.page === 1 ? 'page-current' : '');
    if (state.page > 3) addEllipsis();
    for (let i = Math.max(2, state.page - 1); i <= Math.min(N - 1, state.page + 1); i++) {
      addBtn(String(i), i, i === state.page ? 'page-current' : '');
    }
    if (state.page < N - 2) addEllipsis();
    if (N > 1) addBtn(String(N), N, state.page === N ? 'page-current' : '');

    const input = document.createElement('input');
    input.type = 'number';
    input.min = 1;
    input.max = N;
    input.placeholder = '页码';
    input.className = 'page-input';
    const jump = () => {
      const v = parseInt(input.value, 10);
      if (v >= 1 && v <= N) runQuery(v);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(); });
    const go = document.createElement('button');
    go.className = 'btn btn-sm';
    go.textContent = '跳转';
    go.onclick = jump;
    wrap.append(input, go);
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
    const level = String(entry.level || 'info').toUpperCase().slice(0, 4);
    const div = document.createElement('div');
    div.className = 'log-line';
    // 与后端 chalk 一致：时间戳灰、[级别] 标签着色、消息正文默认色
    div.innerHTML = `<span class="log-time">[${esc(time)}]</span> <span class="log-level ${levelClass}">[${esc(level)}]</span> ${esc(entry.message || '')}`;
    list.appendChild(div);
    while (list.children.length > 600) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
  }

  // ---------- 工具 ----------

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function syncCollectionSelectTo(name) {
    const top = $('#collection-select-top');
    const op = $('#collection-select-op');
    top.value = name;
    op.value = name;
    state.collection = name;
    updateInsertBtn();
  }

  // ---------- 事件绑定 ----------

  $('#login-btn').onclick = login;
  $('#login-password').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('#logout-btn').onclick = () => { stopAutoRefresh(); logout(); };
  $('#refresh-btn').onclick = () => runQuery(state.page);
  $('#auto-refresh').onchange = toggleAutoRefresh;

  $('#collection-select-top').onchange = () => { syncCollectionSelect('top'); runQuery(1); };
  $('#collection-select-op').onchange = () => { syncCollectionSelect('op'); runQuery(1); };
  $('#sort-select').onchange = () => {
    state.sort = $('#sort-select').value === 'asc' ? { _id: 1 } : { _id: -1 };
    runQuery(1);
  };

  $('#insert-btn').onclick = insertData;
  $('#selected-btn').onclick = () => {
    if (state.selected) {
      state.selected = null;
      updateSelectedUI();
      toast('已取消选中');
    }
  };

  $('#ai-btn').onclick = aiTranslate;
  $('#prompt-input').addEventListener('keydown', e => { if (e.key === 'Enter') aiTranslate(); });
  $('#exec-btn').onclick = doExecute;
  $('#ai-close-btn').onclick = closeAiPanel;

  // 全局 textarea 高度自适应（AI 编辑框 / 卡片编辑框，最多 10 行）
  document.addEventListener('input', (e) => {
    if (e.target && (e.target.classList.contains('op-json') || e.target.classList.contains('doc-edit-input'))) {
      autoResizeTextarea(e.target);
    }
  });

  // 初始化：有 token 则验证进入，否则显示登录页（login-view 默认可见）
  if (localStorage.getItem(TOKEN_KEY)) {
    enterApp();
  }
})();
