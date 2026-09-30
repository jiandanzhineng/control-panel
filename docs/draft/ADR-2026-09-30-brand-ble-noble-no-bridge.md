# 品牌 BLE 统一走 noble 直连

摘要：品牌 BLE 统一由后端 noble 直连系统蓝牙，不再经本机桥（WinRT/Rust native bridge）。

- 用户决定（2026-09-30）：品牌设备本机蓝牙扫描、连接、写 GATT 一律走后端 `@stoprocent/noble`。
- 本机桥（`bridge/` Rust、`ycy_bridge`/`dglab_bridge`）不再作为产品连接方式，品牌页不再提供「本机桥接」入口。
- 旧文档 `docs/windows-native-bridge-plan.md` 仅作历史参考。
