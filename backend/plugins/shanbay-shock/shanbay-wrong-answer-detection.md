# 扇贝背单词「答错」信号前端监测

监测用户在扇贝网页版（`web.shanbay.com/wordsweb`）点击「不认识 / 没想起来」等按钮，即「答错/不会」信号。

两种互补手段，建议同时用：

| 方式 | 原理 | 抓到的语义 | 抗 UI 变动 |
|------|------|-----------|-----------|
| 1. 点击委托 | 监听全文档点击 | 用户点了哪个按钮 | 中（依赖按钮文案） |
| 2. MutationObserver | 监听点击后 DOM 变化 | 判定结果 | 较高（依赖反馈文案） |

## 关键坑

- 按钮文案**有多套**：`不认识`、`没想起来` 是不同复习阶段的同义按钮，正则要全覆盖。
- 反馈文案对应关系：
  - `稍后将继续安排这个单词的学习` → 不认识（答错）
  - `已认识，该词今日不再学习` → 认识（答对）

## 方式 1：点击委托

```javascript
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button, [role="button"]');
  if (!btn) return;
  const text = (btn.innerText || btn.getAttribute('aria-label') || '')
    .trim().replace(/\s+/g, ' ');

  const WRONG = /没想起|想不起|不认识|不记得|忘记|模糊|拼写错/;
  const RIGHT = /想起来|认识|太简单|记得/;

  let signal;
  if (WRONG.test(text)) signal = 'wrong';   // ❌ 不会/答错
  else if (RIGHT.test(text)) signal = 'right'; // ✅ 会/答对
  else return;

  const word = (document.querySelector('h1,[class*="word"],[class*="Word"]')
    ?.innerText || '').split('\n')[0];
  console.log('[SHANBAY]', { signal, text, word, t: Date.now() });
}, true); // 捕获阶段，先于框架自身 handler
```

## 方式 2：MutationObserver（结果反推）

```javascript
const SIGNALS = [
  { re: /稍后将继续安排这个单词/, meaning: 'wrong' }, // 不认识
  { re: /已认识.*不再学习/,        meaning: 'right' }, // 认识
];

new MutationObserver((muts) => {
  for (const m of muts) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue; // 仅元素节点
      const txt = node.innerText || node.textContent || '';
      for (const s of SIGNALS) {
        if (s.re.test(txt)) {
          console.log('[SHANBAY-DOM]', { signal: s.meaning, t: Date.now() });
        }
      }
    }
  }
}).observe(document.body, { childList: true, subtree: true, characterData: true });
```

## 使用

贴进浏览器控制台，或封装为油猴脚本（`@match https://web.shanbay.com/wordsweb/*`）。
两个监听器会在同一次点击时先后触发（间隔约 15ms），可按 `word + 时间窗` 去重。
