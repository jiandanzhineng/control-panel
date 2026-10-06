# 开发测试记录

- 2026-10-06 创作者月度分成改为「管理员手工录入发放记录」（分支 `docs/creator-payout`，改自 `feat/creator-payout`）：
  - **删掉自动统计**：不再拉 OpenPanel，删除 `generate` 接口、奖金池/门槛/排除名单/OpenPanel 全部配置与 `.env.example` 段落、`tools/fake-openpanel.js` 及相关测试（`payout_openpanel.go`、`payout_test.go` 一并删除）；`config.go` 的 `csv→csvList` 改名保留。
  - 表 `payout_reports` 重建：`id` 自增主键、`month`、`game_id`、`author_id`、`author_name`、`valid_plays`（可空，管理员手抄参考数据）、`amount_cny`、`note`、`paid_at`、`paid_by`、`created_at`，唯一键 `(month, game_id)`。旧结构（`status`/`generated_at`、主键 `(month, game_id)`）从未上线生产，迁移时检测到就直接 DROP 重建（`database.go` 的 `dropLegacyPayoutReports`）。
  - 接口：`POST /api/admin/payouts`（month、gameId、amountCny>0、validPlays?、note?；作者按 game_id 归属自动带出；非社区游戏中文报错；同月同游戏 409）、`GET /api/admin/payouts?month=YYYY-MM`（不带 month 返回全部按月份倒序，附作者邮箱与账号中心 ID）、`POST /api/admin/payouts/{id}/delete`、`GET /api/admin/community-games`（game_id/标题/版本/作者名/邮箱/账号中心 ID/状态 active|revoked）、`GET|POST /api/admin/game-owners`、作者端 `GET /api/payouts/mine`。
  - game_id 归属补两条规则（`ownership.go`）：① 管理员投稿（`author_is_admin=1`）可以发布到**任何已存在的 game_id**（官方 id、他人社区游戏、指定归属的游戏），**归属不变**，版本仍须严格升高；② 新表 `game_owners(game_id 主键, author_id, author_name, set_by, set_at)` 手工指定归属，邮箱须已存在于 `identities`（否则「该邮箱尚未登录过投稿平台」）。最终优先级：`game_owners` 指定 > 最早的社区 release 作者 > 官方保留。被指定后该游戏视为社区游戏（可录入分成、作者本人可升版）。审核后台 `gameIdStatus` 新增 `admin`（管理员更新）。
  - 前端：`admin.html`「月度分成」tab 改为社区游戏与作者列表 + 录入表单 + 记录列表（可删）+ 归属指定表单；`submission.js`「我的分成」改显示发放记录（月份/游戏/有效游玩/金额/发放时间/备注，无记录时友好提示）；`docs/contribute.html` 与站点 i18n 文案同步英文（不写具体金额与门槛）。
  - 运营 guide：新增 `docs/guides/creator-payout-guide.md`（埋点字段与版本、OpenPanel 看板按月统计步骤、同设备同日去重的近似办法、刷量识别、找作者、商城 `/admin/reward` 发钱与备注格式、回投稿平台录入与删改、归属指定、每月检查清单）。
  - 测试：`gofmt -l .` 干净、`go vet ./...` 通过、`go test ./... -count=1` 通过；play-registry `npm test` 29 通过、`npm run build` 通过。
