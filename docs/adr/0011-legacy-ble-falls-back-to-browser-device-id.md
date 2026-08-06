# 旧 BLE 固件回退到浏览器设备标识

BLE 连接优先读取 `0xFF04 Identity`，并使用其中的基础 MAC 设备 ID；若该特征明确不存在，则为兼容旧固件回退到 `ble:${Chromium device.id}`，即使这可能把同一硬件呈现为另一台设备。该兼容性优先于强制统一身份；只有特征缺失可以回退，特征存在但 JSON、`device_id` 或 `firmware_version` 非法时应拒绝连接，避免掩盖新固件协议错误。
