---
date: 2026-09-30
summary: 品牌 BLE 统一由后端 noble 直连系统蓝牙，不再经本机桥
supersedes: ADR-2026-09-14-brand-ble-uses-noble.md, brand-ble-backend-native.md, ADR-2026-09-30-brand-ble-noble-no-bridge.md
---

# 品牌 BLE 统一走 noble 直连

品牌设备本机蓝牙的扫描、连接、写 GATT 一律走后端 `@stoprocent/noble`（WinRT/CoreBluetooth），不经本机桥。组帧仍用现有 `protocols/*`。前端只走 REST。

本机桥（`bridge/` Rust、`ycy_bridge`/`dglab_bridge`）不再作为产品连接方式，品牌页不再提供「本机桥接」入口；`docs/windows-native-bridge-plan.md` 仅作历史参考。测试可注入 `fetchImpl` 走旧本机桥 HTTP。网页蓝牙不是产品主路。
