// tests/uiStatic.test.js
/**
 * 前端静态一致性检查（无需浏览器）：
 *  1. app.js 里 $('#id') 引用的元素都必须在 index.html 中存在（否则事件绑定静默失效）
 *  2. app.js / index.html 里出现的 data-action 都必须有对应的 case 分支
 *  3. index.html 必须包含既有 Web UI 测试断言的文案（数据库控制台 / AI 翻译 / 全部数据库）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'webui', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');

function idsInHtml(src) {
  return new Set([...src.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
}
function selectorsInJs(src) {
  const ids = new Set();
  for (const m of src.matchAll(/\$\$?\('#([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1]);
  return ids;
}
function actionNamesInMarkup(src) {
  return new Set([...src.matchAll(/data-action="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
}
function handledActionsInJs(src) {
  return new Set([...src.matchAll(/case '([A-Za-z0-9_-]+)':/g)].map(m => m[1]));
}

test('index.html 包含既有测试依赖的文案', () => {
  assert.ok(html.includes('数据库控制台'), '需包含“数据库控制台”');
  assert.ok(html.includes('AI 翻译'), '需包含“AI 翻译”');
  assert.ok(html.includes('全部数据库'), '需包含“全部数据库”选项');
});

test('index.html：导航里有「随机推荐」入口', () => {
  assert.match(html, /data-view="random"/, '随机推荐视图入口');
  assert.match(html, /<span class="nav-ico">🎲<\/span><span>随机推荐<\/span>/);
});

test('index.html：导航里「数据库 / 原始数据」已改名为「数据库」', () => {
  assert.match(html, /data-view="raw"/, '数据库视图入口还在');
  assert.match(html, /<span class="nav-ico">🗄<\/span><span>数据库<\/span>/, '导航文案为「数据库」');
  assert.ok(!html.includes('数据库 / 原始数据'), '旧名字已去掉');
});

test('app.js 引用的元素 id 都存在于 index.html 或视图模板中', () => {
  // 视图 HTML 在 app.js 内以模板字符串渲染，因此模板里的 id 也算已定义
  const ids = new Set([...idsInHtml(html), ...idsInHtml(js)]);
  const missing = [...selectorsInJs(js)].filter(id => !ids.has(id));
  assert.deepStrictEqual(missing, [], `缺少这些 id 定义：${missing.join(', ')}`);
});

test('data-action 都有对应的处理分支', () => {
  const handled = handledActionsInJs(js);
  const used = new Set([
    ...actionNamesInMarkup(html),
    ...actionNamesInMarkup(js),
    ...actionNamesInMarkup(js.replace(/\\'/g, "'"))
  ]);
  const unhandled = [...used].filter(a => !handled.has(a));
  assert.deepStrictEqual(unhandled, [], `未处理的动作：${unhandled.join(', ')}`);
});

test('style.css 定义了深色与浅色两套主题变量', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  assert.ok(css.includes(':root'), '缺少 :root 设计令牌');
  assert.ok(css.includes('html[data-theme="light"]'), '缺少浅色主题变量');
});

test('style.css：方格图必须声明 7 行，否则 grid-auto-flow: column 会排成一行', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  const block = (css.match(/\.cg-grid\s*\{[^}]*\}/) || [''])[0];
  assert.ok(block, '缺少 .cg-grid 规则');
  assert.match(block, /grid-template-rows:\s*repeat\(7,/, '.cg-grid 必须显式 7 行（周一…周日）');
  assert.match(block, /grid-auto-flow:\s*column/, '.cg-grid 按列填充（每列一周）');
  assert.match(block, /grid-auto-columns:\s*minmax\(9px,\s*1fr\)/, '列宽自适应撑满卡片（窄屏兜底 9px）');
});

test('style.css：选中的标签区必须重新打开 pointer-events（否则加减标签点不动）', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  assert.match(css, /\.tag-edit\.is-locked\s*\{[^}]*pointer-events:\s*none/, '未选中时禁用鼠标事件');
  assert.match(css, /\.tag-edit\.is-active\s*\{[^}]*pointer-events:\s*auto/, '选中后必须恢复鼠标事件');
});

test('style.css：缩略图悬停放大必须「整图可见」（不裁切）', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  // 封面：固定尺寸 + cover 裁切；大图由 .thumb-zoom 浮层按完整比例展示
  const cover = (css.match(/\.media-thumb \.thumb-img,[\s\S]*?\}/) || [''])[0];
  assert.ok(cover, '缺少封面图片层 .thumb-img 规则');
  assert.match(cover, /background-size:\s*cover/, '封面 cover 裁切填满预览框');
  // 大图出现时小预览图模糊（带过渡）
  const blur = (css.match(/\.media-thumb\.is-blur[\s\S]*?\}/) || [''])[0];
  assert.ok(blur, '缺少封面模糊态 .is-blur 规则');
  assert.match(blur, /filter:\s*blur\(/, '模糊态必须真的模糊');
  assert.match(cover, /transition:[^;]*filter/, '模糊必须带过渡（否则会硬跳）');
  const zoom = (css.match(/\.thumb-zoom\s*\{[^}]*\}/) || [''])[0];
  assert.ok(zoom, '缺少 .thumb-zoom 浮层规则');
  assert.match(zoom, /position:\s*fixed/, '浮层用固定定位，避免被容器裁切');
  assert.match(css, /\.thumb-zoom img\s*\{[^}]*object-fit:\s*contain/, '浮层内按完整比例展示图片');
});

test('style.css：统计报表「操作日志明细」可查看区域已加长', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  const card = (css.match(/\.view-fill > \.stats-logs-card\s*\{[^}]*\}/) || [''])[0];
  assert.ok(card, '缺少 .stats-logs-card 规则');
  const cardH = card.match(/min-height:\s*min\((\d+)px/);
  assert.ok(cardH && Number(cardH[1]) >= 600, `日志明细卡片最小高度应 ≥600px，实际 ${cardH ? cardH[1] : '无'}`);
  const wrap = (css.match(/\.view-fill > \.stats-logs-card > \.table-wrap\s*\{[^}]*\}/) || [''])[0];
  assert.ok(wrap, '缺少日志表格区域规则');
  const wrapH = wrap.match(/min-height:\s*min\((\d+)px/);
  assert.ok(wrapH && Number(wrapH[1]) >= 500, `日志表格可滚动高度应 ≥500px，实际 ${wrapH ? wrapH[1] : '无'}`);
});
