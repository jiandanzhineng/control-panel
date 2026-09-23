# 开发测试记录

- 2026-09-23 CDP 双 Electron 回归：隔离前端 `5303/5304`、后端 `5301/5302`、房间服务 `8787`、CDP `9224/9225`，被控端虚拟设备 `electron_qiya/electron_td01/electron_dianji/electron_lock`。主控创建并加入房间、授权、启动 `surge-edging`，暂停/继续、强度、电击、强制边缘、参数 `duration 20→21`、停止均通过；停止快照为 `ENDED/remote-stop`，设备均安全复位。主控与被控端随后离开房间，最终 `remote-game.active=false`、`game-runtime.active=false`。隔离后端 `/api/dev-access` 保持 `enabled=true` 供手测，未改生产代码。

- 2026-09-23 PC/手机双向远控方案：手机仓库 `docs/plans/2026-09-23-mobile-pc-remote-game-runtime.md` 为跨端 v2 交接规范，PC 草稿已补兼容要求。核对 PC 基线 `7ec92bb`；此记录为文档核对，非功能验收。设备管理需加入客户端远控，commands topic 应使用发送者 credential.userId；三阶段玩法为 `pressure-edging-v2`，不要与 `surge-edging` 混用。

- 2026-09-23 双客户端远程游戏实测：使用隔离后端（被控端 `5301`、主控端 `5302`）、前端（`5303`/`5304`）、本机 EMQX `1883` 和临时房间服务 `8787`。被控端创建虚拟设备 `test_qiya(QIYA)`、`test_td01(TD01)`、`test_dianji(DIANJI)`、`test_lock(ZIDONGSUO)`，四个设备均在线。设备投影控制通过 MQTT 实测：TD01 `power=99`、电脉冲 `voltage=18/shock=1`、自动锁 `open=0`，均收到 `projection.write-result`。远程游戏房间使用 `gameId=remote-game`、容量 2；主控端加入并授权后，远程启动 `surge-edging` HostRuntime，改参数、暂停/继续、`forceEdge`（边缘次数 1/电击次数 1）、`shockOnce`（电击次数 2）和停止均成功；停止快照为 `ENDED/remote-stop`，虚拟 TD01/电脉冲/自动锁收到停止或复位指令。撤销授权后主控命令返回 `CONTROL_NOT_AUTHORIZED`。本次只验证本机虚拟设备和 MQTT，不代表真实硬件输出；测试临时服务和文件已清理。

- 2026-09-23 远程游戏 HostRuntime：`surge-edging` 1.2.0 的逻辑在后端 `backend/game-runtime` 执行，页面只渲染快照。远程游戏房间 `gameId=remote-game`、容量 2，和设备投影房间分开。全量验证：后端 93 个测试套件 / 579 个测试通过（1 个既有跳过项），前端 11 个测试通过，`npm run build:frontend` 通过；品牌自动重连 12 个测试通过。本轮用 mock 设备验证停止/电击/远控授权、旧序列丢弃和客户端释放；没有做真实设备输出验证。已发布的 `packages/surge-edging-1.1.2-*.zip` 未重建，网站包仍是 iframe 版，直到下次 registry 构建。

- 2026-09-23 游戏运行层：用户要求游戏逻辑继续使用 JavaScript。新游戏应拆分为无浏览器依赖的 `game-core.js` 与 WebView 渲染层；移动端引擎评估见 `E:\smart\project\control_panel_mobile\docs\research\2026-09-23-js-game-core-runtime-feasibility.md`，当前不把锁屏持续运行写成已验证能力。

- 2026-09-05 桌面检查入口：仓库根目录 `npm run check`，依次运行后端 Jest、前端 Node 测试和前端类型检查/生产构建。CI 使用 Node 22 最新补丁版；前端 TypeScript 测试使用 Node 内置类型擦除，建议本地 Node 22.18+。
- 前端组件按需导入使用 `unplugin-vue-components@29.2.0`，配置在 `frontend/vite.config.ts`。保留 Element Plus 全局样式以维持主题覆盖顺序，图标由各组件显式导入。
- 设备上报保存窗口为 1 秒，异步写临时文件后替换设备记录；日志每 100ms 批量追加。后端退出、日志下载与诊断上传会等待相应队列完成。

