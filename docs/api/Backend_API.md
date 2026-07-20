# 后端 API 文档（当前实现）

本文件是后端接口的权威说明，依据 `backend/index.js` 和 `backend/routes/*` 整理。

## 全局约定

- API 统一前缀：`/api`。
- 独立后端默认端口：`3000`，可由 `PORT` 覆盖。
- Electron 内置后端端口：`5278`。
- JSON 请求使用 `Content-Type: application/json`。
- 带浏览器 `Origin` 的 `/api/*` 请求只允许受信任的面板前端来源；普通网页直接访问本机控制接口会返回 `BROWSER_API_FORBIDDEN`（403）。本机原生请求（无 `Origin`）不受影响。
- 大部分路由错误格式为：
  ```json
  { "error": { "code": "SOME_ERROR_CODE", "message": "错误描述" } }
  ```
- SSE 接口使用 `text/event-stream`。

健康检查：

- `GET /api` -> `Backend is running`
- `GET /api/hello` -> `{ "message": "Hello from Express backend!" }`

## MQTT Broker

实现：[mqtt.js](../../backend/routes/mqtt.js)、[mqttService.js](../../backend/services/mqttService.js)

Windows 平台优先启动 EMQX；其他平台使用 mosquitto。Windows 下 EMQX 启动失败时会回退到 mosquitto 逻辑。

- `POST /api/mqtt/start`
  - Body: `{ port?: number, bind?: string, configPath?: string }`
  - 默认：`port=1883`，`bind=0.0.0.0`
  - 返回示例：`{ "running": true, "broker": "emqx", "port": 1883, "status": { ... } }`
- `GET /api/mqtt/status`
  - 返回当前 broker 状态。
- `POST /api/mqtt/stop`
  - 停止当前 broker。

## MQTT 客户端

实现：[mqttClient.js](../../backend/routes/mqttClient.js)、[mqttClientService.js](../../backend/services/mqttClientService.js)

服务启动时会初始化单例 MQTT 客户端，默认连接 `MQTT_CLIENT_URL` 或 `mqtt://127.0.0.1:1883`。连接成功后默认订阅 `#`，并每 60 秒向 `/all` 发布心跳。

- `GET /api/mqtt-client/status`
  - 返回 `{ url, clientId, connected, connecting, subscriptions, handlerCount, lastError }`。
- `POST /api/mqtt-client/publish`
  - Body: `{ topic: string, message: any }`
  - 缺少 `topic` 或 `message` 返回 400。
  - 成功返回 `{ "ok": true }`。

## 网络信息

实现：[network.js](../../backend/routes/network.js)

- `GET /api/network/ips`
  - 使用 `os.networkInterfaces()` 返回非内网 IPv4。
  - 返回示例：`[{ "interface": "WLAN", "ip": "192.168.1.10", "cidr": 24 }]`
  - 没有可用 IPv4 时返回 `IFCONFIG_NOT_AVAILABLE`。错误码沿用旧命名，实际实现不依赖 `ifconfig`。

## mDNS

实现：[mdns.js](../../backend/routes/mdns.js)、[mdnsService.js](../../backend/services/mdnsService.js)

- `POST /api/mdns/publish`
  - 请求体未被使用。
  - 使用 Node.js 原生 UDP socket 在物理局域网网卡上发布 `A easysmart.local`。
  - 自动排除 Hyper-V、WSL、VPN、蓝牙和常见虚拟网卡地址。
  - 可通过 `MDNS_INTERFACE` 或 `MDNS_IPV4` 环境变量指定物理网卡。
  - 返回示例：`{ "pid": 1234, "running": true, "ip": "192.168.5.39", "interface": "Ethernet", "queries": 0, "responses": 0, "lastError": null }`
- `POST /api/mdns/unpublish`
  - 发送 TTL 0 的 goodbye A 记录并关闭 UDP socket。
  - 返回 `{ "running": false }`
- `GET /api/mdns/status`
  - 返回发布状态、所选 IP/网卡和查询/响应计数。

## 设备管理

实现：[devices.js](../../backend/routes/devices.js)、[deviceService.js](../../backend/services/deviceService.js)

设备对象返回格式：

