# 后端 API 文档（汇总版）

本项目后端提供基于 Express 的 REST/SSE 接口，统一前缀为 `/api`。服务端口由环境变量 `PORT` 指定，默认 `3000`。生产环境运行于 Linux。

全局约定
- 所有 JSON 请求使用 `Content-Type: application/json`
- 成功返回通常为对象或数组；SSE 接口为 `text/event-stream`
- 已启用 CORS 与 `express.json()` 解析
- 健康检查：  
  - GET `/api/hello` → `{ "message": "Hello from backend!" }`  
  - GET `/api` → `Backend is running`

SSE 使用说明
- 客户端需保持长连接，按行解析 `event:` 与 `data:` 字段
- 断开会自动释放服务端资源；部分流式接口会在断开时恢复设备上报频率

目录
- MQTT 服务控制（/api/mqtt）
- MQTT 客户端发布（/api/mqtt-client）
- 网络信息（/api/network）
- mDNS 管理（/api/mdns）
- 设备管理与监控（/api/devices）
- 设备类型与接口（/api/device-types, /api/device-interfaces）
- 游戏资源与运行（/api/games，含运行期流）
- 日志系统（/api/logs）
- 测试平台（/api/test）

---

MQTT 服务控制（/api/mqtt）  
实现参考： [mqtt.js](file:///e:/develop/control-panel/backend/routes/mqtt.js)
- POST `/api/mqtt/start`  
  Body: `{ port?: number, bind?: string, configPath?: string }`  
  启动本地 MQTT 服务
- GET `/api/mqtt/status`  
  返回当前服务状态
- POST `/api/mqtt/stop`  
  停止本地 MQTT 服务

MQTT 客户端发布（/api/mqtt-client）  
实现参考： [mqttClient.js](file:///e:/develop/control-panel/backend/routes/mqttClient.js)
- GET `/api/mqtt-client/status`  
  返回客户端状态
- POST `/api/mqtt-client/publish`  
  Body: `{ topic: string, message: any }`  
  发布消息到指定主题

网络信息（/api/network）  
实现参考： [network.js](file:///e:/develop/control-panel/backend/routes/network.js)
- GET `/api/network/ips`  
  返回本机 IPv4 列表

mDNS 管理（/api/mdns）  
实现参考： [mdns.js](file:///e:/develop-control-panel/backend/routes/mdns.js)
- POST `/api/mdns/publish`  
  发布 mDNS 服务
- POST `/api/mdns/unpublish`  
  撤销发布
- GET `/api/mdns/status`  
  查询状态

设备管理与监控（/api/devices）  
实现参考： [devices.js](file:///e:/develop/control-panel/backend/routes/devices.js)
- GET `/api/devices/`  
  列表设备（已适配前端所需字段）
- DELETE `/api/devices/all`  
  清空所有设备
- GET `/api/devices/:id`  
  获取设备详情（不存在返回 404）
- PATCH `/api/devices/:id`  
  更新设备元数据（例如名称）；同时通知设备侧生效
- DELETE `/api/devices/:id`  
  删除设备
- POST `/api/devices/:id/operations/:operationKey`  
  执行设备操作  
  Body: `{ params?: object }`
- GET `/api/devices/:id/monitor-data`  
  获取最新监控快照
- GET `/api/devices/:id/monitor-stream`（SSE）  
  持续推送监控更新。进入流式模式时将设备 `report_delay_ms` 调整为 250ms，断开后恢复为 5000ms

设备类型与接口  
实现参考： [deviceTypes.js](file:///e:/develop/control-panel/backend/routes/deviceTypes.js)、[deviceInterfaces.js](file:///e:/develop/control-panel/backend/routes/deviceInterfaces.js)
- GET `/api/device-types/`  
  返回设备类型映射
- GET `/api/device-types/configs`  
  返回所有类型配置
- GET `/api/device-types/:type/config`  
  返回指定类型配置（不存在返回 404）
- GET `/api/device-interfaces/`  
  返回 `{ interfaces, interfaceConfig, typeInterfaceMap }`

游戏资源与运行（/api/games）  
实现参考： [games.js](file:///e:/develop/control-panel/backend/routes/games.js)、[gameplay.js](file:///e:/develop/control-panel/backend/routes/gameplay.js)
- GET `/api/games/`  
  列表所有可用玩法
- GET `/api/games/:id`  
  获取玩法详情（不存在返回 404）
- GET `/api/games/:id/meta`  
  获取玩法元信息（所需设备、参数等）
- GET `/api/games/:id/config`  
  获取该玩法当前保存的参数
- POST `/api/games/:id/start`  
  启动玩法并保存参数  
  Body: `{ deviceMapping?: object, parameters?: object }`  
  返回：`{ ok, result, status }`
- POST `/api/games/upload`（multipart/form-data）  
  字段 `file`（.js 文件），上传自定义玩法
- DELETE `/api/games/:id?removeFile=1|true|yes`  
  删除玩法，`removeFile` 可选控制是否删除文件
- POST `/api/games/reload`  
  重新扫描玩法目录
- POST `/api/games/stop-current`  
  停止当前玩法
- GET `/api/games/status`  
  返回当前玩法状态

运行期流与动作（共用 `/api/games` 前缀）  
实现参考： [gameplay.js](file:///e:/develop/control-panel/backend/routes/gameplay.js)
- GET `/api/games/current/stream`（SSE）  
  当前运行玩法的事件流（`hello/state/ui/log/ping`）
- GET `/api/games/:id/stream`（SSE）  
  订阅指定玩法的事件流（仅当其为当前运行时）
- GET `/api/games/current/html`  
  返回嵌入式页面 HTML 片段
- POST `/api/games/current/actions`  
  发送运行期动作  
  Body: `{ action: string, payload?: any }`  
  返回：`{ ok: true, result? }`

日志系统（/api/logs）  
实现参考： [logs.js](file:///e:/develop/control-panel/backend/routes/logs.js)
- GET `/api/logs/current`（SSE）  
  实时日志流（逐条以 data: 推送）
- GET `/api/logs/files`  
  返回可下载日志文件列表
- GET `/api/logs/download/:filename`  
  下载日志文件（仅允许 `.log` 后缀）

测试平台（/api/test）  
实现参考： [test.js](file:///e:/develop/control-panel/backend/routes/test.js)
- POST `/api/test/start`  
  启动测试
- POST `/api/test/stop`  
  停止测试
- POST `/api/test/device/:id/start`  
  启动指定设备的测试
- GET `/api/test/stream`（SSE）  
  测试流

示例
- 启动玩法
  ```
  POST /api/games/game-1/start
  Content-Type: application/json

  {
    "deviceMapping": { "p1": "deviceA" },
    "parameters": { "speed": 2 }
  }
  ```
  响应示例：
  ```
  { "ok": true, "result": { /* 由玩法返回 */ }, "status": { /* 当前状态 */ } }
  ```

- 执行设备操作
  ```
  POST /api/devices/abc/operations/reboot
  Content-Type: application/json

  { "params": {} }
  ```

备注
- 多处接口使用 SSE，请在客户端正确处理断线重连与解析
- 未特别说明的错误以标准 HTTP 状态码表示（404/400/500 等）

