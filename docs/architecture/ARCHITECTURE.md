# 项目架构说明

本文按当前代码实现整理，代码入口以仓库根目录为基准。

## 总览

控制面板由三部分组成：

- 前端：Vue 3 + TypeScript + Vite + Element Plus，源码在 `frontend/`。
- 后端：Node.js + Express，源码在 `backend/`，统一 API 前缀为 `/api`。
- 桌面壳：Electron，源码在 `electron/`，用于把前端、后端和资源一起打包为 Windows 应用。

## 运行方式

### 浏览器开发模式

- 后端：`npm --prefix backend run dev`，默认监听 `3000`。
- 前端：`npm --prefix frontend run dev`，默认监听 `5173`。
- 根目录组合命令：`npm run dev:all`。
- Vite 代理：`frontend/vite.config.ts` 将 `/api` 代理到 `VITE_API_PROXY_TARGET`，默认 `http://localhost:3000`。

### Electron 开发模式

- 先启动前端开发服务器：`npm --prefix frontend run dev`。
- 再运行：`npm run electron:dev`。
- Electron 主进程会在本进程内 `require backend/index.js`，并固定把后端监听在 `127.0.0.1:5278`。
- Renderer 加载 `VITE_DEV_SERVER_URL=http://localhost:5173`。
- `electron/preload.js` 会把 `fetch('/api/...')` 和 `EventSource('/api/...')` 改写到 `BACKEND_URL`，即 Electron 内部后端。

### Electron 生产模式

- `electron/main.js` 启动后端：`127.0.0.1:5278`。
- 如未设置 `VITE_DEV_SERVER_URL`，主进程会启动一个本地前端静态服务：`127.0.0.1:5277`。
- 前端静态服务托管 `frontend/dist`，并把 `/api` 代理到后端。
- `process.env.BACKEND_DATA_DIR` 指向 Electron `userData/data`，用于持久化运行数据。

## 后端启动行为

`backend/index.js` 在模块加载时会执行这些初始化：

- 创建 Express app，启用 CORS、`express.json()` 和请求日志。
- 初始化 MQTT 客户端，默认连接 `mqtt://127.0.0.1:1883`，连接后订阅 `#`。
- 将 MQTT 设备上报分发给 `deviceService.handleDeviceMessage`。
- 加载设备持久化数据并启动离线检查循环。
- 自动启动 MQTT Broker：Windows 优先 EMQX，其他平台或回退场景使用 mosquitto。
- 挂载 `/api/mqtt`、`/api/devices`、`/api/games`、`/api/logs` 等路由。

只有直接运行 `node backend/index.js` 时，才会执行 `app.listen(PORT)`。此时 Windows 平台还会尝试自动发布 mDNS。Electron 是通过 `require` 取得 app 后自行监听端口，因此不会触发 `require.main === module` 分支。

## 前端页面

前端使用 hash 路由，当前路由来自 `frontend/src/router/index.ts`：

- `/home`：首页。
- `/devices`：设备管理。
- `/devices/firmware-batch`：批量固件升级。
- `/test`：自动化测试。
- `/games`：游戏管理。
- `/games/:id/config`：游戏启动前配置。
- `/games/current`：当前运行游戏的嵌入式页面。
- `/network`：MQTT、mDNS 和 MQTT 客户端状态管理。
- `/logs`：日志管理。
- `/gamelist`、`/services` 为旧路径重定向。

## 关键数据流

### 设备

设备通过 MQTT 主题 `/dpub/{deviceId}` 上报 JSON。`method=report` 会自动创建设备或更新设备数据；`method=ota_status` 会更新 OTA 状态；`method=update` 会按 key/value 或 payload 合并设备数据。设备超过 60 秒未上报会被标记为离线，离线检查每 3 秒运行一次。

### 游戏

游戏文件放在 `backend/game/`，`POST /api/games/reload` 会递归扫描 `.js` 文件并写入 `fileStorage('games')`。启动游戏时，后端在 VM 沙箱中加载玩法文件，校验导出的玩法对象，并把 `deviceManager` 注入给玩法。玩法运行循环默认每 1000ms 调用一次 `loop()`。

### 日志

后端统一通过 `backend/services/logService.js` 写日志。日志按日期写入 `.log` 文件，并通过 `newLog` 事件实时推送到 `/api/logs/current` SSE。

## 打包边界

根目录 `package.json` 的 `electron-builder` 配置会包含：

- `electron/**/*`
- `backend/**/*`
- `frontend/dist/**/*`
- 根目录和后端的 `node_modules`
- `backend/inner-tools` 作为 `extraResources/inner-tools`
- `backend/game` 作为 `extraResources/game`

Windows 安装包的产品名为 `UnderSilicon`，NSIS 目标为 x64。
