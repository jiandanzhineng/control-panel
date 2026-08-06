# 串口握手返回统一设备身份

串口设备在每次收到 `@DEBUG START` 后返回 `@DEBUG READY {"device_id":"aabbccddeeff","firmware_version":"v1.1.38"}`；`device_id` 是 MQTT topic 已使用的 12 位小写基础 MAC，`firmware_version` 原样取自 `esp_ota_get_app_description()->version`，包括 `PROJECT_VER` 中的前导 `v`。握手不包含 `protocol_version`：它只负责确认物理设备身份并报告固件版本。控制面板只在收到完整且合法的新版握手后登记物理设备；仅返回 `@DEBUG READY` 的旧串口固件必须被拒绝并释放端口，不得像旧 BLE 固件一样回退到 COM 口生成兼容身份。设备 ID 不在每条 `@MSG` 业务消息中重复携带，从而让 MQTT、串口和新版 BLE 连接共用同一个物理设备身份，同时保持业务 payload 与连接方式无关。
