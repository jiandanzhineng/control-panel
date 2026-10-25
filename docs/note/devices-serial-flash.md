# 串口与固件烧录

- 串口端口枚举/打开/握手/收发/关闭由后端设备层统一持有，页面只走 REST；Electron 主进程内加载同一后端，不加 Renderer IPC。
- 握手：`@DEBUG START` → `@DEBUG READY {"device_id":"aabbccddeeff","firmware_version":"v1.1.38"}`。`device_id` 是 MQTT topic 用的 12 位小写基础 MAC；`firmware_version` 取自 `esp_ota_get_app_description()->version`（含前导 `v`）。只返回 `@DEBUG READY` 的旧串口固件必须拒绝并释放端口，不回退 COM 兼容身份。
- 每台物理设备可同时有 MQTT/串口/BLE 多条连接，列表只呈现一台，任一时刻只有一个控制连接下发命令；自动发现不抢占，用户明确切换，断开后回退。上行业务消息各连接都进设备层，不做跨连接去重。
- 设备 ID 统一用 eFuse 基础 MAC（12 位小写无分隔符），BLE 真实地址只是连接信息。BLE `0xFF04 Identity` 返回同样的 `device_id` + `firmware_version`；特征不存在才回退 `ble:${Chromium device.id}`，存在但 JSON/字段非法则拒绝连接。
- 插线烧录按 Flash Tool/esptool 自动复位：同一句柄上复位并立即同步，打开串口不得把 DTR/RTS 拉回运行态。固件更新优先级最高，会停止并释放其他流程的端口占用。
- 真机验证（2026-09-04）：`COM17` 的 `RT01` 先建普通业务连接，再发起 merged 烧录；烧录自动关闭原句柄、移除业务会话并加固件锁，100% 后释放锁，设备以同一 ID 和 `v1.1.40` 重连成功。
