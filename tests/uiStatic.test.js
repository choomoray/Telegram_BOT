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
