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

test('style.css：随机推荐瀑布流（列数随屏幕宽度阶梯变化 + 图片完整显示不裁切 + 文字在图片下方）', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');

  // 瀑布流容器：多列（columns = masonry），不再是一行行等高的 grid
  const flowGrid = (css.match(/\.media-grid--flow\s*\{[^}]*\}/) || [''])[0];
  assert.ok(flowGrid, '缺少 .media-grid--flow 规则');
  assert.match(flowGrid, /columns:\s*\d+/, '瀑布流用多列布局（按内容高度堆叠）');

  // 列数阶梯：按窗口宽度自动选列数，手机 2 列、桌面 5~6 列，且从窄到宽排列
  const steps = [...css.matchAll(/@media \(min-width:\s*(\d+)px\)\s*\{\s*\.media-grid--flow\s*\{\s*columns:\s*(\d+)/g)]
    .map(m => ({ width: Number(m[1]), cols: Number(m[2]) }));
  assert.ok(steps.length >= 4, `列数阶梯至少要有 4 档，实际 ${steps.length} 档`);
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i].width > steps[i - 1].width, '断点必须从窄到宽排列（否则后面的规则会覆盖前面的）');
    assert.ok(steps[i].cols >= steps[i - 1].cols, '越宽的屏幕列数不能减少');
  }
  assert.ok(steps[0].cols <= 2, '手机档最多 2 列');
  assert.ok(steps[steps.length - 1].cols >= 5, '大屏档至少 5 列');
  assert.ok(steps[steps.length - 1].cols <= 6, '列数封顶 6 列（更宽的屏幕不再加列，避免封面过小）');

  // 封面：完整显示（contain）而不是 16:10 裁切，高度由图片真实比例决定
  assert.ok(!/aspect-ratio:\s*16\s*\/\s*10/.test((css.match(/\.media-thumb--flow\s*\{[^}]*\}/) || [''])[0]),
    '瀑布流封面不能再锁 16:10');
  const flowCover = (css.match(/\.media-thumb--flow \.thumb-img--flow\s*\{[^}]*\}/) || [''])[0];
  assert.ok(flowCover, '缺少 .media-thumb--flow .thumb-img--flow 规则');
  assert.match(flowCover, /background-size:\s*contain/, '瀑布流封面完整显示、不裁切');
  assert.ok(!/background-size:\s*cover/.test(flowCover), '瀑布流封面不能用 cover 裁切');
  // 里面那张"隐形真图"要显示出来，作为可见图片本身
  const flowProbe = (css.match(/\.media-thumb--flow \.thumb-img--flow \.thumb-src\s*\{[^}]*\}/) || [''])[0];
  assert.ok(flowProbe, '缺少瀑布流里真图的显示规则');
  assert.match(flowProbe, /position:\s*relative/, '真图要参与文档流（用它的高度撑开封面）');
  assert.match(flowProbe, /opacity:\s*1/, '真图在瀑布流里要真正可见');

  // 文字仍在图片下方：body 是纵向块（沿用 .media-body）
  const body = (css.match(/\.media-body\s*\{[^}]*\}/) || [''])[0];
  assert.match(body, /flex-direction:\s*column/, '卡片文字区仍在图片下方（纵向）');
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

test('style.css：媒体详情左右两栏各自独立滚动（每栏一根滚动条、高度只由自己内容决定）', () => {
    const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
    // 注意锚定行首：否则会误匹配 .dialog-body.has-detail-main > .detail-main 这类组合选择器
    const ruleOf = (sel) => (css.match(new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`, 'm')) || [''])[0];
    // 两栏各自滚动
    const left = ruleOf('.detail-left');
    assert.ok(left, '缺少 .detail-left 规则');
    assert.match(left, /overflow-y:\s*auto/, '左栏（媒体）要有自己的滚动条');
    assert.match(left, /max-height:/, '左栏高度要有上限（超出才滚动）');
    const aside = ruleOf('.detail-aside');
    assert.ok(aside, '缺少 .detail-aside 规则');
    assert.match(aside, /overflow-y:\s*auto/, '右栏（描述与标签）要有自己的滚动条');
    assert.match(aside, /max-height:/, '右栏高度要有上限（超出才滚动）');
    // 两栏互不拉平：高度只与自身内容有关（不能 align-items: stretch / 不能用 flex 拉满）
    const main = ruleOf('.detail-main');
    assert.ok(main, '缺少 .detail-main 规则');
    assert.match(main, /align-items:\s*start/, '两栏各自按内容高度，互不拉平');
    assert.ok(!/align-items:\s*stretch/.test(main), '两栏不能再等高拉伸');
    assert.ok(!/min-height:\s*min\(/.test(main), '两栏容器不再强制撑高');
    // 描述块列表本身不再单独出滚动条（滚动由右栏外框负责）
    const msgList = ruleOf('.detail-aside > .detail-msg-list');
    assert.ok(msgList, '缺少 .detail-aside > .detail-msg-list 规则');
    assert.match(msgList, /flex:\s*0 0 auto/, '描述块按内容撑高');
    assert.ok(!/overflow(-y)?:\s*(auto|scroll)/.test(msgList), '「描述与标签」列表不再单独滚');
    // 对话框正文在媒体详情里不滚（避免三根滚动条），其余视图（标签详情网格）仍然整体滚
    const body = ruleOf('.dialog-body');
    assert.match(body, /overflow-y:\s*auto/, '默认（标签详情等）正文整体滚');
    const detailBody = ruleOf('.dialog-body.has-detail-main');
    assert.ok(detailBody, '缺少 .dialog-body.has-detail-main 规则');
    assert.match(detailBody, /overflow:\s*hidden/, '媒体详情里正文不滚（滚动交给左右两栏）');
    // 窄屏单栏恢复整体滚动（两栏不再各自出滚动条）
    const narrow = (css.match(/@media \(max-width:\s*980px\)\s*\{[\s\S]*?\n\}/) || [''])[0];
    assert.ok(narrow, '缺少窄屏单栏媒体查询');
    assert.match(narrow, /\.detail-left,\s*\.detail-aside\s*\{[^}]*overflow-y:\s*visible/, '窄屏两栏不再各自滚动');
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
