# 开发测试记录

- 品牌设备相关测试：`cd backend; npm test -- --runInBand tests/brandDevices.test.js tests/webBle.test.js tests/dglabV2.test.js`
- Windows 品牌蓝牙产品路径：主进程监管 `tools/ycy_bridge.exe`、`dglab_bridge.exe`，后端 `brandService` 经 `127.0.0.1:3001/3002` 扫描连接并登记设备。前端只 REST。网页蓝牙仅开发用、不进设备层。
- 编桥：`%USERPROFILE%\.cargo\bin\cargo.exe build --release --manifest-path bridge/Cargo.toml`，再 `npm run build:bridge`。Windows `PeripheralId` 用平台地址字符串，禁止当 UUID。
- Vite 纯浏览器网页蓝牙只用于开发连 GATT，不保证登记进设备层，不能映射玩法。产品以 Electron 为准。Mac 本机桥连上后走 `/api/brands/connect` mode=native，控制仍走能力接口。
- 品牌网页蓝牙自动连接设置：`GET/PUT /api/brands/settings`，名单 `GET /api/brands/saved-ble`，默认 autoConnect / autoConnectAll 均为 true。役次元 Chromium 设备 ID 会随 BLE 随机地址变，自动连按广播名静默扫描，沿用已保存设备 id。
