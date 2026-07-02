# 插件系统设计

本文描述"插件（Plugin）"子系统的设计。插件与内建游戏并列，是控制面板的第二种玩法载体。

> 本设计的关键决策记录在 `docs/adr/0001~0005`，术语定义见根目录 `CONTEXT.md`，阅读本文前建议先过一遍。

## 1. 背景与动机

内建游戏（`backend/games/`）的输入信号来自硬件传感器（如 QTZ 距离/按钮），游戏页面运行在面板自己的 iframe 中，通过 `DeviceAPI`（WebSocket）驱动设备。

插件解决的是另一类需求：**输入信号来自真实的第三方网站**。典型场景——在扇贝单词网页版背单词，答错时触发电击惩罚。

与游戏的本质区别：

| 维度 | 内建游戏 | 插件 |
| --- | --- | --- |
| 输入信号 | 硬件传感器上报 | 真实第三方网站的行为 |
| 页面来源 | 面板自己 serve 的 iframe | 真实网站，原始域名，登录态完整 |
| 页面 origin | 面板 origin | 第三方 origin（如 `web.shanbay.com`） |
| 设备驱动 | 页面内 `DeviceAPI`（浏览器 WebSocket） | preload 内 `DeviceAPI`（Node WebSocket） |
| 状态 UI | 游戏页自带 | detector 注入到目标网页 DOM（右下角悬浮，仅显示状态、无停止按钮） |

> 信任边界：本机即可信，bridge **不加任何认证/token**。防的是第三方页面脚本拿到 Node 能力，这一层只靠 Electron 沙箱隔离（见第 10 节）。

## 2. 为什么不用代理方案

早期设想过用反向代理（`gameProxy.js`）把扇贝页面同源化后嵌 iframe。此路不可行：

- Cookie/Session 绑定原始域名，代理换域后登录态全丢。
- 现代站点有 CORS、SameSite Cookie、HSTS，代理难以打通。
- 本质是 MITM，第三方站可检测。

因此插件走 **Electron session preload 注入**，等价于浏览器扩展的 content script：目标网站的原始域名、Cookie、登录态完全保留，只是额外多跑注入的检测脚本。

## 3. 总体架构

插件运行时是一个**顶部带精简导航栏的浏览器页**，主体是加载真实网站的 `<webview>`。检测逻辑跑在 webview 的 preload 里，直连面板 bridge 驱动设备。

```
┌─ 插件运行页（Vue，面板 origin）────────────────────────────┐
│ [←][→][↻] web.shanbay.com/...            [停止]  │ ← 精简导航栏（停止是唯一停止入口）
├────────────────────────────────────┤
│                                       │
│   <webview src="https://web.shanbay.com/...">       │
│     真实扇贝页面（原始域名，登录态完整）              │
│                                       │
│     preload = detector.js（一次挂载、全程不动）:      │
│       · Node WebSocket 直连 ws://127.0.0.1:5277/bridge │
│       · window.DeviceAPI 与游戏同接口                 │
│       · 自决：按 matchUrls 判断当前页要不要干活        │
│       · 拦截 fetch/XHR 判定答对/答错                   │
│       · 答错 → DeviceAPI.device('shock').invoke(...)  │
│       · 注入右下角悬浮状态 UI（仅显示状态，无按钮）    │
│                            ┌────────┐│
│                            │⚡3 ✓12  ││ ← detector 注入的悬浮 UI（只读状态）
│                            └────────┘│
└────────────────────────────────────┘
```

信号链路：

```
detector.js（webview preload，Node 环境）
  └─ Node WebSocket → ws://127.0.0.1:5277/bridge（面板前端服务代理到后端）
       └─ 后端 bridgeService → MQTT → 设备
```

关键点：preload 是 Node 环境，`require('ws')` 建立的连接不经过浏览器同源策略，因此能从 `web.shanbay.com` 的页面里连上面板本机的 bridge，这是整个方案成立的基础。

## 4. 插件包结构与发现

每个插件是 `backend/plugins/<id>/` 下的一个目录，类比 `backend/games/<id>/`：

```
backend/plugins/
  shanbay-shock/
    manifest.json     ← 插件声明（目标网站、设备需求、参数）
    detector.js       ← 注入到目标网页的检测脚本（webview preload）
```

