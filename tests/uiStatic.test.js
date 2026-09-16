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
  // 属性可能被格式化换行（<span\n class="nav-ico">），用 \s+ 容错
  assert.match(html, /<span\s+class="nav-ico">🎲<\/span><span>随机推荐<\/span>/);
});

test('index.html：导航里「数据库 / 原始数据」已改名为「数据库」', () => {
  assert.match(html, /data-view="raw"/, '数据库视图入口还在');
  assert.match(html, /<span\s+class="nav-ico">🗄<\/span><span>数据库<\/span>/, '导航文案为「数据库」');
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

  // 瀑布流容器：CSS Grid + 8px 行标尺（卡片按内容高度跨行 → 错落），不再是"先填满第一列"的 columns
  const flowGrid = (css.match(/\.media-grid--flow\s*\{[^}]*\}/) || [''])[0];
  assert.ok(flowGrid, '缺少 .media-grid--flow 规则');
  assert.match(flowGrid, /display:\s*grid/, '瀑布流用 grid（自动放置=先第一行从左到右）');
  assert.match(flowGrid, /grid-auto-rows:\s*\d+px/, '要有行标尺（JS 按卡片高度换算成跨多少行）');
  assert.ok(!/columns:\s*\d/.test(flowGrid), '不再用 CSS 多列（columns 是"先填满第一列"，顺序会跳列）');

  // 列数阶梯：按窗口宽度自动选列数，手机 2 列、桌面 5~6 列，且从窄到宽排列
  const steps = [...css.matchAll(/@media \(min-width:\s*(\d+)px\)\s*\{\s*\.media-grid--flow\s*\{\s*--flow-cols:\s*(\d+)/g)]
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

  // 卡片必须是 grid 子项且 align-self:start（高度=内容高度），否则 JS 量不到真实高度、跨度算错
  const card = (css.match(/\.media-card--flow\s*\{[^}]*\}/) || [''])[0];
  assert.match(card, /align-self:\s*start/, '卡片高度由内容决定（不被 8px 轨道拉伸）');
  assert.match(card, /grid-row-end:\s*span var\(--flow-span/, '卡片按 JS 写入的跨度跨行');

  // 文字仍在图片下方：body 是纵向块（沿用 .media-body）
  // 锚定行首：否则会先匹配到 `.media-card--compact .media-body` 这类组合选择器
  const body = (css.match(/^\.media-body\s*\{[^}]*\}/m) || [''])[0];
  assert.match(body, /flex-direction:\s*column/, '卡片文字区仍在图片下方（纵向）');
});

