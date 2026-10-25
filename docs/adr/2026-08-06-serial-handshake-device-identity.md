---
date: 2026-08-06
summary: 串口握手返回基础 MAC 与固件版本，旧固件必须拒绝
---

# 串口握手返回统一设备身份

串口设备收到 `@DEBUG START` 后返回 `@DEBUG READY {"device_id":"aabbccddeeff","firmware_version":"v1.1.38"}`。`device_id` 是 MQTT topic 已用的 12 位小写基础 MAC；`firmware_version` 取自 `esp_ota_get_app_description()->version`，含前导 `v`。

握手不含 `protocol_version`。面板只在收到完整合法的新版握手后登记设备；仅返回 `@DEBUG READY` 的旧固件必须拒绝并释放端口，不回退兼容身份。

设备 ID 不在每条 `@MSG` 中重复携带，MQTT、串口和新版 BLE 共用同一身份。
