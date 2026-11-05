import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 客户端 bundle 是 window.__ModuleLoader__ 格式，这里在 vm 里加载并直接拿 __test 的纯逻辑。
const code = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let captured = null;
const sandbox = {
  window: {
    __ModuleLoader__: { load(definition) { captured = definition; } },
    // collectText 用 getComputedStyle 区分 display:contents（自身无盒子但内容可见）
    getComputedStyle: (node) => ({ display: (node.attrs && node.attrs.display) || 'block' }),
  },
  document: {
    createRange() {
      const range = {
        startNode: null, startOffset: 0, endNode: null, endOffset: 0,
        setStart(node, offset) { range.startNode = node; range.startOffset = offset; },
        setEnd(node, offset) { range.endNode = node; range.endOffset = offset; },
      };
      return range;
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
assert.ok(captured, 'bundle must register through __ModuleLoader__');
const plugin = captured.factory(() => { throw new Error('no modules required'); });
const core = plugin.__test;

// vm 沙箱里的数组/对象来自另一个 realm，断言前先转成本 realm 的普通值
function plain(value) { return JSON.parse(JSON.stringify(value)); }

function text(data) { return { nodeType: 3, data }; }

function el(tag, attrs = {}, children = []) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children,
    firstChild: children[0] ?? null,
    lastChild: children[children.length - 1] ?? null,
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    attrs,
    checkVisibility() { return attrs.__visible !== false; },
  };
  for (let i = children.length - 1; i >= 0; i -= 1) {
    children[i].previousSibling = i > 0 ? children[i - 1] : null;
  }
  return node;
}

test('scanText: 大小写不敏感，不重叠', () => {
  assert.deepEqual(plain(core.scanText('Hello hello HELLO', 'hello')), [0, 6, 12]);
  assert.deepEqual(plain(core.scanText('aaaa', 'aa')), [0, 2]);
  assert.deepEqual(plain(core.scanText('abc', 'zzz')), []);
  assert.deepEqual(plain(core.scanText('abc', '')), []);
  assert.deepEqual(plain(core.scanText('', 'a')), []);
});

test('scanText: 命中上限', () => {
  assert.equal(core.scanText('x'.repeat(5000), 'x').length, core.MAX_MATCHES);
});

test('scanText: 中文', () => {
  assert.deepEqual(plain(core.scanText('会话里搜索关键词，关键词在这里', '关键词')), [5, 9]);
});

test('locate: offset 落在节点边界', () => {
  const spans = [
    { node: { data: 'abc' }, start: 0 },
    { node: { data: 'def' }, start: 3 },
  ];
  assert.equal(core.locate(spans, 0), 0);
  assert.equal(core.locate(spans, 2), 0);
  assert.equal(core.locate(spans, 3), 1);
  assert.equal(core.locate(spans, 99), 1);
});

test('collectText: 拼接文本、块之间加零宽分隔符、跳过隐藏与输入区', () => {
  const sep = core.SEP;
  const hiddenBox = el('div', { hidden: '' }, [text('隐藏')]);
  const composer = el('div', { 'data-composer-seat': '' }, [text('输入框内容')]);
  const invisible = el('span', { __visible: false }, [text('不可见')]);
  const bold = el('b', {}, [text('重点')]);
  const paragraph = el('p', {}, [text('第一段'), bold]);
  const root = el('div', {}, [paragraph, hiddenBox, composer, invisible, text('尾巴')]);
  const collected = core.collectText(root);
  assert.equal(collected.text, sep + sep + '第一段重点' + sep + '尾巴' + sep);
  assert.equal(collected.spans.length, 3);
  assert.deepEqual(plain(collected.spans.map((span) => span.start)), [2, 5, 8]);
});

test('collectText: display:contents 包装必须下钻（DSH 插槽锚点就是这种）', () => {
  const contents = el('div', { display: 'contents' }, [text('内容还在')]);
  // display:contents 的元素自身没有盒子，checkVisibility 会返回 false
  contents.checkVisibility = () => false;
  const root = el('div', {}, [contents]);
  const collected = core.collectText(root);
  assert.ok(collected.text.includes('内容还在'), 'display:contents 下的文字必须被搜到');
});

test('collectText: display:none 仍然跳过', () => {
  const none = el('div', { display: 'none' }, [text('看不见')]);
  none.checkVisibility = () => false;
  const root = el('div', {}, [none]);
  const collected = core.collectText(root);
  assert.ok(!collected.text.includes('看不见'));
});

test('shouldSkipElement: 逐类节点判定', () => {
  assert.equal(core.shouldSkipElement(el('script', {}, [])), true);
  assert.equal(core.shouldSkipElement(el('div', { hidden: '' }, [])), true);
  assert.equal(core.shouldSkipElement(el('div', { 'data-composer-seat': '' }, [])), true);
  assert.equal(core.shouldSkipElement(el('div', { display: 'contents' }, [])), false);
  assert.equal(core.shouldSkipElement(el('div', {}, [])), false);
});

test('buildRanges: 跨文本节点构造 Range', () => {
  const first = text('hello ');
  const second = text('world');
  const spans = [{ node: first, start: 0 }, { node: second, start: 6 }];
  const ranges = core.buildRanges(spans, [0], 11);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].startNode, first);
  assert.equal(ranges[0].startOffset, 0);
  assert.equal(ranges[0].endNode, second);
  assert.equal(ranges[0].endOffset, 5);
});

test('buildRanges: 单节点内匹配', () => {
  const node = text('abcdef');
  const spans = [{ node, start: 0 }];
  const ranges = core.buildRanges(spans, [2], 3);
  assert.equal(ranges[0].startOffset, 2);
  assert.equal(ranges[0].endOffset, 5);
});