- 2026-10-01 托管核心对齐原版逻辑（ADR 草稿 host-runtime-keeps-game-logic）：pressure-edging-v2 2.2.1 恢复临界气压游戏内无上限、曲线拖动经新动作 `setThresholds` 提交宿主、+10 只抬本帧目标、原版强度下发/取整/刺激时长累计；surge-edging 1.4.1 以线上 1.3.6 页面为原版（f84b03e 的算法同步不回退）。两者：参数只限 min/max 不按步长取整、暂停不顺延结束时间也不打断电击、暂停中可电击；宿主开局读一次传感器当前气压，只在气压变化时推样本。仅 iframe 运行的游戏未受大改影响。验证：后端 600（599 过 1 跳过）、前端 16；隔离后端 `PORT=5391 BACKEND_DATA_DIR=.tmp/...` + 虚拟设备 + `PUT /api/dev-access {enabled:true}`，无头 Chrome CDP（需请求头 `x-control-panel-bridge-internal: 1` 才能加载桥脚本）实测拖曲线 20→23.7 宿主同步。
- 2026-09-30 配置页设备映射卡片头部加「刷新设备」按钮（`refreshDevices`：保留仍有效映射、丢弃离线项、空位自动补第一台在线设备并 saveConfig）；托管运行页空状态加「游戏没加载出来？请刷新一下」提示与刷新按钮（本地重拉状态+重解析页面，远程重建 iframe）。前端 16 测试与构建通过。
- 2026-09-29 托管游戏回归原始 UI（方向 A）：host 游戏运行页改回各游戏自己的页面。页面带 `?runtime=host|remote` 时进入托管渲染模式（共享桥脚本 `backend/public/game-runtime-bridge.js`）：host 轮询 `/api/game-runtime/status`、命令走 `/api/game-runtime/*`；remote 轮询 `/api/remote-game/status`、命令映射为 `/api/remote-game/command` 白名单。前端 `GameRuntimeView` 只是 iframe 壳（等待按键/重连提示/结束导航/运行中参数面板），页面路径解析器 `frontend/src/play/gamePagePath.ts`（内置游戏走 `/api/games/:id` 的 gamePath，注册表游戏走 `/api/game-cache/install/:id`）。`GameRuntimeSurface`/`gameSurfaces/*` 已删除，配置页不再有「配置预览」。版本：surge-edging 1.4.0（页面源码以线上 1.3.6 为准拉回仓库并加托管适配，core 重写为窗口最小值检测+midDelay）、pressure-edging-v2 2.2.0。验证：后端 596 通过、前端 16 通过、构建通过；无头 Chrome（`--headless=new --virtual-time-budget=6000 --dump-dom`）实测两个页面渲染真实快照、暂停/日志/阶段文字正确，`/api/game-runtime/sensor` 可注入气压触发边缘期。远程双端 MQTT 链路未回归（沿用既有单测覆盖）。移动端 `E:\develop\smart\control_panel_mobile` 有未提交的游戏运行层改动，本轮未同步页面过去。
- 注意：`PUT /api/dev-access {"enabled":true}` 的状态会**持久化**到后端数据目录，开着它跑后端测试会让 `bridgeAccessGuards`/`browserApiAccess` 两个套件失败（WS 升级被放行）。手测完务必 `{"enabled":false}` 关回。
- 2026-09-29 俯卧撑游戏：`backend/games/pushup-detection` 与移动端 `assets/games/pushup-detection` 同步；`vibrator` 是共用的电机输出槽，可接 TD01 或 PJ01，奖励与惩罚都使用 `vibratorIntensity`，各自保留时长参数。定向测试：`npm --prefix backend test -- --runInBand pushup-detection-output.test.js`。

