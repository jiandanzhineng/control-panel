# 分离式游戏标准（game-core 契约）

> 状态：已实施（步骤 5 前半，2026-10-07）
> 承接：[2026-10-06-remote-session-mode.md](../plan/2026-10-06-remote-session-mode.md) §4.5「游戏：逻辑跟着设备走」
> 相关：[game-runtime-unified-design.md](game-runtime-unified-design.md)（页面式游戏）、ADR-0004/0005（玩法唯一性与权威状态）

分离式游戏 = **逻辑文件 + 画面文件**。逻辑跑在设备所在端的后端（本机游玩时就是本机后端），
两端画面订阅同一份状态快照；「触发 → 判断 → 输出」不经网络。

## 1. 游戏包布局

游戏包就是现在从游戏库安装的 zip（`backend/games/<folder>/` 内置，或
`<BACKEND_DATA_DIR>/game-cache/<id>/<version>/` 缓存安装），多出一个逻辑文件：

```
<包目录>/
  index.html       必需。内含 <script type="application/json" id="game-manifest">，画面与页面式游戏同构
  game-core.js     分离式游戏必需。纯逻辑，被宿主后端加载（默认名，可用 manifest.core 改名）
  i18n.js          可选
  voices/          可选
```

## 2. manifest 字段（写在 index.html 的内联 manifest 里）

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` / `title` / `version` | 是 | 与 registry 条目一致；版本不一致时连接两端会提示从游戏库更新 |
| `devices` | 是 | 设备角色：`{ id, label, capabilities[], required }`，与宿主 `deviceMap` 的键一致 |
| `params` | 是 | 参数 schema：`{ key, type, default, label, group, min, max, step, device? }` |
| `runtime` | 分离式必需 | 固定 `"host"`：声明本包由宿主后端跑逻辑。缺省 = 页面式（iframe）游戏 |
| `core` | 否 | 逻辑文件名，默认 `game-core.js`；必须落在包目录内（词法 + 真实路径双重校验，软链越界拒绝） |
| `events` | 否 | 事件模式。`"v2"` = 接收通用设备事件（下表）；缺省 = legacy：只收 `sensor` 角色的气压事件（内置核心与既有包的行为） |

`runtime: 'host'` 的包会出现在宿主游戏清单里（`GET /api/game-runtime/games`、
`remoteGameService` 的可启动游戏列表、前端「分离式游戏」区块），**不需要**改客户端代码。

## 3. 逻辑文件契约（game-core.js）

模块导出：构造函数本身，或 `{ createCore }`，或 `Core` / `GameCore` / 唯一一个 `*Core` 命名导出。
宿主用 `new Ctor({ params, random })` 实例化，实例必须实现：

| 方法 | 说明 |
|---|---|
| `start(nowMs)` | 开始一局；返回 `result` |
| `step({ nowMs, events })` | 宿主每 80ms 调一次（`events` 为这段时间收到的传感器事件）；返回 `result` |
| `snapshot()` | 返回可序列化快照，画面只渲染它 |
| `pause(nowMs)` / `resume(nowMs)` / `stop(nowMs, reason)` | 生命周期 |
| `setParams(params)` | 参数变更（宿主已按 schema 校验过键） |
| `action(name, payload, nowMs)` | 画面按钮动作（加强度、电击一次、微调阈值等） |

`result` = `{ ok, snapshot, effects[], logs[], nextWakeAtMs }`：

- `effects` 是**设备意图**（唯一输出通道），宿主按角色映射执行并做安全钳制：
  `device.set-strength {role,value}`、`device.stop-strength {role}`、`device.shock {role,voltage,durationMs}`、
  `device.shock-stop {role}`、`device.lock {role,open}`、`device.set-report-delay {role,ms}`、
  `device.stop-all`（结束/复位）。宿主还会对未知 effect 记错误而不是崩掉。
  **远程会话**（`source:'remote'`，即主控端起在本局的 HostRuntime）下，每条意图还要过
  `remoteOutputGuard`：按设备类型/能力逐字段钳制（默认电压 20 / 功率 128 / 强度 50，比核心自身的
  安全上限更严）、未知意图类型与非法字段一律拒绝（写进操作记录）、停止永远放行；
  锁存输出登记看门狗（电击 10s、电机 60s）兜底停机。本机玩法（`source:'local'`）行为不变。
- `logs` 是给画面看的中文日志（`{level,message,atMs}`），宿主截取最近若干条随快照下发。

**宿主 → 核心的事件（`step` 的 `events`）**：宿主按设备转发**已映射设备**（`deviceMap` 里的设备）的事件，
未映射设备的属性/消息一律不转发；属性只在值真的变化时转发（设备会周期性重报同一份数据）。

| 事件 | 形状 | 说明 |
|---|---|---|
| 属性变化 | `{ type:'device-property', role, deviceId, name, value, oldValue }` | 该设备任一属性变化；`role` 是它在 `deviceMap` 里的角色，`name` 是设备属性名（`button0`/`button1`/`pressure1`…），`oldValue` 首帧为 `null` |
| 属性基线（开局补发） | `{ type:'device-property', role, deviceId, name, value, oldValue:null, seed:true }` | 开局时按设备当前属性补发一次（对齐页面版启动时的 `readValue`）。`seed:true` 表示这是**基线不是变化**：按钮这类「按住即违规」的属性必须只当状态记下，等真实变化（`oldValue` 非 `null`）才判违规，否则开局就电击；压力这类页面版本来就 `readValue` 的属性可照常按当前值判定（仍走防抖） |
| 设备消息 | `{ type:'device-event', role, deviceId, name, payload }` | 设备原始消息（`name` 取 `payload.action` 或 `payload.method`），`payload` 是原消息 |
| 锁按键 | `{ type:'action', name:'lock-key', role, deviceId }` | `payload.method==='action' && action==='key_clicked'` 时的兼容别名，与页面版 `onMessage` 判断等价 |
| 传感器值（legacy） | `{ type:'sensor', role:'sensor', name:'sphincterPressure', value }` | 仅 legacy 模式：只转发 `deviceMap.sensor` 角色的 `pressure`/`sphincterPressure`，两个内置核心靠它 |

**两种事件模式**：manifest 声明 `"events":"v2"` 的包收上面三行的通用事件（另外开局时会按设备
当前属性补发一次初始值，对齐页面版 `readValue`，补发事件带 `seed:true`）；其余（含两个内置核心）保持 legacy 通道，
逐字维持改动前的转发行为，不受本次通用化影响。

> 同一台设备被映射到多个角色时，事件里的 `role` 只带其中一个（先声明的那个）；核心应优先按
> `name`（属性名）判断，不要依赖 `role` 区分同一台设备的不同用途。

> 事件到达即触发一次即时 `step`（同一次设备回调里的多个属性合并成一个事件批次 → 一次 `tick`，
> 同步执行），所以「触发 → 判断 → 输出」在同一个 `step` 内完成，不额外等 80ms 定时器。
> 多个设备同一批变化也只 tick 一次。

## 4. 确定性规则（上架审核的硬要求）

1. 不碰 DOM / window / document / canvas / 音频；逻辑文件在 Node 后端跑，没有这些全局。
2. 不用 `setTimeout` / `setInterval` / `Date.now()` / `performance.now()`；**时间只能来自 `nowMs`**。
3. 不做网络、文件、子进程、环境变量、`process`、`global` 读写。
4. 不用 `eval` / `new Function` / `vm` / 动态 `require`。
5. 随机数只能用宿主注入的 `random()`（测试会注入固定值复现）。
6. 不写全局状态（模块级变量只在包内可见，但同一版本会被缓存复用，必须可重入）。
7. 内存有界：采样/历史数组要设上限（宿主侧 `append` op 上限 200 条/次，`MAX_OPS` 500）。
8. 输出只经 `effects`；不得直接 `require` 设备服务。

## 5. 画面同步（patch 协议）

状态文档（本机 `/api/game-runtime/status`、远程 `/api/remote-game/status` 的整份响应）
按 **rev** 单调递增地增量推送；没有变化不发任何消息。

- 帧格式（SSE 与 MQTT 相同）：
  - `{ type: 'snapshot', rev, state }`：进流首帧、重连、补全量。`state` 是整份状态文档。
  - `{ type: 'patch', rev, baseRev, ops }`：`baseRev` 必须等于消费端本地 rev，否则补全量。
- op 格式（`backend/public/game-state-patch.js`，前端同源实现 `frontend/src/play/gameStateStream.ts`）：
  - `{ op:'set', path:'a.b', value }` / `{ op:'del', path:'a.b' }`
  - `{ op:'append', path:'samples', items:[…] }`（尾部新增：曲线采样点只发新增段）
  - `{ op:'prepend', path:'logs', items:[…] }`（头部新增：日志数组最新在前）
  - 根路径为 `''`（整份替换，op 数超 500 时的兜底）
- 合并：同一 50ms 窗口内的多次变化合并为一条（上限约 20 条/秒）。
- 传输：本机页面走 `GET /api/game-runtime/stream`（SSE，`snapshot` 后 `patch`）；
  主控端页面走 `GET /api/remote-game/stream`（同协议）；被控端 → 主控端走 MQTT
  `game.patch`（同一 rev 序列），断档时主控端发 `game.snapshot.request` 补全量。
- 旧客户端兼容：主控端仍以低频（5s）发全量 `game.snapshot`，移动端等只认全量的实现不受影响。

## 6. 上架审核清单（逻辑文件）

逐条检查 `game-core.js`（可用 `grep` 快速过一遍）：

- [ ] 无 `require('fs'|'net'|'http'|'https'|'child_process'|'worker_threads'|'vm')`
- [ ] 无 `process` / `global` / `globalThis` 读写，无环境变量
- [ ] 无 `eval` / `new Function` / 动态 `require` / 字符串拼接出的模块名
- [ ] 无 `setTimeout` / `setInterval` / `Date` / `performance`（时间只用 `nowMs`）
- [ ] 无 `fetch` / `XMLHttpRequest` / `WebSocket` / `navigator` / DOM API
- [ ] 随机只用注入的 `random`；不读系统时间做决策
- [ ] 数组/历史有上限，长局不会无界增长
- [ ] 输出只通过 `effects` 的设备意图；不直接调用设备服务
- [ ] 需要按钮/锁/压力等设备事件时，manifest 声明 `"events":"v2"`，并只处理契约里的事件形状（不假设设备属性名之外的东西）
- [ ] `snapshot()` 返回值可 `JSON.stringify`（无函数、无循环引用、无 Map/Set）
- [ ] 参数键与 manifest `params` 一致；`setParams` 不抛未捕获异常
- [ ] 版本号已随逻辑改动更新（`manifest.version` 与 registry 条目一致）

## 7. 实现位置

| 关注点 | 文件 |
|---|---|
| 核心解析（包 core 优先、内置兜底、按 id@version 缓存） | `backend/game-runtime/gameCoreResolver.js` |
| 宿主运行、设备意图执行、状态文档进流 | `backend/game-runtime/gameHostService.js` |
| rev / 合并窗口 | `backend/game-runtime/gameStateStream.js` |
| diff / apply（后端与浏览器共用） | `backend/public/game-state-patch.js` |
| 本机页面推送 | `backend/routes/gameRuntime.js` `GET /stream` |
| 远程推送 | `backend/services/remoteGameService.js`（`game.patch` / `game.snapshot.request`）、`backend/routes/remoteGame.js` `GET /stream` |
| 游戏页桥 | `backend/public/game-runtime-bridge.js`（SSE 优先，失败回落轮询） |
| 前端消费 | `frontend/src/play/gameStateStream.ts`、`gameStateStreamClient.ts` |

> 安全边界：逻辑文件**不做运行隔离**（用户 2026-10-06 决定），以普通 JS 在被控端后端加载，
> 安全性靠本清单的上架审核；设备输出仍受 `remoteOutputGuard` 与锁存看门狗约束（输出层保护，非代码隔离）。
> 第三方代理游戏一律按页面式运行，不允许以分离式运行。



