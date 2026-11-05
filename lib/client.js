// dsh-chat-find 的 DSH 界面部分（手写 bundle，无构建步骤）。
// 思路：只读聊天区已经渲染的 DOM 文本，自己拼成一个大字符串做搜索；
// 高亮用 CSS Custom Highlight API（不改 DOM、不触发 React 重渲染），
// 所以几千个命中也不会让聊天区卡住。
window.__ModuleLoader__.load({
  id: 'dsh-chat-find',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var BAR_ATTR = 'data-dsh-find-bar';
    var HL_ALL = 'dsh-find-all';
    var HL_CURRENT = 'dsh-find-current';
    var MAX_MATCHES = 2000;
    var SEARCH_DEBOUNCE_MS = 90;
    var DOM_THROTTLE_MS = 300;
    // 块级边界插入的零宽分隔符：防止跨段落/跨消息拼出假命中
    var SEP = '\u200b';
    var BLOCK_TAGS = {
      DIV: 1, P: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, PRE: 1, BR: 1,
      BLOCKQUOTE: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1, SECTION: 1,
      ARTICLE: 1, UL: 1, OL: 1, DETAILS: 1, SUMMARY: 1, FIGURE: 1, FIGCAPTION: 1,
      HEADER: 1, FOOTER: 1, ASIDE: 1, NAV: 1, MAIN: 1, FORM: 1, FIELDSET: 1, HR: 1,
    };

    var CSS = [
      '.dsh-find{position:fixed;z-index:70;display:none;align-items:center;gap:4px;padding:5px 6px 5px 10px;',
      'border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);',
      'border:0.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));box-shadow:0 8px 28px rgba(0,0,0,.18);',
      'font-family:inherit;font-size:13px;line-height:1.3;user-select:none}',
      '.dsh-find[data-open="1"]{display:flex}',
      '.dsh-find-input{all:unset;box-sizing:border-box;width:180px;padding:3px 2px;color:inherit;font:inherit;caret-color:currentColor}',
      '.dsh-find-input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa0a6)}',
      '.dsh-find-count{min-width:44px;text-align:right;color:var(--dsw-alias-label-tertiary,#6b7280);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsh-find-count[data-state="none"]{color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.dsh-find-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);',
      'width:24px;height:24px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;',
      'font-size:14px;line-height:1;padding:0}',
      '.dsh-find-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}',
      '.dsh-find-btn[data-act="close"]{font-size:15px}',
      '::highlight(' + HL_ALL + '){background-color:rgba(250,204,21,.38)}',
      '::highlight(' + HL_CURRENT + '){background-color:#f59e0b;color:#1f2937}',
    ].join('');

    var state = {
      open: false,
      query: '',
      ranges: [],
      current: -1,
      // collectText 的结果缓存：DOM 没变时连续输入不必重扫
      collected: null,
    };
    var bar = null;
    var inputEl = null;
    var countEl = null;
    var searchTimer = 0;
    var domTimer = 0;
    var styleEl = null;
    var mutationObserver = null;
    var resizeObserver = null;
    var watchedRoot = null;
    var disposed = false;

    // 在拼好的文本上找所有命中起点。
    function scanText(text, query) {
      var starts = [];
      if (query.length === 0 || text.length === 0) return starts;
      var hay = text.toLowerCase();
      var needle = query.toLowerCase();
      // 个别字符转小写会改变长度，这时候退回原样比较，保证 offset 不变
      if (hay.length !== text.length || needle.length !== query.length) {
        hay = text;
        needle = query;
      }
      var index = 0;
      while (starts.length < MAX_MATCHES) {
        index = hay.indexOf(needle, index);
        if (index === -1) break;
        starts.push(index);
        index += needle.length;
      }
      return starts;
    }

    // 全局 offset 落到哪个文本节点（二分，取最后一个 start <= offset 的 span）
    function locate(spans, offset) {
      var low = 0;
      var high = spans.length - 1;
      var best = 0;
      while (low <= high) {
        var mid = (low + high) >> 1;
        if (spans[mid].start <= offset) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return best;
    }

    function buildRanges(spans, starts, length) {
      var ranges = [];
      for (var i = 0; i < starts.length; i++) {
        var from = starts[i];
        var to = from + length;
        var head = spans[locate(spans, from)];
        var tail = spans[locate(spans, to)];
        var startOffset = from - head.start;
        var endOffset = to - tail.start;
        // 起点落在块分隔符区间（query 自己带零宽字符）时这一条不是真实文本命中，跳过
        if (startOffset < 0 || endOffset < 0) continue;
        var range = document.createRange();
        range.setStart(head.node, startOffset);
        range.setEnd(tail.node, Math.min(tail.node.data.length, endOffset));
        ranges.push(range);
      }
      return ranges;
    }

    function isCssHidden(el) {
      if (typeof el.checkVisibility !== 'function') return false;
      // 可见元素直接返回，省掉一次 getComputedStyle
      if (el.checkVisibility()) return false;
      // display:contents 的元素自身没有盒子，checkVisibility 会误判成不可见。
      // DSH 的插槽锚点 div[data-slot] 就是 display:contents，聊天正文全挂在这种节点下面，
      // 所以这里必须放行、继续下钻，由子元素各自判断。
      return window.getComputedStyle(el).display !== 'contents';
    }

    function shouldSkipElement(el) {
      var tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return true;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || tag === 'OPTION') return true;
      if (el.hasAttribute('hidden')) return true;
      if (el.getAttribute('aria-hidden') === 'true') return true;
      if (el.hasAttribute(BAR_ATTR)) return true;
      // 输入框区域和聊天正文在同一个容器里，但它不是会话内容
      if (el.hasAttribute('data-composer-seat')) return true;
      return isCssHidden(el);
    }

    function collectText(root) {
      var parts = [];
      var spans = [];
      var total = 0;
      var stack = [{ node: root, exit: false }];
      while (stack.length > 0) {
        var item = stack.pop();
        var node = item.node;
        if (item.exit === true) {
          if (BLOCK_TAGS[node.tagName] === 1) {
            parts.push(SEP);
            total += 1;
          }
          continue;
        }
        if (node.nodeType === 3) {
          if (node.data.length === 0) continue;
          spans.push({ node: node, start: total });
          parts.push(node.data);
          total += node.data.length;
          continue;
        }
        if (node.nodeType !== 1) continue;
        if (shouldSkipElement(node)) continue;
        if (BLOCK_TAGS[node.tagName] === 1) {
          parts.push(SEP);
          total += 1;
          stack.push({ node: node, exit: true });
        }
        var child = node.lastChild;
        while (child !== null) {
          stack.push({ node: child, exit: false });
          child = child.previousSibling;
        }
      }
      return { text: parts.join(''), spans: spans };
    }

    // 页面里可能同时存在多个 Conversation（主区 + 侧栏预览），取第一个有尺寸的
    function chatRoot() {
      var nodes = document.querySelectorAll('[data-conversation-content]');
      for (var i = 0; i < nodes.length; i++) {
        var rect = nodes[i].getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return nodes[i];
      }
      return nodes.length > 0 ? nodes[0] : null;
    }

    // 只接受这个 root 自己的滚动容器，避免多 Conversation 时滚错会话
    function scrollerEl(root) {
      return root === null ? null : root.querySelector('[data-conversation-scroll]');
    }

    function injectCss() {
      if (styleEl !== null) return;
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-dsh-find-style', '');
      styleEl.textContent = CSS;
      (document.head || document.documentElement).appendChild(styleEl);
    }

    function canHighlight() {
      return window.CSS?.highlights != null && typeof window.Highlight === 'function';
    }

    function paintHighlights() {
      if (!canHighlight() || disposed) return;
      window.CSS.highlights.set(HL_ALL, new window.Highlight(...state.ranges));
      if (state.current >= 0 && state.current < state.ranges.length) {
        window.CSS.highlights.set(HL_CURRENT, new window.Highlight(state.ranges[state.current]));
      } else {
        window.CSS.highlights.delete(HL_CURRENT);
      }
    }

    function clearHighlights() {
      if (!canHighlight()) return;
      window.CSS.highlights.delete(HL_ALL);
      window.CSS.highlights.delete(HL_CURRENT);
    }

    function scrollTo(index) {
      var range = state.ranges[index];
      if (range === undefined) return;
      var scroller = scrollerEl(chatRoot());
      var rect = range.getBoundingClientRect();
      // 命中的文字当前没有布局（例如刚切会话还没渲染），先等它渲染
      if (rect.width === 0 && rect.height === 0) return;
      if (scroller === null) return;
      var view = scroller.getBoundingClientRect();
      var offset = rect.top - view.top;
      var target = scroller.scrollTop + offset - Math.max(0, (scroller.clientHeight - rect.height) / 2);
      scroller.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
    }

    function createBar() {
      bar = document.createElement('div');
      bar.className = 'dsh-find';
      bar.setAttribute(BAR_ATTR, '');
      bar.setAttribute('data-open', '0');

      inputEl = document.createElement('input');
      inputEl.className = 'dsh-find-input';
      inputEl.type = 'text';
      inputEl.placeholder = '\u5728\u4f1a\u8bdd\u4e2d\u67e5\u627e';
      inputEl.setAttribute('spellcheck', 'false');
      inputEl.setAttribute('autocomplete', 'off');
      inputEl.setAttribute('aria-label', '\u5728\u4f1a\u8bdd\u4e2d\u67e5\u627e');

      countEl = document.createElement('span');
      countEl.className = 'dsh-find-count';

      bar.appendChild(inputEl);
      bar.appendChild(countEl);
      bar.appendChild(makeButton('prev', '\u2191', '\u4e0a\u4e00\u4e2a\u5339\u914d (Shift+Enter)'));
      bar.appendChild(makeButton('next', '\u2193', '\u4e0b\u4e00\u4e2a\u5339\u914d (Enter)'));
      bar.appendChild(makeButton('close', '\u00d7', '\u5173\u95ed (Esc)'));

      inputEl.addEventListener('input', function (event) {
        if (event.isComposing) return;
        scheduleSearch();
      });
      inputEl.addEventListener('compositionend', scheduleSearch);
      inputEl.addEventListener('keydown', onInputKeyDown);
      bar.addEventListener('mousedown', function (event) {
        // 点按钮时不要抢走输入框焦点
        if (event.target !== inputEl) event.preventDefault();
      });

      document.body.appendChild(bar);
    }

    function makeButton(act, text, title) {
      var button = document.createElement('button');
      button.className = 'dsh-find-btn';
      button.type = 'button';
      button.setAttribute('data-act', act);
      button.textContent = text;
      button.title = title;
      button.addEventListener('click', function () {
        if (act === 'prev') step(-1);
        else if (act === 'next') step(1);
        else closeFind();
      });
      return button;
    }

    function onInputKeyDown(event) {
      // 输入法组词中的 Enter 是选词，不是"下一个匹配"
      if (event.isComposing === true || event.keyCode === 229) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        step(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeFind();
      }
    }

    // 浮在聊天区右上角，跟随聊天区宽度
    function position() {
      if (bar === null || !state.open) return;
      var root = chatRoot();
      if (root === null) return;
      var rect = root.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      var width = bar.offsetWidth;
      bar.style.top = Math.round(rect.top + 10) + 'px';
      bar.style.left = Math.round(rect.right - width - 16) + 'px';
    }

    function setCount() {
      if (countEl === null) return;
      if (state.query.length === 0) {
        countEl.textContent = '';
        countEl.removeAttribute('data-state');
        return;
      }
      if (state.ranges.length === 0) {
        countEl.textContent = '0/0';
        countEl.setAttribute('data-state', 'none');
        return;
      }
      countEl.textContent = (state.current + 1) + '/' + state.ranges.length;
      countEl.removeAttribute('data-state');
    }

    function runSearch(scroll) {
      var root = chatRoot();
      if (root === null) {
        state.ranges = [];
        state.current = -1;
        clearHighlights();
        setCount();
        return;
      }
      watchRoot(root);
      if (state.collected === null) state.collected = collectText(root);
      state.ranges = buildRanges(
        state.collected.spans,
        scanText(state.collected.text, state.query),
        state.query.length
      );

      var previous = state.current;
      if (state.ranges.length === 0) state.current = -1;
      else if (scroll === false && previous >= 0) state.current = Math.min(previous, state.ranges.length - 1);
      else state.current = 0;
      paintHighlights();
      setCount();
      if (scroll !== false && state.current >= 0) scrollTo(state.current);
    }

    function scheduleSearch() {
      if (searchTimer !== 0) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(function () {
        searchTimer = 0;
        state.query = inputEl === null ? '' : inputEl.value;
        runSearch(true);
      }, SEARCH_DEBOUNCE_MS);
    }

    function step(delta) {
      if (state.ranges.length === 0) return;
      var next = state.current + delta;
      if (next < 0) next = state.ranges.length - 1;
      if (next >= state.ranges.length) next = 0;
      state.current = next;
      paintHighlights();
      setCount();
      scrollTo(state.current);
    }

    // 切会话、折叠展开、加载历史、流式输出都会改 DOM：让文本缓存失效并重新搜索。
    // 用节流而不是防抖：流式输出每个 token 都触发 mutation，防抖会一直被重置、永不刷新。
    function onDomChanged() {
      state.collected = null;
      if (!state.open || state.query.length === 0) return;
      if (domTimer !== 0) return;
      domTimer = window.setTimeout(function () {
        domTimer = 0;
        if (disposed || !state.open) return;
        runSearch(false);
      }, DOM_THROTTLE_MS);
    }

    function watchRoot(root) {
      if (root === watchedRoot) return;
      if (mutationObserver !== null) mutationObserver.disconnect();
      if (resizeObserver !== null) resizeObserver.disconnect();
      mutationObserver = null;
      resizeObserver = null;
      watchedRoot = root;
      // 换了根节点（切会话/重挂）必须重扫，旧缓存属于上一棵树
      state.collected = null;
      if (root === null) return;
      if (typeof window.MutationObserver === 'function') {
        mutationObserver = new window.MutationObserver(onDomChanged);
        mutationObserver.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
          // 聊天折叠/展开靠切 hidden 属性，不看 attributes 的话缓存永远不失效
          attributes: true,
          attributeFilter: ['hidden', 'aria-hidden', 'class', 'style'],
        });
      }
      if (typeof window.ResizeObserver === 'function') {
        resizeObserver = new window.ResizeObserver(position);
        resizeObserver.observe(root);
      }
    }

    function openFind() {
      // 没有打开的会话就没有可搜的东西
      if (disposed || chatRoot() === null) return;
      if (bar === null) createBar();
      state.open = true;
      // 以输入框当前内容为准：输入后 90ms 内关掉再打开可能还没同步到 state.query
      state.query = inputEl.value;
      bar.setAttribute('data-open', '1');
      position();
      inputEl.focus();
      inputEl.select();
      if (state.query.length > 0) runSearch(true);
    }

    function closeFind() {
      if (!state.open) return;
      state.open = false;
      if (searchTimer !== 0) {
        window.clearTimeout(searchTimer);
        searchTimer = 0;
      }
      bar.setAttribute('data-open', '0');
      clearHighlights();
      inputEl.blur();
    }

    // Web 端快捷键服务只允许 Mod+Slash/Comma/Period，绑不了 Mod+F；
    // Ctrl/Cmd+F 只能在窗口捕获阶段自己接，顺便把浏览器原生查找挡掉。
    function onHotkey(event) {
      if (event.defaultPrevented || (event.key || '').toLowerCase() !== 'f' || event.altKey) return;
      if (!event.metaKey && !event.ctrlKey) return;
      // 没有会话可搜时放行浏览器原生查找
      if (!state.open && chatRoot() === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (state.open) closeFind();
      else openFind();
    }

    function dispose() {
      disposed = true;
      if (searchTimer !== 0) window.clearTimeout(searchTimer);
      if (domTimer !== 0) window.clearTimeout(domTimer);
      searchTimer = 0;
      domTimer = 0;
      if (mutationObserver !== null) mutationObserver.disconnect();
      if (resizeObserver !== null) resizeObserver.disconnect();
      mutationObserver = null;
      resizeObserver = null;
      watchedRoot = null;
      clearHighlights();
      if (bar !== null && bar.parentNode !== null) bar.parentNode.removeChild(bar);
      if (styleEl !== null && styleEl.parentNode !== null) styleEl.parentNode.removeChild(styleEl);
      bar = null;
      inputEl = null;
      countEl = null;
      styleEl = null;
      state.open = false;
      state.ranges = [];
      state.current = -1;
      state.collected = null;
    }

    function apply(ctx) {
      ctx.effect(function () {
        injectCss();
        window.addEventListener('resize', position);
        window.addEventListener('keydown', onHotkey, true);
        return function () {
          window.removeEventListener('resize', position);
          window.removeEventListener('keydown', onHotkey, true);
          dispose();
        };
      }, 'dsh-chat-find: find bar');
    }

    exports.name = 'dsh-chat-find';
    exports.apply = apply;
    // 单测入口：只暴露纯逻辑，不碰真实 DOM
    exports.__test = {
      scanText: scanText,
      locate: locate,
      buildRanges: buildRanges,
      collectText: collectText,
      shouldSkipElement: shouldSkipElement,
      MAX_MATCHES: MAX_MATCHES,
      SEP: SEP,
    };
    return module.exports;
  },
});