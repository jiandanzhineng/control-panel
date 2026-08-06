# BLE 身份特征返回设备 ID 和固件版本

BLE 固件通过固定的只读 `0xFF04 Identity` GATT 特征返回与串口握手相同的 `device_id` 和 `firmware_version`，载荷形如 `{"device_id":"aabbccddeeff","firmware_version":"v1.1.38"}`。其中 `device_id` 是 12 位小写、无分隔符的 eFuse 基础 MAC，与 MQTT 设备 ID 完全一致，而不是 BLE 连接地址；`firmware_version` 原样取自 `esp_ota_get_app_description()->version`，包括 `PROJECT_VER` 中的前导 `v`。身份特征不包含 `protocol_version`：它只负责确认物理设备身份并报告当前固件版本，协议兼容能力若以后确有需要，应独立建模，避免把身份读取与传输协议协商绑定。