```json
{
  "id": "device-id",
  "name": "设备名称",
  "nickname": "可选昵称",
  "type": "PJ01",
  "connected": true,
  "lastReport": "2026-05-14T08:00:00.000Z",
  "data": {}
}
```

- `GET /api/devices`
  - 返回设备列表。
- `DELETE /api/devices/all`
  - 清空设备列表，返回 `{ "ok": true }`。
- `GET /api/devices/:id`
  - 返回设备详情；不存在返回 `DEVICE_NOT_FOUND`。
- `PATCH /api/devices/:id`
  - Body: `{ name?: string }`
  - 更新设备名称，并向 `/drecv/{id}` 发布 `{ method: "update", ...patch }`。
- `POST /api/devices/:id/nickname`
  - Body: `{ nickname: string }`
  - 设置本地昵称，返回设备对象。
- `DELETE /api/devices/:id`
  - 删除设备，返回 `{ "ok": true }`。
- `POST /api/devices/:id/operations/:operationKey`
  - Body: `{ params?: object }`
  - 根据设备类型注册表执行操作，并通过 MQTT 下发。
  - 成功返回 `{ "success": true, "message": "操作执行成功" }`。
- `POST /api/devices/:id/capabilities/:capability/actions/:action`
  - Body: `{ input?: object, params?: object }`，也兼容直接传裸对象。
  - 直接调用能力动作，适合 `strength.set`、`shock.start`、`reporting.setReportDelay`、`distance.configure` 这类可调参数动作。
  - 成功返回 `{ "success": true, "ok": true }`。
  - 设备不存在返回 `DEVICE_NOT_FOUND`（404）；能力或动作不受该设备支持时返回 400。

## 设备监控

- `GET /api/devices/:id/monitor-data`
  - 返回 `{ deviceId, type, data, timestamp }`。
  - `data` 只包含该设备类型配置中声明的监控字段。
- `GET /api/devices/:id/monitor-stream`
  - SSE。
  - 设备不存在返回 `DEVICE_NOT_FOUND`。
  - 设备类型没有监控字段返回 `DEVICE_NO_MONITOR_DATA`。
  - 事件：
    - `history`：连接建立时的当前快照。
    - `update`：设备监控字段变化后的快照。
  - 建立连接时向设备下发 `report_delay_ms=250`；断开时恢复为 `5000`。

## 固件 OTA

实现：[firmwareOtaService.js](../../backend/services/firmwareOtaService.js)

固件清单地址由 `FIRMWARE_BASE_URL` 决定，默认 `http://firmware.undersilicon.cn`，实际请求 `${base}/firmware/latest/version.json`，并追加随机 query 防缓存。只匹配 `kind=app` 的固件。

- `GET /api/devices/:id/firmware/latest`
  - 返回 `{ supported, currentVersion, latestVersion, updateAvailable, manifestGeneratedAt, commit, firmware }`。
- `POST /api/devices/:id/firmware/update-latest`
  - Body: `{ force?: boolean }`
  - 设备必须在线，且设备类型必须有可用 app 固件。
  - MQTT 下发：`/drecv/{id}`，payload `{ method: "ota_update", url }`。
- `GET /api/devices/:id/firmware/status`
  - 返回最近一次 OTA 状态。无任务时返回 `idle`。
- `GET /api/devices/:id/firmware/status-stream`
  - SSE，事件名 `status`。
- `GET /api/devices/firmware/batch?scope=online|all`
  - 批量查询固件信息。默认 `online`。
- `POST /api/devices/firmware/batch/update-latest`
  - Body: `{ deviceIds: string[], force?: boolean }`
  - 单台失败不会中断其它设备。
- `POST /api/devices/firmware/batch/blink-latest`
  - 对在线且已是最新 app 固件的设备下发 `{ method: "action", action: "blink" }`。
- `GET /api/devices/firmware/batch/status-stream?ids=id1,id2`
  - 批量订阅 OTA 状态，事件名 `status`。

OTA 状态值包括：`idle`、`requested`、`start`、`downloading`、`success`、`failed`、`unknown`。

## 设备类型与能力

实现：[deviceTypes.js](../../backend/routes/deviceTypes.js)、[deviceCapabilities.js](../../backend/routes/deviceCapabilities.js)