- 玩法统计（2026-09-09）：走 OpenPanel 看板 `https://op.shiroha.tech`，事件 `game_start`/`game_stop`（及插件对应事件）。属性含 version、source、device_types、device_macs、roles、duration_ms、end_reason。无 heartbeat，无登录态。上报 `https://op.shiroha.tech/api/track`。
- 游戏平台生产 API（2026-09-05）：`https://game-api.undersilicon.cn` 部署在 `47.242.37.88`，systemd 服务 `game-platform` 仅监听 `127.0.0.1:8787`。程序 `/opt/game-platform/current/game-platform`，配置 `/etc/game-platform/game-platform.env`，SQLite `/var/lib/game-platform/game-platform.db`，Nginx `/etc/nginx/conf.d/game-api.undersilicon.cn.conf`。日志用 `journalctl -u game-platform`。
- 游戏平台 OSS：公开 bucket `ezs-games`；待审 bucket `ezs-game-submissions` 为 private，只允许 `https://game.undersilicon.cn` POST，`submissions/` 7 天清理。ESA 站点 `undersilicon.cn` 的既有 API/admin 缓存规则已补 `no_cache`，全局 CORS 规则排除 `game-api.undersilicon.cn`，由源站返回精确 Origin。
- 2026-09-05 生产验证：mobile `/me` 返回 `isAdmin: true`，game API 映射为 `admin`；ZIP 创建、OSS 直传、归档校验、待审、退回、批准发布和下架均通过。Electron 生产构建经 CDP 验证从 `/games/cache/` 运行已发布包，QA 页面进入 `ready`，无控制台或资源加载错误。
- 游戏平台首次投产必须在发布新游戏前调用一次 `/api/admin/registry/import`。生产 `GAME_PLATFORM_EXISTING_REGISTRY_URL` 使用仍保留旧 8 个版本的 `https://game.undersilicon.com/registry.json`；2026-09-05 已完成导入并在 QA 下架后恢复原 8 个游戏。恢复前的环境文件和 SQLite 备份保留在服务器，后缀为 `.bak.20260905-registry-restore`。
- ESA 缓存规则 `506125495674880` 仅匹配 `game.undersilicon.cn/registry.json`，浏览器与边缘均 `no_cache`、`bypass_all`；玩法页面和不可变游戏资源继续使用自动缓存。默认 registry 已验证为 `DYNAMIC`。
- BrowserOS neo 使用系统代理 `127.0.0.1:7990` 时，Windows `ProxyOverride` 需包含 `*.undersilicon.cn`；否则 game API 请求可能断连。
- 游戏投稿平台 Go 工具链（免安装）：`C:\Users\46907\AppData\Local\GoPortable\go1.27.0-full\go\bin\go.exe`。在 `game-platform/` 下执行 `go test ./...`；生产构建使用 `game-platform/Dockerfile`。

