# PRD — 游戏运行时 UI 方案（SSE 推送）

## 背景与目标
- 背景：系统已支持“外部玩法”（JS 文件）在后端运行，并与设备（MQTT）交互；需为前端提供统一的 UI 渲染方案与实时状态推送机制。
- 目标：定义一套前后端协同的 UI 方案，基于 SSE（Server‑Sent Events）实现实时单向推送，不使用 WebSocket；覆盖 UI Schema、事件类型、接口约定、流程与验收标准。

## 范围
- 包含：UI Schema（JSON）规范、SSE 推送协议与事件、前端渲染/订阅接口、后端路由与数据聚合约定、动作触发（Actions）。
- 不包含：复杂图表库选择与样式细节、权限系统的完整实现、Worker/沙箱安全细则（另文）。

## 角色与使用场景
- 角色：
  - 玩家/运营：选择游戏、查看实时状态与日志、点击按钮触发动作。
  - 玩法开发者：编写 JS 玩法文件，定义所需设备与 UI Schema。
  - 测试人员：验证推送与渲染、动作联通、性能与稳定性。
- 场景：
  - 列表页选择并启动游戏 → 进入运行视图 → 前端订阅 SSE 实时刷新状态与日志 → 点击动作按钮 → 后端执行并反馈 → 停止游戏并清理。

## 用户故事
- 作为玩家，我可以在游戏运行视图中看到设备状态卡片与操作按钮，状态实时更新，点击按钮立即生效。
- 作为玩法开发者，我可以为玩法定义一个简单的 UI Schema，让前端在不改代码的情况下动态渲染界面。
- 作为测试人员，我可以订阅到统一格式的状态/日志事件，便于观察与定位问题。

## UI Schema 规范
- 顶层结构
```json
{
  "id": "demo-game-1",
  "title": "示例联动游戏",
  "panels": [ /* Panel[] */ ]
}
```
- Panel 通用字段
  - `type`: `status` | `button` | `slider` | `text`（初始版本以 `status`/`button` 为主）
  - `id`: 面板唯一标识（可选；缺省用序号）
  - `title`: 显示标题
  - `device`: 关联设备的逻辑标识（与玩法 `requiredDevices.logicalId` 对齐）
- `status` 面板
```json
{ "type": "status", "title": "Lamp", "device": "lamp-1", "fields": ["on", "brightness"] }
```
- `button` 面板
```json
{ "type": "button", "label": "复位", "action": "resetAll", "payload": { "level": "basic" } }
```
- `slider` 面板（可选，后续）
```json
{ "type": "slider", "label": "亮度", "action": "setBrightness", "min": 0, "max": 100, "step": 1 }
```
- `text` 面板（可选，后续）
```json
{ "type": "text", "title": "提示", "content": "设备将随门状态自动开关" }
```