test('app.js：瀑布流按「先第一行从左到右」排布（grid 行跨度，图片加载完 / 缩放后重算）', () => {
  // 顺序观看的核心：卡片高度换算成 grid-row-end: span N，
  // grid 的自动放置永远先铺满第一行再往下 —— 与列表顺序一致（columns 会先填满第一列）
  assert.match(js, /function layoutFlowBox\(box\)/, '缺少瀑布流行跨度计算');
  assert.match(js, /gridRowEnd = `span \$\{span\}`/, '要把内容高度换算成 grid-row-end 跨度');
  assert.match(js, /Math\.ceil\(\(heights\[i\] \+ gap\) \/ \(FLOW_ROW_HEIGHT \+ gap\)\)/, '跨度公式：ceil((H+gap)/(rowH+gap))');
  assert.match(js, /const FLOW_SELECTOR = '\.media-grid--flow, \.media-grid--fit, \.media-grid--mini, \.detail-strip--flow'/,
    '四处瀑布流共用同一套排布');
  // 重排时机：视图渲染后 / 详情渲染后 / 缩略图加载完（高度变了）/ 窗口缩放
  assert.match(js, /layoutFlowGrid\(\$\('#view'\)\)/, '视图渲染后要重排');
  assert.match(js, /relayoutFlowOf\(wrap\)/, '缩略图按真实比例定高后要重排该容器');
  assert.match(js, /window\.addEventListener\('resize', \(\) => \{/, '窗口缩放要重排（列宽变了）');
});

test('style.css：媒体库 / 标签详情的卡片瀑布流按容器宽度自适应（两处卡片一样大）', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  // 视口阶梯那套（.media-grid--flow）只服务随机推荐：媒体库 / 标签详情在弹窗里容器更窄，
  // 若共用会变成列数一样、列宽更小 → 卡片明显变小。这里改用 auto-fill 按容器算列数。
  const fit = (css.match(/\.media-grid--fit\s*\{[^}]*\}/) || [''])[0];
  assert.ok(fit, '缺少 .media-grid--fit 规则');
  assert.match(fit, /display:\s*grid/, '列数由 auto-fill 自适应（不写死列数）');
  assert.match(fit, /repeat\(auto-fill,\s*minmax\(228px,\s*1fr\)\)/, '列宽与原来的 minmax(228px, 1fr) 同尺度');
  assert.match(fit, /grid-auto-rows:/, '同样是行标尺瀑布流');
  // 窄屏收窄列宽（弹窗正文更窄，所以比 640px 档更小），保证手机上也排得下 2 列
  const narrow = [...css.matchAll(/@media \(max-width:\s*(\d+)px\)\s*\{\s*\.media-grid--fit\s*\{\s*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\((\d+)px,\s*1fr\)\)/g)]
    .map(m => ({ width: Number(m[1]), colWidth: Number(m[2]) }));
  assert.ok(narrow.length >= 2, `窄屏至少要两档收窄，实际 ${narrow.length} 档`);
  for (let i = 1; i < narrow.length; i++) {
    assert.ok(narrow[i].width < narrow[i - 1].width, '窄屏断点必须从宽到窄排列');
    assert.ok(narrow[i].colWidth <= narrow[i - 1].colWidth, '越窄的屏幕列宽不能变大');
  }
  assert.ok(narrow[narrow.length - 1].colWidth <= 120, '最窄档 120px：手机上（含弹窗）要排得下 2 列');
  // 卡片 / 封面变体与随机推荐共用同一套（视觉一致）
  assert.match(css, /\.media-card--flow\s*\{[^}]*align-self:\s*start/, '卡片高度由内容决定（JS 量高度依赖）');
  assert.match(css, /\.media-thumb--flow\s*\{[^}]*min-height:/, '封面容器要有占位高度');
});

test('style.css：标签详情的媒体尺寸与「媒体详情」左栏完全一致（列宽 / 列间距 / 断点逐一相同）', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  // 两处的所有「列宽 + 列间距」声明（含窄屏那档）都必须一模一样，
  // 否则同一个窗口下标签详情里的媒体会比媒体详情左栏大 / 小
  const pairsOf = (sel) => [...css.matchAll(
    new RegExp(`\\.${sel}\\s*\\{[^}]*grid-template-columns:\\s*([^;]+);[^}]*column-gap:\\s*([^;]+);`, 'g')
  )].map(m => `${m[1].trim()}|${m[2].trim()}`);
  const mini = pairsOf('media-grid--mini');
  const strip = pairsOf('detail-strip--flow');
  assert.ok(mini.length >= 1, '缺少 .media-grid--mini 规则');
  assert.ok(strip.length >= 1, '缺少 .detail-strip--flow 规则');
  assert.deepStrictEqual(mini, strip, '标签详情与媒体详情左栏的列宽必须在每一档都相同');
  assert.ok(mini.length >= 2, '窄屏那档也要一起收窄（否则手机上两处又会不一样大）');
  assert.match(mini[0], /^repeat\(auto-fill, minmax\(132px, 1fr\)\)\|10px$/, '桌面档：132px 一列（与媒体详情左栏同尺度）');
  // 紧凑卡片（132px 放不下徽标 / 标签）必须精简内容，并隐藏过大的类型角标
  assert.match(css, /\.media-card--compact \.media-body\s*\{[^}]*padding:/, '紧凑卡片正文要收紧内边距');
  assert.match(css, /\.media-card--compact \.thumb-type\s*\{\s*display:\s*none/, '紧凑卡片里隐藏类型角标');
});

test('app.js：前端认识文本媒体类型（/send、/reply 的纯文本会收录成 media_type=text）', () => {
  assert.match(js, /text: \{ icon: '📝', label: '文本' \}/, 'TYPE_META 要有 text');
  assert.match(js, /const typeOrder = \['photo', 'video', 'audio', 'document', 'text'\]/, '概览类型分布也要含文本');
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
    // 断点 1040px：980px 时 768~1024px 的平板仍会被挤成「左栏被压窄 + 360px 空右栏」
    const narrow = (css.match(/@media \(max-width:\s*1040px\)\s*\{[\s\S]*?\n\}/) || [''])[0];
    assert.ok(narrow, '缺少窄屏单栏媒体查询（1040px）');
    assert.match(narrow, /\.detail-left,\s*\.detail-aside\s*\{[^}]*overflow-y:\s*visible/, '窄屏两栏不再各自滚动');
    // 必须显式声明单栏轨道：只改 display 的话 minmax(360px,34%) 仍是硬下限，
    // 360~440px 的手机上左栏会被压成 0 宽并被 .dialog 裁掉
    assert.match(narrow, /\.detail-main\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
        '窄屏必须显式声明单栏轨道（覆盖 minmax(360px,34%)）');
    assert.match(narrow, /\.detail-left,\s*\.detail-aside\s*\{[^}]*width:\s*100%/, '窄屏两栏占满整宽');
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

// ---------------- 平板 / 手机响应式（子界面排版） ----------------

/**
 * 取某个 max-width 媒体查询块的完整文本（到下一个顶层 @media 为止）。
 * 同宽度可能有多个块（窄屏骨架 + 后续增补的子界面修正），
 * 这里取**最后一个**（CSS 里靠后的规则才会生效，也是增补规则所在处）。
 */
function mediaBlock(css, maxWidth) {
  const start = css.lastIndexOf(`@media (max-width: ${maxWidth}px)`);
  if (start === -1) return '';
  const next = css.indexOf('@media', start + 10);
  return css.slice(start, next === -1 ? css.length : next);
}

test('style.css：对话框底部按钮允许换行（否则手机上「关闭」被裁掉、详情弹层关不掉）', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  const foot = (css.match(/^\.dialog-foot\s*\{[^}]*\}/m) || [''])[0];
  assert.ok(foot, '缺少 .dialog-foot 规则');
  assert.match(foot, /flex-wrap:\s*wrap/, '.dialog-foot 必须能换行（详情页底部按钮实测 ≈492px 宽）');
});

test('style.css：手机断点把底部按钮撑满并隐藏 spacer', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  const phone = mediaBlock(css, 640);
  assert.ok(phone, '缺少 640px 手机断点');
  assert.match(phone, /\.dialog-foot\s+\.spacer\s*\{[^}]*display:\s*none/, '手机端隐藏 spacer');
  assert.match(phone, /\.dialog-foot\s+\.btn\s*\{[^}]*flex:\s*1 1 auto/, '手机端按钮平分整行');
  assert.match(phone, /\.dialog\s*\{[^}]*width:\s*calc\(100vw - 16px\)/, '手机端对话框用满宽度');
});