- 本地测更新用的未打包安装版：`E:\smart\project\control-panel\.tmp\1.0.34-beta.2-win\win-unpacked\UnderSilicon.exe`
- 当前源码版本：1.0.34（正式渠道）
- 查本机 MQTT 客户端：`C:\easysmart\tools\emqx\bin\emqx_ctl.cmd clients list`。虚拟网页设备 clientId 形如 `vweb_v-web-cunzhi_xxxxxx`，面板 clientId 形如 `fb-client-DESKTOP-...`。
- 查面板在线设备：`GET http://127.0.0.1:5278/api/devices`（Electron 内置后端）。进程内虚拟设备另走 `GET /api/virtual-devices`。
- 数字人本机应用清单：`LOCAL_APP_FEED` 默认走 OSS 源 `https://ezs-firmware.oss-cn-shanghai.aliyuncs.com/apps`。卡片「更新」和「启动」分开。安装校验/解压走后台线程，避免卡在 90%。启动会显示「等待服务就绪（已 N 秒）」。开发态安装目录 `%APPDATA%\Electron\data\apps\digital-human\current`。
- 内置游戏 `index.html` 的 `game-manifest` 可带 `i18n.en`（title/description/howTo/devices/params/enumLabels/paramDescriptions/paramUnits）。面板列表和配置页按当前语言覆盖中文顶栏字段。游戏页内 UI 读 `DeviceAPI.locale`，静态文案用 `data-en`，JS 用中文当 key 调 `GameI18n.t()`，其它语言在游戏自己的 `i18n.js`。运行中不热切，重进再生效。
- play-registry 用户页（首页/列表/控制/运行壳）中英跟随浏览器语言，右上角可手动切换，记在 `localStorage.site-locale`。开发文档正文可仍中文，导航与页脚随站点语言。
- 百度统计（账号 ysy1997212，2026-09-04 接入）：`game.undersilicon.cn` siteId `23498945` hm `4ad0c770327c5e885bfd688a80ccac47`。`admin.html` 审核后台不接入。
- Electron 窗口/托盘选择：`%APPDATA%\Electron\window-settings.json`（开发态）或 `%APPDATA%\undersilicon\window-settings.json`（安装包）。`closeToTray` 为 `null` 表示还没选过。语言偏好同文件字段 `locale`（`zh` / `en` / `system`）。
- 小雅启动后由 Electron 开独立窗口（`electron/localAppWindow.js`），主窗口不跳 iframe。窗口标题尾部中文「按F11全屏 ESC退出全屏」、英文 `F11 fullscreen, Esc exit fullscreen`。未登录启动会确认。
- 语音渠道在面板「设置 → 语音服务」。没改过默认官方。key 在 `BACKEND_DATA_DIR/voice-settings.json`。本机游戏打 `POST /v1/chat/completions`；状态 `GET /api/voice/status`。客户端「瑰夏大人」语音助手调研见 `docs/research/pc-voice-assistant-2026-08-31.md`。唤醒词引擎拟用 `sherpa-onnx-node`（Windows x64，无需预装 C++/Python），KWS 模型 `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`。
- 国内账号/诊断库在 `47.116.46.164`（control_panel_mobile `.env` 的 SERVER_IP），SSH `root` + `~/.ssh/ci.pem`。容器 `undersilicon-cn-api-1` / `undersilicon-cn-postgres-1`，库 `undersilicon_api`。后台 `https://undersilicon-admin.pages.dev/telemetry` 打 `https://api.undersilicon.cn`，就是这台。查包：`docker exec undersilicon-cn-postgres-1 psql -U undersilicon -d undersilicon_api`，表 `diagnostic_log_bundles`。`GET /admin/telemetry/log-bundles` 带 `Cache-Control: max-age=86400`，浏览器会缓存列表一天。
- 诊断日志上传：日志管理页「上传诊断日志」→ `POST /api/logs/upload-diagnostics` → 国内 `POST https://api.undersilicon.cn/telemetry/log-bundles`，`reason=user_report`。匿名 id 在 `BACKEND_DATA_DIR/diagnostic-anonymous-id.json`。页面「完整日志包」只拉最近 40 条。数字人 stdout 模块名 `DigitalHuman`，文件 `current/tmp_launch.log`。
- 品牌设备相关测试：`cd backend; npm test -- --runInBand tests/brandDevices.test.js tests/webBle.test.js tests/dglabV2.test.js`
- Windows 品牌蓝牙产品路径：后端 `@stoprocent/noble` 直连 WinRT。日志前缀 `[ble]`（scan start/found/done、connect、gatt、ready、write）。注入 `fetchImpl` 的测试仍走旧本机桥 HTTP。
- ESP32-C3 模拟杯：COM17（CH343），芯片 MAC `60:55:f9:7c:34:2c`，BLE 地址 `60:55:f9:7c:34:2e`，广播名 `YCY-FJB-03`，GATT `FF40/FF41写/FF42通知`。固件 MicroPython `tools/ycy-c3-mock/main.py`。真机命令：`node tools/noble-ycy-e2e.js`。esptool 用 IDF 5.5 venv：`C:\Users\46907\.espressif\python_env\idf5.5_py3.11_env\Scripts\python.exe -m esptool`。
- 编桥：`%USERPROFILE%\.cargo\bin\cargo.exe build --release --manifest-path bridge/Cargo.toml`，再 `npm run build:bridge`。Windows `PeripheralId` 用平台地址字符串，禁止当 UUID。
- Vite 纯浏览器网页蓝牙只用于开发连 GATT，不保证登记进设备层，不能映射玩法。产品以 Electron 为准。Mac 本机桥连上后走 `/api/brands/connect` mode=native，控制仍走能力接口。
- 品牌网页蓝牙自动连接设置：`GET/PUT /api/brands/settings`，名单 `GET /api/brands/saved-ble`，默认 autoConnect / autoConnectAll 均为 true。役次元 Chromium 设备 ID 会随 BLE 随机地址变，自动连按广播名静默扫描，沿用已保存设备 id。
- 役次元杯真机：广播名 `YCY-FJB-03`，地址 `FF:26:02:28:4C:CD`。GATT `FF40/FF41写/FF42通知`。控制帧 6 字节 `35 12 旋转 震动 第三轴 校验`（旋转 0–40）。品牌页连上后有旋转/震动/第三轴滑条。产品路径是「蓝牙连接」（本机桥），不是网页蓝牙。
- 繁野啵啵贝：广播名 `SOSEXY`，内部类型 `SOSEXY_PID0004`，品牌码 `sosexy`。GATT `EE01/EE02通知/EE03写`；`strength` 为 0–255 同时映射震动与吸吮，独立 `vibration`/`suction` 直接 0–100，`shock` 映射微电流。协议实现见 `backend/brands/protocols/sosexy.js`。页面展示品牌「繁野」、产品「啵啵贝」，不归入役次元。
- GXP 艾萝机娘二代：广播名 `Xa9935`（部分匹配），内部类型 `GXP_XA9935`，品牌码 `gxp`。GATT 控制写 `FF03`、通知 `FF02`（不解析）。`strength` 0–255→电机 0–100%；震动模式 1–12 仅品牌页试控；震动强度字段未确认不发。协议见 `docs/device/brand/gxp-xa9935-ble-control.md`。
- 2026-09-04 串口抢占真机验证：`COM17` 上的 `RT01` 先建立普通业务连接，再发起 merged 固件烧录。烧录会自动关闭原串口句柄、移除业务会话并加固件锁；到 100% 后释放锁，设备以同一 ID 和 `v1.1.40` 重新连接成功。

- 2026-09-15 游戏网站新增 game-detail.html 游戏介绍页、author.html 作者管理页；作者修改已发布投稿通过 POST /api/submissions/:id/update 回到待审核。
- 2026-09-20：`drink-pee-unlock` 对外称「喝水/液体收集」，pee 模式是容器放秤上、秤变重。不要写憋尿/排尿/排泄，也不要写成站上秤、喝水变重。游戏版本 2.3.5。
- 2026-09-16 游戏介绍页入口为 `game-intro.html?id=`（`game-detail.html` 同页保留）。介绍页跟站点深色主题、中英切换，本页可启动/缓存。
- 2026-09-17 公开 `registry.json` 的社区游戏带 `authorName`（来自投稿署名）。介绍页读该字段；缺署名且非 builtin 才显示未知作者。生产重建：`game-platform rebuild-registry`（加载 `/etc/game-platform/game-platform.env`）。
