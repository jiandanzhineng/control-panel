# MQTT、串口与 BLE 统一设备连接实施计划

## 1. 合入 BLE worktree，但保留当前主线行为

1. 将 `codex/ble-transport` 的 `5aeca84` 合入当前 `develop`，人工处理 `deviceService.js`、`electron/main.js`、`testService.js` 等冲突。
2. 保留 BLE worktree 已验证的 Web Bluetooth 选择流程、GATT 编解码、串行写队列、安全断开和测试结构。
3. 保留 `develop` 新增的 external device watchdog、统一后端 shutdown 和 Electron quit coordinator；关闭顺序必须是“watchdog 通过控制连接复位设备 -> 断开 BLE/串口 -> 关闭服务”。
4. 不保留 `ble:${browserDeviceId}` 作为新版 BLE 的主身份，也不保留单值 `connectionType` 或按设备 ID 只存一个 runtime transport 的模型。

## 2. hardware 输出统一身份

1. 新增 `components/base_device/device_identity.c` 和 `include/device_identity.h`，集中生成 `device_id + firmware_version` JSON：

   ```json
   {"device_id":"aabbccddeeff","firmware_version":"v1.1.38"}
   ```

2. `device_id` 通过 `esp_efuse_mac_get_default()` 生成 12 位小写、无分隔符基础 MAC；`firmware_version` 原样读取 `esp_ota_get_app_description()->version`，保留前导 `v`。使用 cJSON 生成载荷，串口与 BLE 不各自拼 JSON。
3. 修改 `components/base_device/device_serial_debug.c`：每次收到 `@DEBUG START` 都返回完整的 `@DEBUG READY <identity-json>`；ACTIVE 状态也重新返回身份和属性快照；不返回 `protocol_version`。
4. 修改 `components/device_ble_service/device_ble_service.c`：增加固定只读 `0xFF04 Identity` 特征，在切换 BLE mode 前即可读取，值与串口 READY 内的 JSON 完全相同。
5. 修改 `components/base_device/include/base_device.h`：固定 GATT attribute 数从 8 调整为 10，并继续用编译期断言检查 `CONFIG_BT_GATT_MAX_SR_ATTRIBUTES=120`。
6. 修改两个组件的 `CMakeLists.txt` 依赖/源文件列表，并更新 `docs/plan/串口调试接口Design.md`。

## 3. 建立运行期设备连接注册表

1. 新增 `backend/services/deviceConnectionService.js`，以 `(deviceId, transport)` 管理 MQTT、serial、BLE 连接；连接记录包含 `send()`、连接时间、最后活动时间、固件版本和传输元数据。
2. 每个物理设备只有一个 `controlConnection`。首条可用连接成为控制连接；之后自动出现的连接不抢占；用户可显式切换；当前控制连接断开时选择仍在线时间最长的连接回退。
3. 同一条命令只交给当前控制连接。发送报错后不把同一条命令自动改投另一连接，避免“实际已执行但 ACK 丢失”造成重复动作；回退只影响下一条命令。
4. 各连接的上行消息全部进入设备层，不做跨连接去重；连接注册表只限制下行路由。
5. `backend/services/deviceService.js` 保留物理设备、属性和事件处理职责，移除单值 `connectionType` 假设；API 设备对象增加：

   ```json
   {
     "controlConnection":"serial",
     "connections":[
       {"type":"mqtt","connected":true},
       {"type":"serial","connected":true,"firmwareVersion":"v1.1.38","portPath":"COM5"}
     ]
   }
   ```

6. MQTT 上报通过统一的 `handleTransportMessage(..., "mqtt")` 入口处理，并刷新 MQTT 连接的独立存活时间；60 秒未上报只移除 MQTT 连接，不把仍有串口/BLE 的物理设备标为离线。
7. `devicePublishFn`、通用消息、能力调用、自动化测试、Bridge、OTA 和 watchdog 全部通过连接注册表下发，清除剩余的直接 `mqttClient.publish()` 业务路径。
8. 旧持久化设备记录读取时忽略 `connected`、`connectionType` 等运行期字段；昵称、类型、属性和映射继续按物理设备 ID 保存。

## 4. 增加后端串口管理

1. 在 `backend/package.json` 和 `backend/package-lock.json` 增加 `serialport`，确认其 N-API native binding 可在 Node 后端、Electron 39 和打包产物中加载。
2. 新增 `backend/transports/serialProtocol.js`：按行解析日志、`@DEBUG READY` 和 `@MSG`，严格校验新版身份；仅有 `@DEBUG READY` 的旧串口固件直接拒绝，不使用 COM 号回退。
3. 新增 `backend/services/serialConnectionService.js`：持有端口枚举、打开、握手、读写、关闭、热插拔轮询和端口互斥，Renderer 不直接接触 `SerialPort`。
4. 探测参数固定为 115200/8N1、每 500ms 发送 `@DEBUG START`、总等待 3 秒。合法设备保留；非设备立即关闭；失败端口按 5/10/20/40/60 秒递增退避，拔出后清除退避。
5. 自动连接默认关闭；设置存入 `fileStorage` 的 `serial-connection-settings`，开启后每秒枚举新端口并持续监听热插拔，应用重启后恢复。
6. 手动连接绕过自动探测退避，但仍执行相同身份校验；同一路径不能被手动和自动流程重复打开，同一设备的重复 serial 连接关闭后到者。
7. 串口下行统一编码为 `@CMD <json>\r\n` 并排队写入；上行只解析完整的 `@MSG <json>`，普通日志、半行、超长行、非法 JSON 不进入设备层。
8. 端口 error/close、设备拔出、删除设备和应用退出都注销连接并释放句柄；watchdog 完成设备复位后再关闭端口。

