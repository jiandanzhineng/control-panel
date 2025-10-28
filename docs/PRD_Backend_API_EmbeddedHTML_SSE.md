# 后端 PRD — 嵌入式 HTML + SSE（与现有代码对齐）

版本：v1.0  
最近更新：2025-10-28

## 背景与目标
- 依据《PRD_EmbeddedHTML_SSE.md》，在当前后端基础上定义运行期接口：启动、停止、状态、SSE 推送、页面获取与动作处理。
- 采用“玩法 JS 内嵌完整 HTML 页面”的模式，前端通过 `/api/games/current/html` 获取页面，再以 SSE 订阅增量状态；本阶段不做安全隔离。

## 范围（Scope）
- 包含：
  - 启动/停止当前玩法（绑定 `backend/services/gameplayService.js`）
  - 运行状态查询
  - SSE 流（事件：`hello/state/ui/log/ping`）
  - 获取玩法内嵌页面（`text/html`）
  - 页面动作转发（`POST actions`）
- 不含：复杂权限、安全隔离、资源沙箱；设备层已由现有 `deviceService`/`mqttClientService` 提供。

## 路由前缀与挂载
- 基础路径：`/api/games`（已在 `backend/index.js` 中挂载）
- 现有路由保持：
  - `GET /api/games`、`GET /api/games/:id`、`POST /api/games/:id/start`、`POST /api/games/stop-current`、`GET /api/games/status`、`POST /api/games/upload`、`DELETE /api/games/:id`、`POST /api/games/reload`
- 新增运行期接口（本 PRD 定义）：
  - `GET /api/games/:id/stream`（订阅指定玩法的 SSE）
  - `GET /api/games/current/stream`（订阅当前运行玩法的 SSE）
  - `GET /api/games/current/html`（返回嵌入式页面 HTML）
  - `POST /api/games/current/actions`（对当前玩法触发动作）

## 响应约定
- 成功：返回业务数据或按 SSE 规范发送事件。
- 失败：使用统一错误结构（`backend/utils/http.sendError`）：
  ```json
  { "error": { "code": "SOME_ERROR_CODE", "message": "描述信息" } }
  ```

## 数据与事件模型
- 玩法导出（最小约定，与 `gameplayService.validateGameplay` 对齐）：
  - 字段：`title: string`、`description: string`、`requiredDevices: Array<{ logicalId, required?, name? }>`
  - 方法：`start(deviceManager, parameters)`、`loop(deviceManager)`；可选：`end(deviceManager)`、`updateParameters(parameters)`。
  - 新增（页面）：`html: string` 或 `getHtml(): string`。
- SSE 事件：
  - `hello`：连接初始化，`{ snapshot }`；在连接建立后 1 秒内发送。
  - `state`：状态增量（键值对）；由玩法逻辑或设备变化触发。
  - `ui`：界面相关增量（可选，如 `{ fields: { k: v } }`）。
  - `log`：结构化运行日志（`{ ts, level, message, extra }`），来自 `deviceManager.log` 与系统事件。
  - `ping`：心跳（可选，默认≤10事件/秒）。

## 详细接口定义

1) 启动玩法
- `POST /api/games/:id/start`
- Body：`{ deviceMapping?: Record<string,string>, parameters?: Record<string,any> }`
- 行为：
  - 读取 `gameService.getGameById(id)`，获取 `configPath`。
  - 调用 `gameplayService.startGameplay(configPath, deviceMapping, parameters)`。
  - 内部验证：
    - 若已有运行中玩法 → 409 + `GAME_ALREADY_RUNNING`（来源：`GAMEPLAY_ALREADY_RUNNING`）。
    - 文件不存在/路径无效 → 404/500 + `GAMEPLAY_FILE_NOT_FOUND`。
    - 玩法导出缺失字段/方法 → 500 + `GAMEPLAY_MISSING_FIELD|METHOD|INVALID_EXPORT`。
    - 必需设备未映射/离线 → 400/500 + `DEVICE_MAPPING_MISSING|DEVICE_OFFLINE`。
    - `start` 执行失败 → 500 + `GAMEPLAY_START_FAILED`。
- 成功响应 `200`：`{ ok: true, result: { title, startTime }, status }`

2) 停止当前玩法
- `POST /api/games/stop-current`
- 行为：调用 `gameplayService.stopGameplay()` 并返回状态。
- 响应 `200`：`{ ok: true, result, status }`
- 错误码：`GAME_STOP_FAILED`

