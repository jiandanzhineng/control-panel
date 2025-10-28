# 自定义游戏功能设计（基于现有前后端框架）

本文档在当前工程（Node.js 后端、Vue/Vite 前端）基础上，设计“用户上传 JS 文件定义游戏”的整体方案，覆盖：前端上传与渲染、后端存储与持续运行、状态推送与刷新、生命周期管理、与现有 MQTT/设备体系的集成点。另：在“嵌入式 HTML + SSE”方案下，本阶段不做安全隔离。

## 1. 目标与范围

- 支持用户在前端上传一个“游戏包”（JS/JSON 组合），后端保存并可启动/停止该游戏。
- 游戏逻辑在后端持续运行：定时调度（如每 3 秒执行）、事件驱动（设备状态变化联动其他设备）。
- 游戏定义前端 UI（设备状态卡片、按钮等），前端根据游戏的 UI Schema 动态渲染；按钮触发动作传递到后端引擎执行。
- 前端显示实时刷新：后端通过推送（SSE 或 WebSocket）将游戏状态/界面数据更新到前端。
- 提供基础的隔离与安全控制，避免用户脚本影响主进程稳定性或越权访问。

## 2. 总体架构

```
┌────────────────────┐          ┌──────────────────────┐
│  前端（Vue/Vite）   │  HTTP    │  后端（Express/Node） │
│  - 上传游戏包       ├─────────►│  - 游戏存储（文件）    │
│  - 动态UI渲染       │         │  - 游戏引擎（沙箱/Worker） │
│  - 订阅推送（SSE/WS）│◄────────┤  - 状态推送（SSE/WS）   │
│  - 按钮触发动作     │  HTTP    │  - 与 MQTT/设备服务集成 │
└────────────────────┘          └──────────────────────┘
```

- 存储：后端持久化游戏包到 `backend/data/games/<gameId>/`（主脚本、UI Schema 或嵌入式 HTML、元数据等）。
- 引擎：每个游戏在独立运行环境（沙箱或 Worker 线程）中执行，暴露受限 API（发布设备命令、订阅设备状态、注册定时器、发送 UI 更新等）。
- 推送：后端为每个游戏维护一个事件流，前端通过 SSE 或 WebSocket 订阅以刷新显示。
- 集成：复用现有 `mqttService`、`networkService` 以及 `utils/logger` 等工具。

## 3. 游戏包与数据存储

- 目录结构（示例）：

```
backend/data/games/<gameId>/
  ├── index.js         # 游戏主入口（模块导出 setup/teardown 等；可内嵌 HTML）
  ├── manifest.json    # 元数据（name、version、描述、权限等）
  ├── ui.json          # 前端 UI Schema（Panels、Widgets、Actions）（若采用 Schema 路线）
  └── assets/          # 可选静态资源（图标等）
```

- 持久化：使用已有 `backend/utils/fileStorage.js`（或新增 `gamesStorage` 包装）读写游戏目录与文件。
- 标识：`gameId` 由后端生成（如 UUID），前端上传后返回该 ID。

## 4. 后端 API 设计

路由前缀建议：`/api/games`

- `POST /api/games`：上传游戏包（支持单文件或 zip）。
  - Body：`multipart/form-data`（`index.js`、`manifest.json`、`ui.json`、`assets`）或 `application/zip`。
  - Resp：`{ id, name, version }`

- `GET /api/games`：列表查询。
  - Resp：`[{ id, name, version, status }]`

- `GET /api/games/:id`：详情（含 manifest、UI schema 概要）。

- `POST /api/games/:id/start`：启动游戏。

- `POST /api/games/:id/stop`：停止游戏并清理资源。

- `POST /api/games/:id/actions`：前端按钮等触发动作。
  - Body：`{ action: string, payload?: any }`

- `GET /api/games/:id/stream`：订阅状态更新（SSE）。
  - 事件类型：`state`（状态快照/增量）、`ui`（界面数据）、`log`（运行日志）、`metric`（资源指标）。
  - 如果使用 WebSocket，则为 `/ws/games/:id`（按消息类型分发）。

- 可选：`GET /api/games/:id/files/*` 暴露静态资源（若需要）。

后端新增：

- `backend/routes/games.js`：实现上述 REST/SSE 路由。
- `backend/services/gameEngine.js`：游戏运行时、生命周期与调度。
- `backend/services/gameSandbox.js`：沙箱执行器（`vm2` 或 `isolated-vm`/`worker_threads`）。
- `backend/stores/gamesStore.js`：游戏列表与状态记录（内存 + 文件持久化）。

## 5. 后端运行时与持续逻辑

### 5.1 运行时 API（提供给游戏脚本）

在沙箱/Worker 中注入受限 API，对应功能由主进程代理到现有服务：