## 5. 增加串口 REST 接口

1. 新增 `backend/routes/serialConnections.js` 并在 `backend/index.js` 注册 `/api/serial`：
2. `GET /api/serial/ports`：返回端口及 `idle/probing/connected/backoff` 状态。
3. `POST /api/serial/connections`：接收 `{ path }`，执行手动连接并返回物理设备。
4. `DELETE /api/serial/connections/:deviceId`：断开该设备的串口连接。
5. `GET /api/serial/settings`、`PUT /api/serial/settings`：读取或修改 `{ autoConnect }`，修改后立即启动或停止监听。
6. 在 `backend/routes/devices.js` 增加 `PUT /:id/control-connection`，接收 `{ type: "mqtt" | "serial" | "ble" }`；目标连接不在线时返回 409。

## 6. 改造 BLE 身份和 IPC

1. `electron/ble/protocol.js` 增加 `0xFF04` UUID 和统一身份解析；`electron/ble/deviceClient.js` 连接后先读取 Identity，再进入 mode、发现属性和订阅通知。
2. Identity 合法时使用基础 MAC `device_id`；特征明确不存在时回退到 `ble:${Chromium device.id}` 并标记 `legacyIdentity: true`；特征存在但不可读、JSON 非法或字段非法时拒绝连接。
3. `electron/ble/mainIntegration.js` 和 `electron/preload.js` 以物理设备 ID 传递事件和命令，向后端连接注册表登记 BLE adapter；保留浏览器设备 ID 仅作为 BLE runtime handle，不作为新版物理设备身份。
4. 调整 Electron 关闭流程，使 watchdog 能在 Renderer/GATT 仍存活时通过当前控制连接发送 stop；随后等待 BLE 安全断开，最后关闭后端和窗口。
5. `frontend/src/env.d.ts` 更新 BLE metadata、连接列表和错误码类型。

## 7. 更新设备页面

1. 修改 `frontend/src/views/DevicesView.vue`，保留“连接 BLE”，新增“连接串口”按钮和端口选择对话框；手动连接期间显示探测状态和明确错误。
2. 增加“串口自动连接”开关，初次为关闭；开关只表示是否持续发现，不表示当前是否已有串口连接。
3. 设备列表继续一行一台物理设备；展示 MQTT/串口/BLE 连接状态、固件版本、串口路径和旧版 BLE 身份标记。
4. 每台设备用单选/菜单明确选择控制连接；当前控制连接突出显示，其他连接可单独断开，自动连接不得改变当前选择。
5. 所有编辑、操作、玩法和测试入口仍只传物理设备 ID，不让前端业务代码判断 MQTT/串口/BLE。

## 8. 接入自动化测试与固件升级

1. 修改 `backend/services/testService.js`，测试步骤统一调用 `deviceService.devicePublishFn()`；串口自动发现的设备进入现有 `connectedDevices()` 后自动开始测试，无需测试平台新增分支。
2. 保留 BLE worktree 的测试平台路由改造，并补测 MQTT、串口、BLE 控制连接切换。
3. 修改 `backend/services/firmwareOtaService.js`：当前控制连接为 BLE 时阻止网络 OTA；MQTT 或串口控制时沿用现有 OTA 命令，最终成败仍以设备 `ota_status` 为准。
4. watchdog、玩法退出复位和应用退出复位都走当前控制连接，不向多连接广播。

## 9. 测试清单

1. hardware：构建当前设备配置，校验 GATT attribute 上限；串口重复 START 均返回完整身份；BLE `0xFF04` 与 MQTT topic 的 ID 一致；版本保留前导 `v`。
2. 串口单元测试：日志夹杂、分包/粘包、半行、超长行、非法 JSON、旧 READY 拒绝、新 READY 接受、3 秒超时、退避、热插拔、重复打开和安全清理。
3. 连接模型测试：同设备三连接合并、自动连接不抢占、显式切换、断线回退、命令只发一次、上行不去重、MQTT 超时不影响 serial/BLE 在线。
4. BLE 测试：新版 Identity、缺失特征回退、损坏 Identity 拒绝、写队列、属性通知、消息通知、断开和 Renderer 销毁。
5. 集成回归：`deviceMessageRoute`、`testService`、Bridge、firmware OTA、device watchdog、backend startup 和 Electron shutdown 测试全部通过。
6. 前端：TypeScript/Vite build；桌面和窄屏检查按钮、开关、连接状态和控制连接选择无溢出。
7. 打包冒烟：Windows 安装目录中加载 `serialport` native binding，手动连接、自动热插拔、BLE 连接和退出复位各跑一次。

## 10. 提交顺序

1. hardware 仓库：提交身份公共模块、串口 READY、BLE Identity、GATT 容量修正和协议文档。
2. control-panel 仓库：先合入 `codex/ble-transport`，再提交统一连接模型、串口后端/REST、BLE 身份改造、UI 与测试。
3. 文档提交只包含本方案新增的 `CONTEXT.md`、ADR 0006-0011 和本计划；不包含工作区原有的其他未跟踪 `docs/plan/*.md`。
