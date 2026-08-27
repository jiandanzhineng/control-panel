# 开发测试记录

- 品牌设备相关测试：`cd backend; npm test -- --runInBand tests/brandDevices.test.js tests/webBle.test.js tests/dglabV2.test.js`
- Windows 端蓝牙控制路径：Electron preload 的 `ycyBleApi` / `brandBleApi` 使用 Web Bluetooth，后端通过 `brandBle` transport 注册统一设备控制。
- Rust native bridge 在 Windows 的 `PeripheralId` 类型转换问题按用户决定保留，不作为 Windows 直连路径依赖。