test('style.css：窄屏不再挤出横向滚动条 / 触控目标与 iOS 缩放', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  const narrow = mediaBlock(css, 880);
  assert.ok(narrow, '缺少 880px 窄屏断点');
  // 表格 / 方格图改为可横扫，而不是把最右列裁掉
  assert.match(narrow, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/, '窄屏表格可横向滚动');
  assert.match(narrow, /\.cg-grid,\s*\.cg-months\s*\{[^}]*minmax\(13px/, '窄屏方格放大到 13px（触屏可点）');
  // 触控目标
  assert.match(narrow, /\.btn-sm\s*\{[^}]*min-height/, '窄屏按钮加大触控高度');
  assert.match(narrow, /\.chip\s*\{[^}]*padding/, '窄屏 chip 加大内边距');
  // iOS 聚焦缩放
  assert.match(narrow, /input,\s*select,\s*textarea\s*\{[^}]*font-size:\s*16px/, '窄屏表单控件 16px（避免 iOS 聚焦缩放）');
  // 安全区 / dvh
  assert.match(narrow, /\.toast\s*\{[^}]*safe-area-inset-bottom/, 'toast 避开底部安全区');
  assert.match(narrow, /\.login-view\s*\{[^}]*100dvh/, '登录页用 dvh 兜底移动端地址栏');
});

test('style.css：实时日志框高度在窄屏有上限（原内联 100vh-250px 会撑出屏幕）', () => {
  const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
  const base = (css.match(/^#log-view-list\s*\{[^}]*\}/m) || [''])[0];
  assert.ok(base, '日志框高度应移到 CSS（宽屏）');
  assert.match(base, /height:\s*calc\(100vh - 250px\)/, '宽屏保持原来的视口高度算法');
  const narrow = mediaBlock(css, 880);
  const override = (narrow.match(/#log-view-list\s*\{[^}]*\}/) || [''])[0];
  assert.ok(override, '窄屏需要单独覆盖日志框高度');
  assert.match(override, /height:\s*min\(/, '窄屏日志框高度改用 min() 上限');
  // 内联样式会覆盖 CSS，必须已从 app.js 移除
  const js = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  assert.ok(!/id="log-view-list"[^>]*height:/.test(js), 'app.js 里不应再有内联 height（会盖掉 CSS）');
});

test('app.js：多列表格（用户 / 搬运收录）带 table-scroll，窄屏操作列不被裁掉', () => {
  const js = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  // users 表格：6 列，最后一列是 ✏️/🗑
  assert.match(js, /<div class="table-wrap table-scroll">\s*<table>\s*<thead><tr><th>用户<\/th>/,
    'users 表格需要 table-scroll 包裹');
  // transport 表格：7 列，最后一列是 🔄/✏️/🗑
  assert.match(js, /<div class="table-wrap table-scroll">\s*<table>\s*<thead><tr><th>活性<\/th>/,
    'transport 表格需要 table-scroll 包裹');
  // 不应再有裸露的 .table-wrap（overflow:hidden）包多列表格
  const bareWraps = [...js.matchAll(/<div class="table-wrap">/g)].length;
  assert.equal(bareWraps, 0, '所有 .table-wrap 都应带 table-scroll（否则窄屏裁列且无滚动条）');
});
