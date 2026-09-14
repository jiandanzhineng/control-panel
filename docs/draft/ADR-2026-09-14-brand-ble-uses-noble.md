# 品牌本机蓝牙走 Node noble

摘要：品牌设备本机蓝牙用 noble 直连系统蓝牙，不再经 Rust 桥。

品牌页「蓝牙连接」在 Windows/macOS 上通过 Node `@stoprocent/noble`（WinRT/CoreBluetooth）扫描、连接并写 GATT。组帧仍用现有 `protocols/ycy.js` 等。测试可注入 `fetchImpl` 走旧本机桥 HTTP。网页蓝牙仍不是产品主路。
