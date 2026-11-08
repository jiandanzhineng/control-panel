# 桌面客户端行为

## 窗口与托盘

- 首次点关闭询问「最小化到托盘」或「直接退出」，选托盘才进托盘；该选项在侧栏「设置」页可改。
- 设置文件：`%APPDATA%\Electron\window-settings.json`（开发态）或 `%APPDATA%\undersilicon\window-settings.json`（安装包）。`closeToTray` 为 `null` 表示还没选过。语言偏好同文件字段 `locale`（`zh` / `en` / `system`）。

## 小雅

- 启动后由 Electron 开独立窗口（`electron/localAppWindow.js`），主窗口不跳 iframe。
- 窗口标题尾部中文「按F11全屏 ESC退出全屏」、英文 `F11 fullscreen, Esc exit fullscreen`。
- 未登录启动会确认「部分功能可能不可用」；已登录直接启动。

## 更新

- 检查更新必须给出可见结果；测试渠道下若正式版更高也推荐正式版。
- 用户确认立即安装后自动关闭当前客户端继续；客户端未退出时安装器自动结束进程，不要求手动关闭重试。
- 本地测更新用的未打包安装版：`E:\smart\project\control-panel\.tmp\1.0.34-beta.2-win\win-unpacked\UnderSilicon.exe`。

## 设置与设备页

- 设备管理页去掉「自动刷新」开关，进入即每 3 秒刷新，不可关闭。
- 「串口自动连接」开关在「设备工具 → 串口连接」对话框内。
- 设备工具支持按类型批量控制，打开时自动刷新当前设备。
- 数据监控：期间设备 `report_delay_ms=100`，前端每次变化立即刷新不防抖。
- MQTT 日志只保留「解析MQTT消息」一条，topic 合并在该条上。
- 品牌页保留连上后的试控。

## 自绘标题栏（Windows）

- `electron/main.js`：`titleBarStyle:'hidden'` + `titleBarOverlay`（高 39，留出标题栏 40px 的底部 1px 分隔线）；IPC `window:set-titlebar-theme` 同步原生按钮配色。
- 前端 `components/AppTitleBar.vue`：侧栏开关、品牌、面包屑、拖拽区；主题变化时读 `--bg-app`/`--text-muted` 传给主进程。改 main.js 后需重启 Electron 才生效。
- 截原生窗口（含系统按钮）：CDP `Page.captureScreenshot` 已能拍到 WCO 区域，不要用屏幕截图（会抢用户前台窗口）。
