# 品牌设备（本机 noble 直连）

产品路径：后端 `@stoprocent/noble` 直连 WinRT。日志前缀 `[ble]`（scan start/found/done、connect、gatt、ready、write）。连上后走 `/api/brands/connect` mode=native，控制走能力接口。测试可注入 `fetchImpl` 走旧本机桥 HTTP（仅测试）。

- 品牌页自动连接设置：`GET/PUT /api/brands/settings`，名单 `GET /api/brands/saved-ble`，默认 autoConnect / autoConnectAll 均为 true。网页蓝牙 ID 随 BLE 随机地址变，自动连按广播名静默扫描，沿用已保存设备 id。
- 设备 ID：本机蓝牙用 12 位小写 MAC（无前缀无冒号）；网页蓝牙无 MAC 时用 `品牌前缀:浏览器设备id`。
- 能力按物理效果：机械 strength（0–255）+ motors（value 0–255、direction ±1）；电击 shock（0–100）+ estim（通道、intensity 0–255、wave 预设 ID）；泵 pump。strength 只改主轴且只正转，未知波形忽略。
- 测试：`cd backend; npm test -- --runInBand tests/brandDevices.test.js tests/webBle.test.js tests/dglabV2.test.js`
- Vite 纯浏览器网页蓝牙只用于开发连 GATT，不保证登记进设备层，不能映射玩法。
- 旧 Rust 本机桥（已被 noble 取代，仅参考）：`%USERPROFILE%\.cargo\bin\cargo.exe build --release --manifest-path bridge/Cargo.toml`，再 `npm run build:bridge`。Windows `PeripheralId` 用平台地址字符串，禁止当 UUID。