- `publish(deviceId, payload)`：向设备发布命令（封装 `mqttService.publish`）。
- `subscribe(topicOrDevice, handler)`：订阅设备状态或主题（封装 `mqttService.subscribe`，统一到引擎事件总线）。
- `timer.every(ms, name, fn)`：注册周期任务（如每 3 秒执行）。
- `timer.once(ms, name, fn)`：一次性延时任务。
- `state.get(key)` / `state.set(key, value)`：游戏内部状态存取（引擎维护，支持持久化策略）。
- `ui.emit(patch)`：向前端推送 UI 变更（直接发送到 SSE/WS）。
- `ui.onAction(name, handler)`：注册前端动作处理器（由 `POST /actions` 转发）。
- `log.info|warn|error(msg, meta?)`：日志输出（封装 `utils/logger.js`）。

游戏主模块建议导出：

```js
module.exports = {
  id: 'lighting-relay-game',
  name: '灯光联动',
  version: '1.0.0',
  setup(ctx) {
    const { publish, subscribe, timer, state, ui, log } = ctx;

    timer.every(3000, 'checkLamp', () => {
      const temp = state.get('sensor1.temp');
      if (temp > 30) publish('fan-1', { on: true });
    });

    subscribe('door-1.state', (val) => {
      publish('lamp-1', { on: val === 'open' });
      ui.emit({ type: 'status', device: 'lamp-1', fields: { on: val === 'open' } });
    });

    ui.onAction('resetAll', () => {
      publish('lamp-1', { on: false });
      publish('fan-1', { on: false });
    });
  },
  teardown(ctx) {
    // 清理定时器/订阅等
  }
}
```

### 5.2 调度与生命周期

- 状态：`created → starting → running → stopping → stopped → failed`。
- 启动：装载游戏包 → 解析 manifest/ui → 创建沙箱/Worker → 注入 API → 调用 `setup`。
- 运行：定时器管理（集中登记，支持取消）、事件订阅管理（统一解绑）、UI 推送（批量/节流）。
- 停止：调用 `teardown` → 释放所有资源 → 停止推送通道。
- 异常：捕获并记录，自动重启（可配置重试间隔与次数）。

### 5.3 事件总线与 MQTT 集成

- 引擎内部维护事件总线（如基于 `EventEmitter`），从 `mqttService` 订阅设备主题并转为游戏可用事件。
- 主题命名建议：`devices/<deviceId>/state`、`devices/<deviceId>/cmd`（复用现有服务约定）。
- 每个游戏维护自己的订阅集合，停止时统一注销，避免泄漏。

### 5.4 安全与隔离（本阶段不考虑）

- 按“嵌入式 HTML + SSE”方案，本阶段不进行安全隔离（不启用 sandbox/iframe）。
- 玩法内可直接输出完整 HTML 并在页面脚本中建立 SSE 订阅与动作触发。
- 后续如需要再引入 `worker_threads`/`vm2` 等隔离手段与权限模型。

### 5.5 日志与监控

- 使用 `utils/logger.js` 输出游戏级日志，按 `gameId` 打标签。
- 指标：定时器数、事件速率、推送队列长度、错误计数；通过 `/metric` 推送或后台记录。

## 6. 前端设计

### 6.1 上传与管理

- 视图：新增“游戏管理”页面（`/games`），包含列表、上传表单、启动/停止操作。
- 上传：`multipart/form-data`（支持拖拽 zip/文件夹）；上传成功显示 `gameId`。
- 详情：进入 `/games/:id` 渲染该游戏 UI。

### 6.2 动态 UI 渲染

支持两种渲染路线，可并存：

- 路线 A（Schema 驱动）：使用 UI Schema（`ui.json`）按组件库动态渲染。
- 路线 B（嵌入式 HTML）：HTML 放在游戏 JS 内部，通过模块的 `html` 字段或 `getHtml()` 方法提供完整页面，前端通过 `/api/games/:id/html` 获取并直接插入容器；页面脚本自行订阅 `/api/games/:id/stream` 并以轻量绑定（如 `data-bind`、`data-show`、`data-class`、`data-action`）应用增量刷新。

- UI Schema（`ui.json`）建议结构：

```json
{
  "panels": [
    { "type": "status", "title": "Lamp", "device": "lamp-1", "fields": ["on", "brightness"] },
    { "type": "button", "label": "全部复位", "action": "resetAll" }
  ]
}
```

- 组件：`<GameRuntime />` 读取 UI Schema 动态生成组件树（StatusCard、ActionButton 等）。
- 交互：按钮调用 `POST /api/games/:id/actions`，传入 `{ action, payload }`。

### 6.3 刷新机制（SSE/WS）

- 建议默认使用 SSE（实现简单、与现有 HTTP 兼容），事件类型：`hello`、`state`、`ui`、`log`（可含 `ping`）。
- 路线 A（Schema）：前端在 `<GameRuntime />` 挂载时订阅 `/api/games/:id/stream`，收到事件后更新对应面板状态/列表。
- 路线 B（嵌入式 HTML）：页面内部脚本建立 `EventSource('/api/games/:id/stream')`，首屏通过 `/api/games/:id/html` 获取完整页面文本并插入。
- 若需双向实时通道或大量事件，改用 WebSocket。