- 2026-09-23 三阶段远程启动回归：双隔离 Electron 的被控端前端/后端/CDP 为 `5303/5301/9224`，主控端为 `5304/5302/9225`；测试房间服务 `8787`、本机 MQTT `1883`。虚拟设备 `electron_qiya/electron_td01/electron_dianji/electron_lock` 在被控端 `POST /api/virtual-devices/batch` 创建。CDP 实测主控选择 `pressure-edging-v2`、自动设备映射、启动前参数 3 分钟、运行中改为 4 分钟、气压驱动中期/边缘、暂停/继续、电击一次及自动停止、强制边缘、阈值微调 19.2→19.3、停止；两端快照一致，结束 `remote-stop` 后 TD01/电击/锁/传感器收到复位命令。`npm run check`：后端 584 通过、1 跳过，前端 12 通过，构建通过。仅虚拟设备验证，未验证真实硬件输出。隔离后端 `/api/dev-access` 为 `enabled=true`，仅供本机手测。

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
- 2026-10-06 部署创作者分成 + game_id 归属（develop `45d93f1`）：release `/opt/game-platform/releases/20261006-155439`（Linux 构建：`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath`，scp 后 `ln -sfn` 切 current，`systemctl restart game-platform`）。回滚：current 指回 `releases/20260917-164315`（新表/新列向后兼容，旧程序不读）。部署前备份 `/var/lib/game-platform/game-platform.db.bak.20261006-155439-pre-creator-payout`。surge-edging 首个 release 是导入的官方包，已写 `game_owners` 指定给 DK（identity `01M0YHJE20QDX1V9VFJ020AA3S`）。注意：生产程序不带 `--help`，直接执行会以默认配置在 cwd 建 `data/` 并尝试监听 8787，别在服务器上裸跑。
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
- Windows 品牌蓝牙产品路径：后端 `@stoprocent/noble` 直连 WinRT。日志前缀 `[ble]`（scan start/found/done、connect、gatt、ready、write）。注入 `fetchImpl` 的测试仍走旧本机桥 HTTP（仅测试用，产品不经本机桥）。
- ESP32-C3 模拟杯：COM17（CH343），芯片 MAC `60:55:f9:7c:34:2c`，BLE 地址 `60:55:f9:7c:34:2e`，广播名 `YCY-FJB-03`，GATT `FF40/FF41写/FF42通知`。固件 MicroPython `tools/ycy-c3-mock/main.py`。真机命令：`node tools/noble-ycy-e2e.js`。esptool 用 IDF 5.5 venv：`C:\Users\46907\.espressif\python_env\idf5.5_py3.11_env\Scripts\python.exe -m esptool`。
- 编桥（旧 Rust 本机桥，已被 noble 直连取代，仅留作参考）：`%USERPROFILE%\.cargo\bin\cargo.exe build --release --manifest-path bridge/Cargo.toml`，再 `npm run build:bridge`。Windows `PeripheralId` 用平台地址字符串，禁止当 UUID。
- Vite 纯浏览器网页蓝牙只用于开发连 GATT，不保证登记进设备层，不能映射玩法。产品以 Electron 为准。本机蓝牙（noble 直连）连上后走 `/api/brands/connect` mode=native，控制仍走能力接口。
- 品牌网页蓝牙自动连接设置：`GET/PUT /api/brands/settings`，名单 `GET /api/brands/saved-ble`，默认 autoConnect / autoConnectAll 均为 true。役次元 Chromium 设备 ID 会随 BLE 随机地址变，自动连按广播名静默扫描，沿用已保存设备 id。
- 役次元杯真机：广播名 `YCY-FJB-03`，地址 `FF:26:02:28:4C:CD`。GATT `FF40/FF41写/FF42通知`。控制帧 6 字节 `35 12 旋转 震动 第三轴 校验`（旋转 0–40）。品牌页连上后有旋转/震动/第三轴滑条。产品路径是「蓝牙连接」（后端 noble 直连），不是网页蓝牙，也不经本机桥。
- 繁野啵啵贝：广播名 `SOSEXY`，内部类型 `SOSEXY_PID0004`，品牌码 `sosexy`。GATT `EE01/EE02通知/EE03写`；`strength` 为 0–255 同时映射震动与吸吮，独立 `vibration`/`suction` 直接 0–100，`shock` 映射微电流。协议实现见 `backend/brands/protocols/sosexy.js`。页面展示品牌「繁野」、产品「啵啵贝」，不归入役次元。
- GXP 艾萝机娘二代：广播名 `Xa9935`（部分匹配），内部类型 `GXP_XA9935`，品牌码 `gxp`。GATT 控制写 `FF03`、通知 `FF02`（不解析）。`strength` 0–255→电机 0–100%；震动模式 1–12 仅品牌页试控；震动强度字段未确认不发。协议见 `docs/device/brand/gxp-xa9935-ble-control.md`。
- 2026-09-04 串口抢占真机验证：`COM17` 上的 `RT01` 先建立普通业务连接，再发起 merged 固件烧录。烧录会自动关闭原串口句柄、移除业务会话并加固件锁；到 100% 后释放锁，设备以同一 ID 和 `v1.1.40` 重新连接成功。

- 2026-09-15 游戏网站新增 game-detail.html 游戏介绍页、author.html 作者管理页；作者修改已发布投稿通过 POST /api/submissions/:id/update 回到待审核。
- 2026-09-20：`drink-pee-unlock` 对外称「喝水/液体收集」，pee 模式是容器放秤上、秤变重。不要写憋尿/排尿/排泄，也不要写成站上秤、喝水变重。游戏版本 2.3.5。
- 2026-09-16 游戏介绍页入口为 `game-intro.html?id=`（`game-detail.html` 同页保留）。介绍页跟站点深色主题、中英切换，本页可启动/缓存。
- 2026-09-17 公开 `registry.json` 的社区游戏带 `authorName`（来自投稿署名）。介绍页读该字段；缺署名且非 builtin 才显示未知作者。生产重建：`game-platform rebuild-registry`（加载 `/etc/game-platform/game-platform.env`）。

- 2026-09-23 独立远程工作区路由 `/remote-game`；视觉验证使用 BrowserOS neo，前端 Vite 端口 5174，后端 `npm run dev:backend`。（当时的 Vue 重做 UI / `GameRuntimeSurface` 已于 09-29 删除，见首条。）
- 2026-09-24 PC 双 Electron 实测：A/B 创建、加入、授权、远程启动 pressure-edging-v2、暂停/继续、运行中改参、B 断线后 A 继续、A 停止和设备复位均通过；仅虚拟设备与本机 MQTT，未验证真实硬件。