- `GET /api/device-types`
  - 返回设备类型到显示名的映射。
- `GET /api/device-types/configs`
  - 返回全部设备类型配置。
- `GET /api/device-types/:type/config`
  - 返回指定设备类型配置。未知类型会返回一个无能力的基础配置。
- `GET /api/device-capabilities`
  - 返回 `{ capabilities, capabilityConfig, typeCapabilityMap }`。

## 游戏资源

实现：[games.js](../../backend/routes/games.js)、[gameService.js](../../backend/services/gameService.js)

- `GET /api/games`
  - 返回持久化的游戏列表。
- `GET /api/games/status`
  - 返回当前玩法运行状态。
  - 注意：该路由必须在 `/:id` 前匹配，当前代码已处理。
- `GET /api/games/:id`
  - 返回单个游戏条目。
- `GET /api/games/:id/meta`
  - 从玩法 JS 文件加载元信息：`title`、`description`、`requiredDevices`、`parameterSchema` 或 `parameter`。
- `GET /api/games/:id/config`
  - 返回已保存参数，未保存时返回 `null`。
- `POST /api/games/:id/start`
  - Body: `{ deviceMapping?: object, parameters?: object }`
  - 启动玩法，保存参数，并更新 `lastPlayed`。
  - 已有玩法运行时返回 409，错误码 `GAME_ALREADY_RUNNING`。
- `POST /api/games/upload`
  - `multipart/form-data`，字段 `file`，仅支持 `.js`。
  - 保存到 `backend/game/` 根目录。
- `DELETE /api/games/:id?removeFile=1|true|yes`
  - 删除游戏条目；带 `removeFile` 时尝试删除物理文件。
- `POST /api/games/reload`
  - 递归扫描 `backend/game/**/*.js`，生成稳定 ID，并覆盖写入游戏列表。
- `POST /api/games/stop-current`
  - 停止当前玩法，返回 `{ ok, result, status }`。

当前前端会调用 `POST /api/games/:id/config/reset` 恢复默认参数，但后端尚未实现该路由。

## 游戏运行时

实现：[gameplay.js](../../backend/routes/gameplay.js)、[gameplayService.js](../../backend/services/gameplayService.js)

- `GET /api/games/current/stream`
  - 当前运行玩法 SSE。无运行玩法返回 `NO_GAME_RUNNING`。
  - 事件名：`hello`、`state`、`ui`、`log`、`ping`。
- `GET /api/games/:id/stream`
  - 订阅指定玩法 SSE。若不是当前运行玩法，返回 `GAME_NOT_CURRENT`。
- `GET /api/games/current/html`
  - 返回当前玩法的 HTML 字符串。玩法可提供 `getHtml()` 或 `html`。
- `POST /api/games/current/actions`
  - Body: `{ action: string, payload?: any }`
  - 调用玩法的 `onAction(action, payload, deviceManager)`。

## 日志

实现：[logs.js](../../backend/routes/logs.js)、[logService.js](../../backend/services/logService.js)

- `GET /api/logs/current`
  - SSE。每条日志使用默认 `message` 事件，格式：
    ```json
    { "timestamp": "ISO", "level": "INFO", "module": "Mqtt", "message": "..." }
    ```
- `GET /api/logs/files`
  - 返回 `{ files: [{ filename, size, date, lastModified }] }`。
- `GET /api/logs/download/:filename`
  - 仅允许下载 `.log` 文件。
  - 注意：日志路由的错误返回是 `{ "error": "..." }` 字符串，不走 `sendError` 的 `{ error: { code, message } }` 结构。

## 自动化测试

实现：[test.js](../../backend/routes/test.js)、[testService.js](../../backend/services/testService.js)

- `POST /api/test/start`
  - 开启测试平台，对当前在线设备按设备能力的 `test` 计划启动测试，并每秒检查新上线设备。
- `POST /api/test/stop`
  - 停止测试平台，并对设备下发 stop 配置。
- `POST /api/test/device/:id/start`
  - 对单个设备重新下发开始测试。
- `GET /api/test/stream`
  - SSE。连接后先发送 `{ type: "connected" }`；设备监控字段变化时发送 `{ type: "update", deviceId, data }`。