3) 查询运行状态
- `GET /api/games/status`
- 行为：返回 `gameplayService.status()`。
- 响应 `200`：`{ running, title, startTime, loopIntervalMs, gameplaySourcePath }`
- 错误码：`GAME_STATUS_FAILED`

4) 订阅 SSE（当前玩法）
- `GET /api/games/current/stream`
- 头：`Content-Type: text/event-stream`，`Cache-Control: no-cache`，`Connection: keep-alive`
- 行为：
  - 若无运行中玩法 → `sendError(404, 'NO_GAME_RUNNING')` 并结束。
  - 建立 SSE 连接：
    - 立即发送 `hello` 事件，附带 `{ snapshot }`（快照内容由实现决定，至少包含基本运行态与可视状态）。
    - 订阅 `gameplayService.setLogCallback` 将日志转发为 `event: log`。
    - 后续由玩法逻辑触发 `state`/`ui` 增量事件；系统按 10/s 以内节流。
- 断开：客户端关闭或后端停止玩法时结束流。

6) 获取页面 HTML（当前玩法）
- `GET /api/games/current/html`
- 响应：`text/html; charset=utf-8`
- 行为：
  - 若无运行中玩法 → `404 + NO_GAME_RUNNING`。
  - 优先调用玩法的 `getHtml()`；否则读取 `html` 字段；为空则 `500 + GAMEPLAY_HTML_NOT_AVAILABLE`。

7) 页面动作（当前玩法）
- `POST /api/games/current/actions`
- Body：`{ action: string, payload?: any }`
- 行为：
  - 若无运行中玩法 → `404 + NO_GAME_RUNNING`。
  - 将动作交由玩法处理：
    - 约定最低实现：玩法对象可选提供 `onAction(name, payload, deviceManager)`；若未实现则返回 `400 + GAMEPLAY_ACTION_NOT_SUPPORTED`。
    - 若实现：执行并可通过 `deviceManager` 联动设备；如需反馈，写入日志或通过 `state/ui` 推送。
- 成功 `200`：`{ ok: true }`（或 `{ ok: true, result }`）。

## 绑定规范（前端约定，供后端文档参考）
- `data-bind="key"`：将 SSE `{ key: value }` 映射为元素文本。
- `data-show="key"`：布尔显示控制；`true` 显示、`false` 隐藏。
- `data-class="key:className"`：当 key 为真时添加 `className`。
- `data-action="name"`：点击触发 `POST /actions`，可结合 `data-payload`（JSON）。

## 错误码约定
- 启动/停止/状态：`GAME_ALREADY_RUNNING`、`GAMEPLAY_FILE_NOT_FOUND`、`GAMEPLAY_MISSING_FIELD|METHOD|INVALID_EXPORT`、`DEVICE_MAPPING_MISSING`、`DEVICE_OFFLINE`、`GAMEPLAY_START_FAILED`、`GAME_STOP_FAILED`、`GAME_STATUS_FAILED`
- SSE/H TML：`NO_GAME_RUNNING`、`GAMEPLAY_HTML_NOT_AVAILABLE`、`GAME_NOT_CURRENT`
- 动作：`GAMEPLAY_ACTION_NOT_SUPPORTED`

## 性能与稳定性
- SSE 推送节流默认不超过 10 事件/秒；应聚合相邻增量。
- 游戏循环默认 1s；`loop` 超时（>800ms）记录 `warn` 日志。
- 停止玩法必须清理所有定时器与监听器（已由 `endGameplay()` 实现）。

## 验收标准
- 启动后 1 秒内通过 SSE `hello` 发送首屏快照。
- SSE 事件到达后 1 秒内页面绑定正确更新；动作触发后可见日志或状态反馈。
- 长时间运行稳定，事件速率与页面性能可控（默认≤10事件/秒）。

## 实现建议（与现有代码衔接）
- 在 `backend/routes/gameplay.js` 中新增路由：`/current/html`、`/current/stream`、`/current/actions`。
- 在 `backend/services/gameplayService.js` 中：
  - 暴露日志订阅接口 `setLogCallback(cb)`（已存在），SSE 路由使用该回调向客户端发送 `log`。
  - 提供 `getCurrentGameplay()` 或导出 `state` 的只读访问（可在实现时新增），以获取 `html/getHtml`、识别当前玩法与快照。
- 快照数据结构（建议）：`{ running, title, startTime, parameters, deviceMapping }`。