## SSE 推送协议
- 路由：`GET /api/games/:id/stream`
- Header：
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive`
- 心跳：每 15s 发送 `event: ping` 与 `data: {"ts": <number>}`，保持连接活跃。
- 事件类型与负载（`event:` 行 + `data:` 行，JSON 序列化）：
  - `ui`：界面数据更新（增量或完整）
    ```json
    { "panels": [ { "id": "lamp-1", "fields": { "on": true, "brightness": 80 } } ] }
    ```
  - `state`：游戏内部状态快照或指定键更新
    ```json
    { "tick": 42, "sensor1.temp": 31.2 }
    ```
  - `log`：运行日志
    ```json
    { "level": "info", "message": "loop started", "meta": { "elapsed": 12 } }
    ```
  - `metric`：资源/性能指标（可选）
    ```json
    { "loopElapsedMs": 15, "eventsPerMin": 120 }
    ```
  - `hello`：连接建立时的初始化（含 UI Schema 与当前状态）
    ```json
    { "schema": { /* UI Schema */ }, "snapshot": { /* 当前状态 */ } }
    ```
  - `ping`：心跳包
    ```json
    { "ts": 1710000000000 }
    ```
- 事件标识：可选 `id:` 行；若使用 `Last-Event-ID` 支持断点续推，事件需包含单调递增 `id`。

## 后端接口（REST + SSE）
- 启动玩法：`POST /api/games/:id/start`
  - Body：`{ deviceMapping?: Record<string,string>, parameters?: Record<string,any> }`
  - Resp：`{ ok: true, status: { running, title, startTime } }`
- 停止玩法：`POST /api/games/stop-current`
  - Resp：`{ ok: true, result: { duration }, status }`
- 查询状态：`GET /api/games/status`
  - Resp：`{ running, title, startTime, loopIntervalMs, gameplaySourcePath }`
- 订阅SSE：`GET /api/games/:id/stream`
  - Resp：SSE 流，建立后首先推送 `hello` 事件（含 UI Schema 与当前快照）。
- 触发动作：`POST /api/games/:id/actions`
  - Body：`{ action: string, payload?: any }`
  - Resp：`{ ok: true } | { ok: false, error }`

## 数据来源与聚合
- 设备与属性：复用 `deviceService.onDeviceDataChange`；按 `logicalId → deviceId` 映射将变更聚合成 `ui` 事件。
- 日志：复用 `gameplayService.sendLog`；统一结构 `{ level, message, extra }` 转为 `log` 事件。
- 状态快照：由玩法内部维护（如 `state` 对象或 `deviceManager.getDeviceProperty`），在 `hello` 时推送一次完整快照，之后按需推送增量。

## 前端集成
- 渲染容器：`<GameRuntime />`
  - 负责：
    - 拉取游戏详情与 UI Schema（可随 `hello` 事件下发）
    - 建立 SSE 连接并订阅事件，按类型分发到 UI Store
    - 渲染 `panels`（StatusCard/Button 等）
    - 动作触发：`POST /api/games/:id/actions`
- 事件处理：
  - `ui`：合并面板字段并重绘（避免整页刷新）
  - `state`：更新内部状态（供需要的组件读取）
  - `log`：追加到日志列表（截断防止过长）
  - `metric`：可视化或用于性能告警（可选）
  - `ping`：维持连接与健康显示
- 断线与重连：浏览器 SSE 默认重连；可在 UI 显示“已断开，重试中…”，支持手动刷新。

## 交互流程（摘要）
1. 启动玩法：前端调用 `POST /api/games/:id/start` → 后端 `gameplayService.startGameplay` 执行。
2. 订阅推送：前端 `GET /api/games/:id/stream` 建立 SSE → 后端立即发送 `hello`（Schema + 快照）。
3. 运行刷新：设备上报与玩法循环触发 → 后端聚合为 `ui/state/log` 事件推送 → 前端增量应用。
4. 动作触发：前端 `POST /actions` → 后端执行对应逻辑（调用 `deviceManager` 或玩法方法）。
5. 停止与清理：前端调用停止 → 后端结束循环与监听并发送终止通知（可复用 `log` 事件）。

## 验收标准
- SSE 建连后 1 秒内收到 `hello` 事件，包含完整 Schema 与首屏快照。
- 设备属性变化能在 1 秒内反映到相应 `status` 面板。
- 按钮动作成功执行后，能收到至少一条 `log` 或 `state/ui` 反馈。
- 连接断开时前端给出清晰提示；重连成功后能恢复最新状态。
- 推送速率合理：默认不超过 10 事件/秒（可调），长时间运行无明显内存泄漏。

## 非功能需求
- 性能：事件聚合与节流；支持面板级增量更新，避免推送整页数据。
- 稳定性：连接心跳与错误处理；结束玩法后清理监听并停止推送。
- 可扩展性：面板类型可扩充；支持 `metric`、`chart` 等扩展事件；Schema 前向兼容。
- 安全性：事件内容进行序列化与长度限制；动作接口校验 `action` 白名单与参数类型。

## 风险与开放问题
- 大量设备变化与高频事件：需在后端做聚合与节流策略，防止前端卡顿。
- 断点续推（`Last-Event-ID`）：如需强一致渲染，需实现事件 `id` 与持久化队列（可后续迭代）。
- UI Schema 与玩法定义耦合：需保持最小必要接口，避免过度绑定具体设备模型。

## 示例
- UI Schema 示例
```json
{
  "id": "demo-game-1",
  "title": "示例联动游戏",
  "panels": [
    { "type": "status", "title": "Door", "device": "door-1", "fields": ["state"] },
    { "type": "status", "title": "Lamp", "device": "lamp-1", "fields": ["on", "brightness"] },
    { "type": "button", "label": "复位", "action": "resetAll" }
  ]
}
```
- SSE 事件示例
```
event: hello
data: {"schema": {"id":"demo-game-1","title":"示例联动游戏","panels":[{"type":"status","title":"Lamp","device":"lamp-1","fields":["on","brightness"]}]}, "snapshot": {"lamp-1": {"on": false, "brightness": 50}}}



event: ui
data: {"panels":[{"id":"lamp-1","fields":{"on":true}}]}


event: log
data: {"level":"info","message":"resetAll executed"}
```
- 动作请求示例
```http
POST /api/games/demo-game-1/actions
Content-Type: application/json

{ "action": "resetAll" }
```

---

实现建议（第一阶段）
- 后端：在 `backend/routes/games.js` 增加 `GET /api/games/:id/stream`，从 `gameplayService` 与 `deviceService` 聚合事件推送；在 `start` 成功后缓存最新 Schema 与快照，用于 `hello`。
- 前端：新增 `<GameRuntime />` 容器与基础面板组件；封装 `useSSE(url)` 钩子管理连接、事件分发与重连提示。