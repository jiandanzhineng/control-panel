# 开发测试记录

- 本地测更新用的未打包安装版：`E:\smart\project\control-panel\.tmp\1.0.34-beta.2-win\win-unpacked\UnderSilicon.exe`
- 当前源码版本：1.0.34-beta.8（测试渠道）
- 查本机 MQTT 客户端：`C:\easysmart\tools\emqx\bin\emqx_ctl.cmd clients list`。虚拟网页设备 clientId 形如 `vweb_v-web-cunzhi_xxxxxx`，面板 clientId 形如 `fb-client-DESKTOP-...`。
- 查面板在线设备：`GET http://127.0.0.1:5278/api/devices`（Electron 内置后端）。进程内虚拟设备另走 `GET /api/virtual-devices`。
- 数字人本机应用清单：`LOCAL_APP_FEED` 默认走 OSS 源 `https://ezs-firmware.oss-cn-shanghai.aliyuncs.com/apps`。卡片「更新」和「启动」分开。安装校验/解压走后台线程，避免卡在 90%。启动会显示「等待服务就绪（已 N 秒）」。开发态安装目录 `%APPDATA%\Electron\data\apps\digital-human\current`。
- Electron 窗口/托盘选择：`%APPDATA%\Electron\window-settings.json`（开发态）或 `%APPDATA%\undersilicon\window-settings.json`（安装包）。`closeToTray` 为 `null` 表示还没选过。
- 小雅启动后由 Electron 开独立窗口（`electron/localAppWindow.js`），主窗口不跳 iframe。窗口标题尾部「按F11全屏 ESC退出全屏」。未登录启动会确认。
- 语音渠道在面板「设置 → 语音服务」。没改过默认官方。key 在 `BACKEND_DATA_DIR/voice-settings.json`。本机游戏打 `POST /v1/chat/completions`；状态 `GET /api/voice/status`。
- 国内账号/诊断库在 `47.116.46.164`（control_panel_mobile `.env` 的 SERVER_IP），SSH `root` + `~/.ssh/ci.pem`。容器 `undersilicon-cn-api-1` / `undersilicon-cn-postgres-1`，库 `undersilicon_api`。后台 `https://undersilicon-admin.pages.dev/telemetry` 打 `https://api.undersilicon.cn`，就是这台。查包：`docker exec undersilicon-cn-postgres-1 psql -U undersilicon -d undersilicon_api`，表 `diagnostic_log_bundles`。`GET /admin/telemetry/log-bundles` 带 `Cache-Control: max-age=86400`，浏览器会缓存列表一天。
- 诊断日志上传：日志管理页「上传诊断日志」→ `POST /api/logs/upload-diagnostics` → 国内 `POST https://api.undersilicon.cn/telemetry/log-bundles`，`reason=user_report`。匿名 id 在 `BACKEND_DATA_DIR/diagnostic-anonymous-id.json`。页面「完整日志包」只拉最近 40 条。数字人 stdout 模块名 `DigitalHuman`，文件 `current/tmp_launch.log`。
- 品牌设备相关测试：`cd backend; npm test -- --runInBand tests/brandDevices.test.js tests/webBle.test.js tests/dglabV2.test.js`
- Windows 品牌蓝牙产品路径：主进程监管 `tools/ycy_bridge.exe`、`dglab_bridge.exe`，后端 `brandService` 经 `127.0.0.1:3001/3002` 扫描连接并登记设备。前端只 REST。网页蓝牙仅开发用、不进设备层。设备 ID 为 12 位小写 MAC（无冒号、无 `ycy:` 前缀），与其它设备一致。
- 编桥：`%USERPROFILE%\.cargo\bin\cargo.exe build --release --manifest-path bridge/Cargo.toml`，再 `npm run build:bridge`。Windows `PeripheralId` 用平台地址字符串，禁止当 UUID。
- Vite 纯浏览器网页蓝牙只用于开发连 GATT，不保证登记进设备层，不能映射玩法。产品以 Electron 为准。Mac 本机桥连上后走 `/api/brands/connect` mode=native，控制仍走能力接口。
- 品牌网页蓝牙自动连接设置：`GET/PUT /api/brands/settings`，名单 `GET /api/brands/saved-ble`，默认 autoConnect / autoConnectAll 均为 true。役次元 Chromium 设备 ID 会随 BLE 随机地址变，自动连按广播名静默扫描，沿用已保存设备 id。
- 役次元杯真机：广播名 `YCY-FJB-03`，地址 `FF:26:02:28:4C:CD`。GATT `FF40/FF41写/FF42通知`。控制帧 6 字节 `35 12 旋转 震动 第三轴 校验`（旋转 0–40）。品牌页连上后有旋转/震动/第三轴滑条。产品路径是「蓝牙连接」（本机桥），不是网页蓝牙。
- 繁野啵啵贝：广播名 `SOSEXY`，内部类型 `SOSEXY_PID0004`，品牌码 `sosexy`。GATT `EE01/EE02通知/EE03写`；`strength` 为 0–255 同时映射震动与吸吮，独立 `vibration`/`suction` 直接 0–100，`shock` 映射微电流。协议实现见 `backend/brands/protocols/sosexy.js`。页面展示品牌「繁野」、产品「啵啵贝」，不归入役次元。