**发现机制**：`listPlugins()` 从一开始就扫描**两个目录**并合并：

1. 内置目录：`backend/plugins/`（随包发布）。
2. 用户目录：`userData/plugins/`（为未来 zip 动态安装预留位置，当前不实现 zip 安装）。

**打包**：内置插件目录经 electron-builder 的 `extraResources` 复制到 `resources/plugins/`（真实文件路径，规避 asar 内 preload 无法被 `require` 加载的限制）。detector 的路径一律按"插件所在目录的绝对路径"计算，**不硬编码**，因此内置目录与用户目录下的插件走同一套逻辑。

`manifest.json` 字段与游戏 manifest 的 `devices`/`params` 对齐，便于复用配置页逻辑：

```json
{
  "id": "shanbay-shock",
  "title": "扇贝单词电击",
  "description": "答错单词时触发电击惩罚",
  "version": "1.0.0",
  "homeUrl": "https://web.shanbay.com/wordbook/wordlist/",
  "matchUrls": ["*://web.shanbay.com/*", "*://*.shanbay.com/*"],
  "devices": [
    { "id": "shock",    "capabilities": ["shock"],    "required": true  },
    { "id": "vibrator", "capabilities": ["strength"], "required": false }
  ],
  "params": [
    { "key": "shockVoltage",  "type": "number", "default": 15,   "min": 5,   "max": 100, "label": "电击强度(V)" },
    { "key": "shockDuration", "type": "number", "default": 2,    "min": 1,   "max": 10,  "label": "电击时长(秒)" },
    { "key": "cooldownMs",    "type": "number", "default": 3000, "min": 500,             "label": "答题冷却(毫秒)" },
    { "key": "maxShocks",     "type": "number", "default": 50,   "min": 1,               "label": "单次上限(次)" }
  ]
}
```

字段说明：

- `homeUrl`：启动插件后 webview 默认加载的地址。
- `matchUrls`：URL 匹配模式（通配 `*`）。detector 一次挂载后**自己**据此判断当前页要不要干活：命中则拦截、不命中则装死（不做任何注入/拦截），避免影响其他网站。**不由主进程动态挂卸 preload**。
- `devices` / `params`：与游戏 manifest 完全相同的结构，配置页可直接复用。

## 5. 配置传递：配置信箱文件

游戏通过 URL query（`?deviceMap=&params=`）把配置注入 iframe，因为游戏页 URL 完全可控。插件的目标页是第三方 URL（如 `web.shanbay.com`），无法把参数塞进它的地址栏，preload 又在页面加载前执行、拿不到路由参数。

采用 `active-plugin.json` 作为**纯配置信箱**（相比 IPC 推送更稳定，无时序竞态）。**它只负责把 `deviceMap` / `params` 交给 detector，不承担任何运行状态语义**——是否在跑、跑的是谁，一律以 bridge 的活跃 session 为准（见第 6 节），停止也不依赖删除该文件。

1. 用户在配置页选好设备映射和参数，点"启动"。
2. 前端 `POST /api/plugins/:id/activate`，body 为 `{ deviceMap, params }`。
3. 后端把配置写入 `userData/data/active-plugin.json`（信箱）：

   ```json
   {
     "pluginId": "shanbay-shock",
     "deviceMap": { "shock": ["dev-abc"], "vibrator": [] },
     "params": { "shockVoltage": 15, "shockDuration": 2, "cooldownMs": 3000, "maxShocks": 50 },
     "startedAt": 1719800000000
   }
   ```

4. 前端跳转到运行页，webview 加载 `homeUrl`。
5. detector 早已一次性挂载在 webview 上；导航到命中 `matchUrls` 的页面时它自决启用。
6. detector 执行的第一步就是同步 `require` 读取 `active-plugin.json`，拿到完整 `deviceMap` / `params` 后初始化 `DeviceAPI`。

因为文件读取是同步的，detector 第一行即可拿到配置，不存在"还没收到配置就开始检测"的竞态。效果与游戏"从 URL 读参数"一致——都是**启动前选好、一次性交给运行载体**。

运行页 webview 与内置浏览器**共用同一 `partition`**，从而复用登录态。对命中的 webview 需设 `sandbox=false`，preload 才能 `require` Node 模块；`contextIsolation` / `nodeIntegration` 维持现有加固、不放松（见第 10 节安全说明）。

