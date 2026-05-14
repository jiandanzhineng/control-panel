# 游戏与玩法运行时说明

本文是游戏管理、启动配置、嵌入式 HTML 和 SSE 运行时的权威说明，依据当前前后端代码整理。

## 游戏文件与列表

游戏文件放在 `backend/game/`，后端只扫描 `.js` 文件。

`POST /api/games/reload` 会递归扫描 `backend/game/**/*.js`，为每个文件生成游戏条目并覆盖写入 `fileStorage('games')`。游戏 ID 由文件相对路径 MD5 前 12 位生成，格式为 `game_{hash}`。

游戏条目字段：

- `id`
- `name`
- `description`
- `status`
- `arguments`
- `configPath`
- `requiredDevices`
- `version`
- `author`
- `createdAt`
- `lastPlayed`

上传 `.js` 文件时，文件保存到 `backend/game/` 根目录；若已有同 `configPath` 或同 `name` 条目，会更新原条目。

## 玩法模块契约

玩法 JS 会在后端 VM 沙箱中加载。支持导出对象、类或工厂函数；`export default` 会被简单转换为 CommonJS。

必需字段：

- `title`
- `description`
- `requiredDevices`

必需方法：

- `start(deviceManager, parameters)`
- `loop(deviceManager)`

可选字段和方法：

- `parameterSchema`：参数 schema 对象。
- `parameter`：参数数组。
- `end(deviceManager)`：停止时调用。
- `updateParameters(parameters)`：当前服务有方法但暂无 API 调用。
- `getHtml()` 或 `html`：提供当前游戏页面 HTML。
- `onAction(action, payload, deviceManager)`：处理嵌入式页面动作。

`requiredDevices` 每项必须包含：

- `logicalId: string`
- `capabilities: string[]`

可选：

- `name`
- `description`
- `required`

## 启动前配置页

前端页面：[frontend/src/views/GameStartConfigView.vue](../../frontend/src/views/GameStartConfigView.vue)

加载时并发请求：

- `GET /api/games/:id`
- `GET /api/games/:id/meta`
- `GET /api/devices`
- `GET /api/device-capabilities`
- `GET /api/games/:id/config`

页面会：

- 根据 `requiredDevices` 生成设备映射表。
- 根据 `typeCapabilityMap` 过滤在线且满足能力的设备。
- 根据 `parameterSchema` 或 `parameter` 渲染参数表单。
- 校验必需设备、在线状态、能力匹配和参数类型。
- 启动时调用 `POST /api/games/:id/start`。

当前前端还有“恢复默认配置”按钮，会调用 `POST /api/games/:id/config/reset`。后端尚未实现该接口，因此该功能目前不会真正生效。

## 启动与运行

启动接口：

```http
POST /api/games/:id/start
Content-Type: application/json

{
  "deviceMapping": {
    "stim": ["device-a"]
  },
  "parameters": {
    "rounds": 3
  }
}
```

`deviceMapping` 的值可以是字符串或字符串数组；后端内部会统一转为数组。

启动流程：

1. 如果已有玩法运行，返回 409 `GAME_ALREADY_RUNNING`。
2. 解析玩法文件路径并加载玩法。
3. 校验玩法字段、方法和 `requiredDevices`。
4. 应用设备映射。
5. 校验必需设备是否映射、设备是否在线、能力是否满足。
6. 初始化稳定 MQTT 和设备属性监听器。
7. 调用玩法 `start(deviceManager, parameters)`。
8. 启动 1000ms 间隔的 `loop(deviceManager)`。

`loop()` 返回 `false` 或抛出异常时，运行时会结束当前玩法。

## deviceManager

运行时注入给玩法的 `deviceManager` 提供：

- `deviceMap`
- `listenDeviceMessages(logicalId, callback)`
- `listenDeviceProperty(logicalId, property, callback)`
- `invoke(logicalId, actionPath, input)`
- `setStrength(logicalId, value)`
- `setReportDelay(logicalId, ms)`
- `configureDistance(logicalId, options)`
- `startShock(logicalId, options)`
- `stopShock(logicalId)`
- `setLockOpen(logicalId, open)`
- `getDeviceProperty(logicalId, property)`
- `log(level, message, extra)`
- `emitState(delta)`
- `emitUi(delta)`

能力动作格式为 `{capability}.{action}`，例如 `strength.set`、`shock.start`。

## 运行期页面

前端页面：[frontend/src/views/GameCurrentView.vue](../../frontend/src/views/GameCurrentView.vue)

页面进入后调用 `GET /api/games/current/html`。后端会从当前玩法读取：

1. `getHtml()` 返回的字符串。
2. 或 `html` 字符串字段。

前端使用 `DOMParser` 注入 HTML：

- `<style>` 会追加到 `document.head`，并简单把 `body`、`html`、`:root` 选择器替换为 `.embedded-html`。
- body 子节点会复制到 `.embedded-html` 容器。
- `<script>` 会重新创建并追加到 `document.body` 执行。
- 页面离开时会关闭注入脚本创建的 EventSource，并移除注入的 style/script。

## SSE

接口：

- `GET /api/games/current/stream`
- `GET /api/games/:id/stream`

事件：

- `hello`：连接后发送快照 `{ snapshot }`。
- `state`：玩法通过 `deviceManager.emitState(delta)` 发出的状态增量。
- `ui`：玩法通过 `deviceManager.emitUi(delta)` 发出的 UI 增量。
- `log`：玩法日志。
- `ping`：10 秒心跳。

服务端限制：

- 单连接所有事件合计最多 10 个/秒。
- `state` 和 `ui` 增量每 100ms 聚合刷新一次。
- 配额不足时日志和心跳可能被丢弃。

## 页面动作

接口：

```http
POST /api/games/current/actions
Content-Type: application/json

{
  "action": "someAction",
  "payload": {}
}
```

后端会调用当前玩法的：

```js
onAction(action, payload, deviceManager)
```

无运行玩法返回 `NO_GAME_RUNNING`；玩法未实现 `onAction` 返回 `GAMEPLAY_ACTION_NOT_SUPPORTED`。

## 停止

`POST /api/games/stop-current` 会调用 `gameplayService.stopGameplay()`：

- 清理 loop 定时器。
- 调用玩法 `end(deviceManager)`。
- 清空当前玩法、参数、设备映射和运行期监听器。
- 返回 `{ ok: true, result, status }`。
