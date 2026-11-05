# dsh-chat-find：在会话里查找关键词

给 DSH 聊天区加一个类似浏览器页内查找的功能：输入关键词，所有命中高亮，按回车跳下一个，视图自动滚到命中位置。

## 使用方法

| 操作 | 效果 |
|---|---|
| `Ctrl+F`（macOS 是 `Cmd+F`） | 打开查找框，再按一次关闭 |
| 输入关键词 | 防抖后自动搜索，第一个命中自动滚到屏幕中间 |
| `Enter` / `↓` | 下一个命中 |
| `Shift+Enter` / `↑` | 上一个命中 |
| `Esc` | 关闭并清除高亮 |

查找框浮在聊天区右上角，计数显示「当前/总数」。搜不到时计数变红。输入法组词期间不触发搜索，按 Enter 选词也不会误跳。

## 搜索范围

- 当前会话聊天区里**已经渲染**的内容：用户消息、助手回复、工具调用的文本、代码块。
- 跳过输入框和 composer 区域，那不属于会话内容。
- 跳过被折叠（`hidden`、`display:none`）的内容：这类文字滚不过去，算进计数会干扰判断。
- 聊天只加载最近的窗口，更早的历史需要先向上滚动加载出来，才进入搜索范围。

## 性能设计

- 高亮用浏览器原生的 CSS Custom Highlight API（`::highlight()`），只登记命中文字的 Range，**不改 DOM**，所以不触发 React 重渲染，滚动时不掉帧。
- 搜索把聊天区的文本节点拼成一个大字符串，在字符串上做 `indexOf`，再二分映射回文本节点，避免逐节点重复扫描。
- 每个关键词最多记录 2000 个命中，超出部分截断，防止极端关键词拖垮内存和渲染。
- DOM 变化（流式输出、向上加载历史、切换会话）会让文本缓存失效，下一次搜索自动重建；连续输入时只重扫关键词，不重扫 DOM。
- 输入有 90ms 防抖，输入法组词期间跳过搜索。

## 快捷键说明

Web 端 DSH 的快捷键服务只接受 `Mod+/`、`Mod+Shift+,`、`Mod+Shift+.` 这类组合，`Mod+F` 绑不进去。所以插件在窗口捕获阶段自己监听 `Ctrl/Cmd+F`，同时阻止浏览器原生查找。这样不依赖快捷键服务，也不占用可配置的快捷键名额。

## 安装

从 DSH 插件市场安装：在「发现」里添加市场索引

```text
https://shutongX.github.io/dsh-plugins-index/index.json
```

找到 `dsh-chat-find` 点安装，按提示重启 DSH。

也可以直接装 GitHub 版本：

```sh
dsh plugin --profile desktop add https://github.com/shutongX/dsh-chat-find
```

本地开发：在 profile 的 `package.json` 里把依赖指向本地目录，再执行 `pnpm install`：

```json
{
  "dependencies": {
    "dsh-chat-find": "link:C:\\path\\to\\dsh-chat-find"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-chat-find"]
    }
  }
}
```

重启 DSH 后按 `Ctrl+F`（macOS 为 `Cmd+F`）使用。
