// 真实浏览器里的集成自检：用本地 Chrome 打开一个模拟聊天区，加载 client bundle，
// 验证打开/搜索/高亮/跳转/关闭整条链路。需要 puppeteer-core 和本机 Chrome。
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/IanXie/.dsh/profiles/desktop/node_modules/');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:/Users/IanXie/.cache/puppeteer/chrome/win64-127.0.6533.88/chrome-win64/chrome.exe';
const bundle = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const rows = [];
rows.push('<div class="row" data-chat-node-key="n1">用户消息：hello world</div>');
rows.push('<div class="row" data-chat-node-key="ntop">TARGET 顶部</div>');
rows.push('<div class="row" data-chat-node-key="n2">助手回复：<b>hello</b> <i>again</i>，中文关键词在这里</div>');
for (let i = 3; i <= 60; i += 1) rows.push('<div class="row" data-chat-node-key="n' + i + '">填充行 ' + i + ' filler text</div>');
rows.push('<div class="row" data-chat-node-key="nbot">TARGET 底部</div>');
rows.push('<div class="row" hidden>隐藏内容 secret</div>');
rows.push('<div class="row" style="display:none">CSS 隐藏 secret2</div>');

const html = '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">'
  + '<div data-conversation-content style="position:relative;width:900px;height:500px;display:flex;flex-direction:column">'
  + '<div data-conversation-scroll style="height:420px;overflow-y:auto;border:1px solid #ddd">'
  + '<div data-chat-flow><div data-slot="conversation.chat.flow" style="display:contents">' + rows.join('') + '</div></div>'
  + '</div>'
  + '<div data-composer-seat style="height:80px">composer 里的 secret 不该被搜到</div>'
  + '</div>'
  + '</body></html>';

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT FAILED: ' + message);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.setContent(html);
await page.evaluate(() => {
  window.__ModuleLoader__ = { load(definition) { window.__definition = definition; } };
});
await page.addScriptTag({ content: bundle });

const result = await page.evaluate(async () => {
  const out = {};
  const plugin = window.__definition.factory(() => { throw new Error('no modules required'); });
  plugin.apply({ effect(callback) { return callback(); } });
  const pressFind = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const bar = () => document.querySelector('[data-dsh-find-bar]');
  const input = () => document.querySelector('.dsh-find-input');
  const count = () => document.querySelector('.dsh-find-count').textContent;
  const highlightSize = () => {
    const registry = window.CSS && window.CSS.highlights;
    if (!registry) return -1;
    const highlight = registry.get('dsh-find-all');
    return highlight ? highlight.size : 0;
  };

  // 1) 用 Ctrl+F 打开
  pressFind();
  out.opened = bar() !== null && bar().getAttribute('data-open') === '1';
  out.focused = document.activeElement === input();

  // 2) 搜索英文（跨 <b> 节点）
  input().value = 'hello';
  input().dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(220);
  out.helloCount = count();
  out.helloHighlights = highlightSize();

  // 3) 大小写不敏感 + 中文
  input().value = '中文关键词';
  input().dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(220);
  out.chineseCount = count();

  // 4) 排除 composer 与隐藏内容
  input().value = 'secret';
  input().dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(220);
  out.secretCount = count();

  // 5) 多命中跳转：填充行 60 行，搜 "填充行" 应 58 个
  input().value = '填充行';
  input().dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(220);
  out.fillerCount = count();

  // 5b) 两个相距很远的命中，验证滚动定位
  input().value = 'TARGET';
  input().dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(220);
  out.targetCount = count();
  out.scrollerTopAfterFirst = document.querySelector('[data-conversation-scroll]').scrollTop;

  // 6) Enter 下一个
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(80);
  out.afterEnterCount = count();
  out.scrollerTopAfterEnter = document.querySelector('[data-conversation-scroll]').scrollTop;

  // 7) Shift+Enter 上一个
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  await sleep(80);
  out.afterShiftEnterCount = count();

  // 8) 无命中
  input().value = '绝对不存在的东西';
  input().dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(220);
  out.noMatchCount = count();
  out.noMatchHighlights = highlightSize();

  // 9) Esc 关闭并清高亮
  input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(50);
  out.closed = bar().getAttribute('data-open') === '0';
  out.highlightsAfterClose = highlightSize();

  // 10) 再次打开保留关键词
  pressFind();
  out.reopened = bar().getAttribute('data-open') === '1';
  out.keptQuery = input().value === '绝对不存在的东西';
  return out;
});

await browser.close();

const checks = [
  [result.opened, 'Ctrl+F 打开查找框'],
  [result.focused, '输入框获得焦点'],
  [result.helloCount === '1/2', '跨节点 hello 命中应为 1/2，实际 ' + result.helloCount],
  [result.helloHighlights === 2, 'hello 高亮数量应为 2，实际 ' + result.helloHighlights],
  [result.chineseCount === '1/1', '中文命中应为 1/1，实际 ' + result.chineseCount],
  [result.secretCount === '0/0', 'composer/隐藏内容不算命中，实际 ' + result.secretCount],
  [result.fillerCount === '1/58', '填充行命中应为 1/58，实际 ' + result.fillerCount],
  [result.targetCount === '1/2', 'TARGET 命中应为 1/2，实际 ' + result.targetCount],
  [result.scrollerTopAfterFirst < 50, '第一个命中在顶部时不滚动，实际 ' + result.scrollerTopAfterFirst],
  [result.afterEnterCount === '2/2', 'Enter 后应为 2/2，实际 ' + result.afterEnterCount],
  [result.scrollerTopAfterEnter > result.scrollerTopAfterFirst + 100, 'Enter 后应滚动到底部命中，实际 ' + result.scrollerTopAfterEnter],
  [result.afterShiftEnterCount === '1/2', 'Shift+Enter 后应为 1/2，实际 ' + result.afterShiftEnterCount],
  [result.noMatchCount === '0/0', '无命中应为 0/0，实际 ' + result.noMatchCount],
  [result.noMatchHighlights === 0, '无命中无高亮'],
  [result.closed, 'Esc 关闭'],
  [result.highlightsAfterClose === 0, '关闭后清高亮'],
  [result.reopened, '再次打开'],
  [result.keptQuery, '保留上次关键词'],
  [errors.length === 0, '页面无 JS 错误：' + errors.join('; ')],
];

let failed = 0;
for (const [ok, label] of checks) {
  console.log((ok ? 'ok   ' : 'FAIL ') + label);
  if (!ok) failed += 1;
}
console.log(failed === 0 ? 'E2E PASS (' + checks.length + ' checks)' : 'E2E FAIL ' + failed + '/' + checks.length);
process.exit(failed === 0 ? 0 : 1);