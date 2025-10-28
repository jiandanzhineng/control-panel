# PRD — 嵌入式 HTML + SSE（单文件游戏包）

## 背景与目标
- 背景：为提升游戏 UI 自由度与交付效率，采用“游戏 JS 内嵌完整 HTML 页面”的方式，首屏一次性下发完整页面，之后通过 SSE 推送变量实现局部刷新。
- 目标：定义单文件打包的约定、前后端接口与事件模型、页面内绑定规范与动作触发，强调本阶段不做安全隔离（无需 sandbox/iframe）。

## 单文件打包（HTML在JS内部）
- 存放位置：`backend/game/<name>.js`（沿用现有扫描规则）。
- 模块导出（最小约定）：
  - 字段：`title`（string）、`description`（string）、`requiredDevices`（Array<{logicalId, required?, name?}>）
  - 方法：`start(deviceManager, parameters)`、`loop(deviceManager)`；可选：`end(deviceManager)`、`updateParameters(parameters)`。
  - 新增：`html`（string）或 `getHtml(): string`，用于返回完整 HTML 页面文本。
- 说明：不再单独提供 `ui.json`；UI 结构与样式由嵌入式 HTML 自主管理。

## 事件与推送（SSE）
- 路由：`GET /api/games/:id/stream`
- 事件类型：
  - `hello`：连接初始化。`{ snapshot }`（首屏状态快照）。
  - `state`：状态增量更新（键值对）。
  - `ui`：界面相关增量（可选，如 `{ fields: { k: v } }`）。
  - `log`：运行日志；`ping`：心跳。
- 备注：推送节流建议默认不超过 10 事件/秒；客户端增量应用，避免整页重绘。

## 后端接口
- 启动：`POST /api/games/:id/start`
- 停止：`POST /api/games/stop-current`
- 状态：`GET /api/games/status`
- 订阅：`GET /api/games/current/stream`
- 动作：`POST /api/games/current/actions`（Body：`{ action, payload? }`）
- 页面：`GET /api/games/current/html` → 返回 `text/html; charset=utf-8`，内容来自玩法导出的 `html` 或 `getHtml()`。

## 前端集成（无安全隔离）
- 详情页：`/games/current` 请求 `/api/games/current/html`，返回内容直接插入容器（`innerHTML`/`v-html`）。
- 模板统一脚本：页面模板注入运行时脚本，自动建立 `EventSource('/api/games/current/stream')` 订阅并增量应用到 `data-*` 绑定；按钮通过 `data-action` 统一触发 `POST /api/games/current/actions`。
- 绑定规范（轻量约定）：
  - `data-bind="key"`：将 SSE 的 `{ key: value }` 映射为元素文本。
  - `data-show="key"`：布尔显示控制；`true` 显示、`false` 隐藏。
  - `data-class="key:className"`：当 key 为真时添加 `className`。
  - `data-action="name"`：点击触发 `POST /actions`，可结合 `data-payload`（JSON）。

## 最小示例（单文件玩法）
```js
// backend/game/demo_game.js
module.exports = {
  title: '示例联动游戏',
  description: 'HTML内嵌 + SSE 刷新',
  requiredDevices: [ { logicalId: 'lamp-1', required: false } ],
  html: `<!doctype html>
<html><head><meta charset="utf-8"><title>Demo Game</title>
<style>[data-hide="true"]{display:none}</style></head>
<body>
  <h2>Score: <span data-bind="score">0</span></h2>
  <div id="lamp">Lamp On: <span data-bind="lampOn">false</span></div>
  <button data-action="resetAll">复位</button>
  <script>
    const params = new URLSearchParams(location.search); const gameId = params.get('id');
    const state = {}; function apply(patch){ Object.entries(patch||{}).forEach(([k,v])=>{
      state[k]=v; document.querySelectorAll(`[data-bind="${k}"]`).forEach(el=>{ el.textContent=String(v); });
      document.querySelectorAll(`[data-show="${k}"]`).forEach(el=>{ el.dataset.hide = v? 'false':'true'; });
      document.querySelectorAll(`[data-class]`).forEach(el=>{
        const spec=el.dataset.class||''; const [key,cls]=spec.split(':'); if(key===k){ el.classList.toggle(cls, !!v); }
      });
    }); }
    const es = new EventSource(`/api/games/${gameId}/stream`);
    es.addEventListener('hello', e=>{ const { snapshot } = JSON.parse(e.data||'{}'); apply(snapshot); });
    es.addEventListener('state', e=> apply(JSON.parse(e.data||'{}')));
    es.addEventListener('ui', e=> { const d=JSON.parse(e.data||'{}'); apply(d.fields||d); });
    es.addEventListener('log', e=> console.log('[log]', JSON.parse(e.data||'{}')));
    document.addEventListener('click', async (ev)=>{
      const btn = ev.target.closest('[data-action]'); if(!btn) return;
      const action = btn.dataset.action; let payload={};
      try{ payload = btn.dataset.payload ? JSON.parse(btn.dataset.payload) : {}; }catch(_){ payload={}; }
      await fetch(`/api/games/${gameId}/actions`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action, payload }) });
    });
  </script>
</body></html>`,
  start(dm, parameters){ dm.log('info','游戏启动',{ parameters }); },
  loop(dm){ /* 周期逻辑：可读取设备状态并通过 dm 接口联动 */ }
};
```

## 交互流程（摘要）
1) 启动玩法：前端 `POST /start` → 后端加载 JS 并调用 `start`。
2) 获取页面：前端请求 `/html` 并渲染；HTML 自行建立 SSE 连接。
3) 推送刷新：后端按设备变化/定时逻辑推送 `state/ui/log`，页面绑定增量应用。
4) 动作触发：页面 `POST /actions` → 后端执行并反馈（日志/状态）。
5) 停止：前端 `POST /stop-current`，后端结束运行并关闭推送。

## 验收标准
- `/html` 响应及时，首屏加载后 1 秒内收到 `hello` 快照并正确显示。
- SSE 事件到达后 1 秒内更新对应绑定元素；动作触发后可见日志或状态反馈。
- 长时间运行稳定，事件速率与页面性能可控（默认≤10事件/秒）。

## 非功能要求（本阶段）
- 安全：不做隔离；页面直接插入与脚本执行；后续需要时再引入 sandbox/iframe。
- 性能：后端建议做事件聚合与节流；页面增量更新，避免重排过多。
- 可维护：绑定约定保持轻量、明确；玩法内的 HTML 组织自由但建议模块化。

## 与 UI Schema 的关系
- 本方案替代 `ui.json`，由玩法内嵌 HTML 自主渲染。
- 若通用配置面板仍需 Schema，可保留列表页/管理页的 Schema 渲染，两者并存。