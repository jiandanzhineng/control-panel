---
date: 2026-08-06
summary: BLE 0xFF04 身份特征返回设备 ID 和固件版本
---

# BLE 身份特征返回设备 ID 和固件版本

BLE 固件通过只读 `0xFF04 Identity` 特征返回与串口握手相同的 `device_id` 和 `firmware_version`，形如 `{"device_id":"aabbccddeeff","firmware_version":"v1.1.38"}`。

`device_id` 是 12 位小写、无分隔符的 eFuse 基础 MAC，与 MQTT 设备 ID 一致，不是 BLE 连接地址；`firmware_version` 取自 `esp_ota_get_app_description()->version`，含前导 `v`。

特征不含 `protocol_version`：它只确认设备身份并报告固件版本。协议兼容能力若需要应独立建模。