## 6. 信号链路与 DeviceAPI

插件复用游戏的 `DeviceAPI` 抽象，写法完全一致。区别只在底层连接：

- 游戏：`device-api-bridge.js` 用**浏览器 WebSocket**连 `/bridge`（页面在面板 origin，允许）。
- 插件：detector.js 在 preload 里用 **Node `ws` 模块**连 `ws://127.0.0.1:5277/bridge`（页面在第三方 origin，浏览器 WebSocket 会被同源/混合内容策略拦截，但 Node 连接不受限）。

detector.js 内**照抄一份 Node 版 `DeviceAPI`**（与 `device-api-bridge.js` 协议一致），暴露到 `window.DeviceAPI`，于是检测代码与游戏 `game.js` 写法相同。**刻意不与游戏侧 `device-api-bridge.js` 抽公共层**——保持简单，不动已经跑得好的游戏代码：

```js
// detector.js 内，答错时
DeviceAPI.device('shock').invoke('shock', 'start', { voltage: params.shockVoltage });
setTimeout(() => DeviceAPI.device('shock').invoke('shock', 'stop', {}), params.shockDuration * 1000);
```

bridge 的 init 握手同样复用：detector 连上后发送 `{ action: 'init', deviceMap, params }`，后端按现有逻辑建立设备通道。设备下发链路（`deviceService`、MQTT）**零改动**；但 bridge 的 **session 生命周期需新增改造**（唯一性顶旧、退出信号复位、60 秒宽限期），见 6.1、6.2 与第 11 节。

> 连接目标端口：Electron 生产模式下前端服务在 `127.0.0.1:5277` 并把 `/bridge` 代理到后端 `5278`（见 `electron/main.js` 的 `bridgeWsProxy`）。detector 连 `5277` 即可复用该代理；也可由主进程把实际 bridge 地址一并写入 `active-plugin.json`，避免端口硬编码。

### 6.1 玩法唯一性与状态权威

- **全局同一时刻只有一个玩法在跑**（游戏或插件二选一，互斥）。启动新玩法时**自动顶掉**旧的，不拦截、不弹提示。
- **不额外维护运行状态**，以 bridge 的活跃 session 为**唯一真相**。判断"现在有没有玩法在跑、是哪个"都看 bridge 当前 session。
- 新玩法 `init` 时若已有旧 session：bridge 先**复位旧 session 的设备**（见 6.2）、断开旧连接，再建立新 session。旧玩法因此被无感顶掉。

### 6.2 设备复位

设备侧**没有统一 close 操作**。"复位" = 对该 session 映射的每个设备，按能力逐一调 stop：

- `shock` 能力 → `shock` `stop`（等价电量归零 `shock:0`）。
- `strength` 能力 → `strength` `stop`（等价 `power:0`）。

复位有两条通道，且**与 ws 断开解耦**：

- **主道（显式退出信号）**：这是正常停止路径。
  - 插件：运行页 webview 被关闭 → **主进程**监听 webview 销毁并向 bridge 发"退出信号"（页面已关，detector 自己发不出）。
  - 游戏：前端离开游戏页时发退出信号。
  - 退出信号**不带 id**，语义是"复位当前活跃玩法"——靠全局唯一性定位到那唯一的 session。
- **兜底（ws 断开 60 秒宽限期）**：只处理崩溃/断电/来不及发信号的异常情况。
  - ws `close` **不再立即复位**，而是把该 session 转入"待定"并起一个 60 秒计时器。
  - 60 秒内重连即恢复，取消计时器；超时未重连才执行兜底复位。

## 7. 前端页面与路由

插件入口统一收纳在"游戏"侧边栏下，不新增顶层导航项。三个页面：

| 路由 | 名称 | 说明 |
| --- | --- | --- |
| `/plugins` | 插件列表 | 卡片展示已安装插件（图标、名称、描述、目标域名），点击进入配置 |
| `/plugins/:id/config` | 插件配置 | 设备映射 + 参数配置，**照抄 `GameStartConfigView.vue` 改**；点"启动"调 `activate` 后跳运行页 |
| `/plugins/:id/run` | 插件运行 | 顶部精简导航栏 + 全宽 webview |

侧边栏：现有"游戏管理"入口下增加"插件"子项（或在游戏列表页加"插件"标签页）。游戏与插件在信息架构上归为同一类"玩法"。

