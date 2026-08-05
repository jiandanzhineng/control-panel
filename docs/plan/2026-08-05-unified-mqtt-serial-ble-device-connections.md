# MQTT、串口与 BLE 统一设备连接实施计划

## 1. 合入 BLE worktree，但保留当前主线行为

1. 以 `codex/ble-transport` 已验证的 Web Bluetooth 选择流程、GATT 编解码、串行写队列和安全断开为基础实现。
2. 合入 `develop` 的 external device watchdog、统一后端 shutdown 和 Electron quit coordinator。
3. 关闭顺序固定为：watchdog 通过控制连接复位设备，断开 BLE/串口，最后关闭服务。
4. 新版 BLE 不使用 `ble:${browserDeviceId}` 作为物理设备主身份。

## 2. Hardware 输出统一身份

1. 新增共享身份模块，统一生成如下 JSON：

   ```json
   {"device_id":"aabbccddeeff","firmware_version":"v1.1.38"}
   ```

2. `device_id` 使用 ESP32 基础 MAC，格式为 12 位小写、无分隔符；固件版本保留前导 `v`。
3. 串口每次收到 `@DEBUG START` 都返回完整 `@DEBUG READY <identity-json>`，ACTIVE 状态也重新返回身份和属性快照。
4. BLE 增加固定只读 `0xFF04 Identity` 特征，内容与串口 READY 完全相同。
5. GATT 固定 attribute 数从 8 调整为 10，并继续使用编译期容量检查。
6. 更新组件 CMake 依赖和串口协议文档。

## 3. 建立运行期设备连接注册表

1. 新增 `deviceConnectionService`，以 `(deviceId, transport)` 管理 MQTT、serial、BLE 连接。
2. 每台物理设备只有一个 `controlConnection`；首条连接取得控制权，新发现的连接不得抢占。
3. 用户可以显式切换控制连接；当前控制连接断开时，回退到仍在线且最早连接的传输。
4. 同一命令只发给当前控制连接；发送失败不改投，避免设备已经执行却因 ACK 丢失而重复动作。
5. 三种连接的上行消息都进入设备层，不做跨连接去重。
6. API 设备对象增加 `controlConnection` 和 `connections[]`，前端业务继续只使用物理设备 ID。
7. MQTT 超时只注销 MQTT，不影响仍有 serial/BLE 的设备在线状态。
8. 昵称、类型、属性和映射继续按物理设备 ID 持久化，运行期连接字段不写入存储。

## 4. 增加后端串口管理

1. 增加 `serialport` 依赖，并验证 Node、Electron 和打包产物可以加载原生 binding。
2. 新增严格按行解析的 `serialProtocol`，只接受新版身份；旧串口 READY 不允许回退。
3. 新增 `serialConnectionService`，由后端统一管理端口枚举、打开、握手、读写、关闭、热插拔和互斥。
4. 探测固定为 115200/8N1，每 500ms 发送 `@DEBUG START`，3 秒超时。
5. 自动连接默认关闭并持久化；开启后每秒枚举新端口，持续监听热插拔。
6. 非设备立即释放端口；失败按 5/10/20/40/60 秒退避，拔出后清除退避。
7. 手动连接绕过退避但执行同样的严格身份校验；同一路径不能重复打开。
8. 同一设备只保留一条 serial 连接，后到端口关闭。
9. 下行编码为 `@CMD <json>\r\n` 并串行写入，上行只处理完整合法的 `@MSG <json>`。
10. 端口错误、拔出、删除设备、关闭自动连接和应用退出都要取消在途探测并释放句柄。

## 5. 增加串口 REST 接口

1. `GET /api/serial/ports`：返回端口和 `idle/probing/connected/backoff` 状态。
2. `POST /api/serial/connections`：手动探测并连接指定端口。
3. `DELETE /api/serial/connections/:deviceId`：断开设备的串口连接。
4. `GET/PUT /api/serial/settings`：读取或修改 `{ autoConnect }`。
5. `PUT /api/devices/:id/control-connection`：显式切换 MQTT、serial 或 BLE 控制连接；目标不在线返回 409。

## 6. 改造 BLE 身份和 IPC

1. BLE 客户端连接后先读取 `0xFF04 Identity`，再切换 mode、发现属性并订阅通知。
2. Identity 合法时使用固件基础 MAC 作为物理设备 ID。
3. 特征明确不存在时允许旧固件回退为 `ble:${Chromium device.id}`，并标记 `legacyIdentity: true`。
4. 特征存在但不可读、JSON 非法或字段非法时拒绝连接，不能回退。
5. Chromium device ID 只作为 BLE 运行期 handle，不作为新版物理设备身份。

## 7. 更新设备页面

1. 保留 BLE 连接，增加手动串口选择和连接。
2. 增加默认关闭的串口自动连接开关；开关只控制持续发现，不代表当前连接状态。
3. 一行只展示一台物理设备，同时展示其 MQTT、串口、BLE 连接。
4. 展示控制连接、固件版本、串口路径和旧 BLE 身份标记。
5. 允许显式选择控制连接，并单独断开 serial 或 BLE。
6. 所有编辑、操作、玩法和测试入口只传物理设备 ID。

## 8. 接入自动化测试与固件升级

1. 自动化测试统一通过 `devicePublishFn` 下发，串口发现的设备直接进入现有测试平台。
2. 测试覆盖 MQTT、serial、BLE 控制连接切换。
3. 当前控制连接为 BLE 时禁止网络 OTA；MQTT 或 serial 控制时通过统一路由下发 OTA。
4. watchdog、玩法退出复位和应用退出复位只走当前控制连接，不向多连接广播。

## 9. 验证清单

1. Hardware 构建当前 ESP32-C3 配置并检查 GATT 容量。
2. 实体串口验证重复 START、统一身份、版本前导 `v`、命令和上报。
3. 串口单测覆盖分包、粘包、半行、日志、超长行、非法 JSON、旧 READY、超时、退避、热插拔、重复打开和安全清理。
4. 连接模型测试覆盖三连接合并、控制权、显式切换、断线回退、只发送一次、上行不去重和 MQTT 独立超时。
5. BLE 测试覆盖新版身份、缺失回退、损坏拒绝、写队列、通知和安全断开。
6. 跑通后端全量 Jest、前端生产构建、Electron shutdown、Windows 打包和串口 binding 冒烟。
7. 在桌面和窄屏检查按钮、开关、连接状态及控制连接选择无溢出。

## 10. 提交顺序

1. Hardware 提交共享身份模块、串口 READY、BLE Identity、GATT 容量修正和协议文档。
2. Control Panel 提交统一连接模型、串口后端与 REST、BLE 身份、UI 和测试。
3. 合入 `develop` 的 watchdog 和 shutdown，解决冲突后跑全量回归。
4. 实体联调通过后提交最后修正并汇总验证结果。
