/**
 * dsh-chat-find — 会话内查找。
 *
 * 功能全在浏览器侧（lib/client.js）：搜索当前会话聊天区里已经渲染的文本，
 * 用 CSS Custom Highlight API 高亮，并滚动到命中位置。
 * host 侧只需要一个装载入口，客户端 bundle 才会被 client-modules 发现。
 */
export const name = 'dsh-chat-find';

export function apply() {}
