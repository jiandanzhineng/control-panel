# 开发测试记录

- 品牌设备相关测试：`cd backend; npm test -- --runInBand tests/brandDevices.test.js tests/webBle.test.js tests/dglabV2.test.js`
- Windows 端蓝牙控制路径：Electron preload 的 `ycyBleApi` / `brandBleApi` 使用 Web Bluetooth，后端通过 `brandBle` transport 注册统一设备控制。
- Rust native bridge 在 Windows 的 `PeripheralId` 类型转换问题按用户决定保留，不作为 Windows 直连路径依赖。
- Vite 纯浏览器网页蓝牙只用于开发连 GATT，不保证登记进设备层，不能映射玩法。产品以 Electron 为准。Mac 本机桥连上后走 `/api/brands/connect` mode=native，控制仍走能力接口。
- 品牌网页蓝牙自动连接设置：`GET/PUT /api/brands/settings`，名单 `GET /api/brands/saved-ble`，默认 autoConnect true。
