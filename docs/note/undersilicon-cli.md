# undersilicon-cli（命令行工具）

源码 `device-cli/`，npm 包 `undersilicon-cli`，命令名 `undersilicon`。零依赖，Node >= 18。用户文档在 ezs-docs `content/developer/命令行工具.md`（`/docs/developer/cli`）。

## 结构

- `cli.js` 入口：解析参数 → 合并配置 → 写命令且开了限幅时先建租约 → 执行命令。
- `lib/config.js`：默认 `http://127.0.0.1:5278/api`；`--limit`/`--cap-limit`/`--lease-ttl` 与对应 `UNDERSILICON_*` 环境变量；只给 cap-limit 时 default=100。
- `lib/lease.js`：`POST /agent-control/lease`，404/405 直接报错退出（不降级为不限幅）；之后本进程请求都带 `X-Agent-Client`。clientId 默认 `undersilicon-cli`，多条命令共享同一租约。
- `lib/commands/*`：每个文件导出命令定义 `{name, aliases, usage, write, noLease, run}`。`stop` 设 `noLease`。
- 急停：`/device-watchdog/stop-all`，423 时改 `/remote-session/emergency-stop`，再 `/games/stop-current`。
- `game:start`：先 `/client/games/:id/launch {deviceMap}`；503 `CLIENT_UNAVAILABLE`（窗口未运行）或 404/405 且非 `GAME_NOT_FOUND`（1.0.41 及更早没有该接口）时回退 `/games/:id/start {deviceMapping}`。

## 坑

1. 后端错误体是 `{error:{code,message}}`，mock 也必须用这个格式，否则错误码判断（如 503 回退）在单测里能过、真实环境失效。
2. Git Bash 会把 `/plays` 参数改写成 `C:/Program Files/Git/plays`。`open` 对 Windows 绝对路径按 `/client/routes` 做后缀匹配还原；也支持 `open plays`。自己测时可设 `MSYS_NO_PATHCONV=1`。
3. 工作区文件可能是 CRLF（仓库是 LF）。发布前确认 `cli.js` 是 LF，否则 Mac/Linux 上 shebang 失效：`file device-cli/cli.js`。
4. `events:recent --limit` 是条数，不是限幅（config 里对该命令特判）。

## 测试

- 单测：`npm --prefix device-cli test`（node:test + 进程内 mock 后端 `test/support/mock-server.js`）。
- 实测纯后端：`PORT=5330 BACKEND_DATA_DIR=tmp/cli-live/data node backend/index.js`，用 `POST /api/virtual-devices` 建 TD01/DIANJI，`GET /api/virtual-devices/:id/commands` 看设备实际收到的值。重启后虚拟设备要重建。
- 实测客户端命令：`VITE_API_PROXY_TARGET=http://127.0.0.1:5310 npm --prefix frontend run dev -- --strictPort --port 5311`，再 `VITE_DEV_SERVER_URL=http://localhost:5311 CONTROL_PANEL_BACKEND_PORT=5310 CONTROL_PANEL_USER_DATA_DIR=tmp/cli-live/userdata node_modules/.bin/electron --remote-debugging-port=9324 electron/main.js`。
- 隔离后端也会通过 BLE 自动连上本机的 HRM-Virtual 心率带；跑 `stop` 前看一眼 `devices`。

## 发布

1. 改 `device-cli/package.json` 版本，`npm --prefix device-cli test`，`npm pack --dry-run` 看文件清单。
2. `node E:\smart\project\dsh-undersilicon\tools\npm-publish-web.cjs <device-cli 绝对路径>`（后台跑，把打印的 `AUTH_URL` 给用户在浏览器确认 2FA）。
3. 坑：用户确认前 npm 的 `-/v1/done` 接口返回 404，原脚本把 404 当错误立即退出（2026-11-09 两次都这样失败）。轮询要把 404 当成「还没确认」继续等，最长等 10 分钟。