运行页布局：

- 顶部导航栏高度尽量小（约 40px）：后退、前进、刷新、地址显示、停止按钮。地址栏只读展示当前 URL 即可（插件场景通常不需要用户手输网址；如需可保留输入）。
- **停止**是唯一的停止入口：点停止 = 离开运行页 / 销毁 webview → 主进程发退出信号 → bridge 复位当前活跃玩法（见 6.2 主道）。无需专门的 `deactivate` 接口来协调。
- 主体 `<webview partition="persist:browser">`，与内置浏览器共用同一 session，从而复用登录态、更像统一的浏览器。
- 状态 UI 不在导航栏——由 detector 注入到目标网页右下角（见第 2、10 节），只显示状态，无停止按钮。

复用与差异：配置页的设备映射表格、参数表单、校验逻辑与 `GameStartConfigView.vue` 几乎相同，**直接照抄 `GameStartConfigView.vue` 改一份，不抽公共 `ConfigForm` 组件**（保持简单，避免为两处复用引入抽象）。

## 8. 后端接口

新增 `backend/routes/plugins.js` + `backend/services/pluginService.js`，`backend/index.js` 挂载 `/api/plugins`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/plugins` | 列出所有插件（扫描内置目录 + `userData/plugins/`，读 manifest） |
| GET | `/api/plugins/:id` | 单个插件详情（含 devices/params，供配置页用） |
| POST | `/api/plugins/:id/activate` | body `{ deviceMap, params }`，写配置信箱 `active-plugin.json`，返回 `{ ok, homeUrl }` |

只有 3 个接口。**没有 `deactivate`、也没有 `active` 接口**：停止走"webview 销毁 → 主进程发退出信号 → bridge 复位"（见 6.2、第 7 节），不经后端接口；运行状态以 bridge session 为准，无需查询接口。

`pluginService.js` 职责：

- `listPlugins()`：扫描**两个目录**（内置 + `userData/plugins/`）、解析每个 `manifest.json` 并合并。
- `getPluginById(id)`：读单个 manifest，附带 `detectorPath`（按插件所在目录算的绝对路径，供主进程注入）。
- `activate(id, { deviceMap, params })`：写配置信箱 `active-plugin.json`。
- 静态托管 detector：由主进程直接读文件路径注入（preload 用文件路径而非 URL）。

设备下发**不新增接口**：detector 直接连 bridge 走 `DeviceAPI`，与游戏一致。后端只负责插件的发现、激活配置的持久化。

## 9. 安全限制

电击设备接入自动触发链路，必须有硬约束。原则：**限制写在设备下发前的公共路径上，前端/detector 不可绕过**。

- 电压封顶：`voltage = Math.min(100, Math.max(0, voltage))`（沿用游戏现有做法）。
- 单次时长封顶：`duration = Math.min(10, duration)` 秒。
- 触发冷却：两次触发最小间隔 `cooldownMs`，由 detector 侧计时并在 bridge/后端侧兜底校验，避免连续误判导致连电。
- 单次会话上限：`maxShocks`，到达后停止触发并更新悬浮 UI 状态。
- 一键停止：运行页导航栏"停止" → 销毁 webview → 主进程发退出信号 → bridge 复位当前活跃玩法（每个映射设备逐能力 `stop`，见 6.2）。**不经 `deactivate` 接口、不靠删配置文件**。
- 误判保护：detector 只有在**明确判定答错**时才触发；接口/DOM 都无法确定时不触发（宁可漏，不可误电）。
- 启动确认：进入第三方网站前弹确认框（复用游戏的外部网页提示）。

## 10. detector.js 编写规范

detector.js 运行在 webview 的 preload（Node 环境，可 `require`，有 `ipcRenderer`）。preload **一次挂载、全程不动**，由 detector 自己按 `matchUrls` 自决是否在当前页干活。安全边界靠 Electron 沙箱：命中的 webview 设 `sandbox=false` 以允许 preload `require`，但 `contextIsolation` / `nodeIntegration` 维持现有加固不放松，防止第三方页面脚本拿到 Node 能力。编写约束：

- **自决启用**：detector 先按 `matchUrls` 判断当前 URL 是否目标站；不命中则装死，不注入、不拦截、不连 bridge。
- **只读不写目标页逻辑**：拦截 fetch/XHR 只观察，不改请求/响应，不干扰扇贝原有行为。
- **判定优先级**：优先拦截答题 API（最稳），DOM MutationObserver 兜底，两者都无法判定时不触发。
- **初始化顺序**（仅在命中目标站时）：
  1. 同步 `require('fs')` 读 `active-plugin.json`（配置信箱），取 `deviceMap` / `params`。
  2. 用 Node `ws` 连 bridge，构建 `DeviceAPI` 并 `init` 握手。
  3. 包装 `window.fetch` / `XMLHttpRequest`。
  4. `DOMContentLoaded` 后注入右下角悬浮**状态** UI（自建 div，样式内联，`position:fixed`）。
- **悬浮 UI 只显示状态**：位置、样式由 detector 决定，内容仅为只读状态（⚡触发次数、✓正确、✗错误）。**不放停止按钮**——detector 关不掉自己的宿主 webview，停止唯一入口是运行页导航栏。
- **容错**：bridge 断线自动重连；解析失败静默忽略；绝不抛异常影响目标页。

骨架示意：

```js
// detector.js (webview preload)
const fs = require('fs');
const WebSocket = require('ws');