### 6.4 错误处理与权限

- 当游戏未运行或推送断开时显示降级提示（可重试连接/拉取快照）。
- 前端不直接访问设备，仅通过后端 API 调用，权限由后端校验。

## 7. 与现有工程的集成点

- 后端集成：
  - `backend/services/mqttService.js`：复用 publish/subscribe，与游戏引擎对接。
  - `backend/utils/fileStorage.js`：复用或扩充为 `gamesStorage` 管理游戏文件。
  - `backend/utils/logger.js`：统一日志。
  - 新增：`backend/services/gameEngine.js`、`backend/routes/games.js`、`backend/stores/gamesStore.js`。

- 前端集成：
  - 新增视图：`frontend/src/views/Games.vue`、`frontend/src/components/GameRuntime.vue`。
  - 路由：在 `frontend/src/router` 增加 `games` 路由配置。
  - 请求封装：`frontend/src/services/games.ts`（上传、列表、详情、动作、订阅、`/api/games/:id/html` 获取页面）。

## 8. 示例交互流程

1) 用户在前端上传游戏包 → 后端保存到 `backend/data/games/<id>/`。
2) 用户点击“启动” → 后端启动玩法（根据路线）：
   - 路线 A（Schema）：创建运行环境、解析 `ui.json` 并推送 `hello`（含快照/Schema）。
   - 路线 B（嵌入式 HTML）：同样启动运行；前端请求 `/api/games/:id/html` 获取完整页面后由页面脚本建立 SSE。
3) 游戏每 3 秒执行逻辑、或在设备状态变化时联动其他设备；通过 `ui.emit` 或状态聚合推送增量更新。
4) 前端增量刷新：
   - 路线 A：容器组件根据事件更新面板。
   - 路线 B：页面脚本应用到绑定元素；用户点击按钮 → `POST /actions` → 后端处理。
5) 停止游戏 → 后端清理资源并关闭推送。

## 9. 安全与合规建议

- 本阶段不考虑安全隔离；以下建议供后续迭代参考。
- 对上传内容进行校验：文件结构、manifest 权限、脚本大小与语法。
- 运行时隔离优先选择 Worker（`worker_threads` + 消息桥），必要时再使用 `vm2`。
- 限流与熔断：设备命令发布速率限制、异常重试上限、推送节流。
- 观测性：审计日志（上传、启动、停止、动作）、错误栈、指标。

## 10. 测试与演示建议

- 后端：
  - 单元测试：`gameEngine` 的定时调度、订阅/取消、动作转发、异常处理。
  - 集成测试：上传 → 启动 → 推送 → 动作 → 停止的端到端流程（可参考现有 `tests/` 结构）。

- 前端：
  - 组件测试：`<GameRuntime />` 根据 `ui.json` 渲染、订阅 SSE 并更新状态、动作触发调用。
  - 视图测试：列表页与详情页路由与交互。

## 11. 后续迭代方向

- 可视化编辑器：在前端可视化构建 UI Schema 与逻辑块（Flow/Node-RED 风格）。
- 版本管理与热更新：支持游戏包版本化与热替换运行。
- 权限模型细化：按设备类型/主题的访问控制列表（ACL）。
- 市场/共享：游戏包的导入/导出与共享。

## 12. 附：最小可运行游戏包示例

`manifest.json`

```json
{
  "id": "demo-game-1",
  "name": "示例联动游戏",
  "version": "1.0.0",
  "permissions": { "devices": ["lamp-1", "fan-1", "door-1", "sensor1"] }
}
```

`ui.json`

```json
{
  "panels": [
    { "type": "status", "title": "Door", "device": "door-1", "fields": ["state"] },
    { "type": "status", "title": "Lamp", "device": "lamp-1", "fields": ["on"] },
    { "type": "button", "label": "复位", "action": "resetAll" }
  ]
}
```

`index.js`

```js
module.exports = {
  setup({ publish, subscribe, timer, ui, log, state }) {
    log.info('demo-game-1 start');

    timer.every(3000, 'tick', () => {
      const count = (state.get('tick') || 0) + 1;
      state.set('tick', count);
      ui.emit({ type: 'status', device: 'sensor1', fields: { tick: count } });
    });

    subscribe('door-1.state', (val) => {
      publish('lamp-1', { on: val === 'open' });
      ui.emit({ type: 'status', device: 'lamp-1', fields: { on: val === 'open' } });
    });

    ui.onAction('resetAll', () => {
      publish('lamp-1', { on: false });
      publish('fan-1', { on: false });
    });
  },
  teardown({ log }) {
    log.info('demo-game-1 stop');
  }
};
```

---

实施优先级建议：后端 `games` 路由与 `gameEngine`（含 SSE 推送）为第一阶段；前端 `GameRuntime` 的 UI 动态渲染与动作联通为第二阶段；安全隔离（Worker 化）与权限校验为第三阶段逐步完善。