const active = JSON.parse(fs.readFileSync(process.env.ACTIVE_PLUGIN_PATH, 'utf-8'));
const { deviceMap, params } = active;

const DeviceAPI = buildDeviceAPI(active.bridgeUrl, deviceMap, params); // 与游戏 bridge 同协议
window.DeviceAPI = DeviceAPI;

const _fetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await _fetch(input, init);
  const url = typeof input === 'string' ? input : input?.url;
  if (isReviewApi(url)) {
    res.clone().json().then(d => onResult(judge(d))).catch(() => {});
  }
  return res;
};

function onResult(correct) {
  if (correct === false) triggerShock();
  updateFloatingUI();
}
```

> 扇贝答题 API 的 URL 与响应字段名需实际抓包确认（在扇贝网页版答一题看 Network），再落到 `isReviewApi` / `judge`。

## 11. 实现清单

按依赖顺序：

1. **后端**：`pluginService.js`（`listPlugins` 扫两个目录 / `getPluginById` / `activate` 写配置信箱）+ `routes/plugins.js`（仅 3 个接口：列表 / 详情 / activate），`index.js` 挂载 `/api/plugins`。
2. **主进程**（`electron/main.js`）：
   - 给运行页命中 `matchUrls` 的 webview 一次挂载 detector 作为 preload（设 `sandbox=false`），preload 全程不挂卸；把 `ACTIVE_PLUGIN_PATH`、`bridgeUrl` 传给 preload（环境变量或写进 json）。
   - 监听运行页 webview 销毁 → 向 bridge 发**退出信号**（不带 id），触发复位当前活跃玩法。
3. **前端**：`PluginListView.vue`、`PluginConfigView.vue`（**照抄 `GameStartConfigView.vue` 改，不抽 `ConfigForm`**）、`PluginRunView.vue`（精简导航栏 + webview，共用内置浏览器 partition）；路由三条；侧边栏在"游戏"下加入口。
4. **bridge 改造**：
   - `init` 时若已有旧 session：先复位旧 session 设备、断开、再建新 session（玩法互斥、自动顶掉）。
   - 收到退出信号 → 复位当前活跃玩法（每设备逐能力 `stop`）。
   - ws `close` 不再立即复位：转"待定"起 60 秒宽限计时器，期内重连恢复，超时才兜底复位。
5. **首个插件**：`backend/plugins/shanbay-shock/`（manifest + detector）；detector 的 API/字段需抓包确认。
6. **联调**：设备映射→启动→加载扇贝→答错→电击→停止复位；验证登录态保留、冷却/上限/急停生效、旧玩法被顶掉、断线 60 秒宽限与超时复位。

> 打包硬约束：`backend/plugins` 必须经 electron-builder 的 `extraResources` 输出到 `resources/plugins`，否则打包后 preload（detector）加载不到。

### 依赖说明

- 后端/preload 需要 `ws` 模块（若 backend 已有则复用；preload 侧确认 Electron 打包后能 `require`）。
- 复用现有：bridge WebSocket、`bridgeService`、`deviceService`、设备能力校验 `/api/device-capabilities`。
