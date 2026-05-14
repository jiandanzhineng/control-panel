# 后端运行与测试指引

本文按当前后端实现整理，接口细节以 [后端 API 文档](../api/Backend_API.md) 为准。

## 环境准备

- Node.js 需要支持全局 `fetch`，固件 OTA 清单拉取依赖它。
- 后端依赖安装：
  ```powershell
  npm --prefix backend install
  ```
- 前端依赖安装：
  ```powershell
  npm --prefix frontend install
  ```
- 根目录 Electron 依赖安装：
  ```powershell
  npm install
  ```

## 启动后端

开发模式：

```powershell
npm run dev:backend
```

或：

```powershell
npm --prefix backend run dev
```

独立后端默认监听 `3000`，可用 `PORT` 覆盖。

启动时会自动：

- 初始化 MQTT 客户端。
- 加载设备持久化数据。
- 启动设备离线检查循环。
- 尝试启动 MQTT Broker。
- 挂载 `/api/*` 路由。

## 常用检查

```powershell
Invoke-RestMethod http://localhost:3000/api
Invoke-RestMethod http://localhost:3000/api/hello
Invoke-RestMethod http://localhost:3000/api/mqtt/status
Invoke-RestMethod http://localhost:3000/api/mqtt-client/status
Invoke-RestMethod http://localhost:3000/api/devices
Invoke-RestMethod http://localhost:3000/api/games
Invoke-RestMethod http://localhost:3000/api/logs/files
```

启动 MQTT Broker：

```powershell
Invoke-RestMethod `
  -Uri http://localhost:3000/api/mqtt/start `
  -Method Post `
  -ContentType 'application/json' `
  -Body (@{ port = 1883; bind = '0.0.0.0' } | ConvertTo-Json)
```

发布 MQTT 消息：

```powershell
Invoke-RestMethod `
  -Uri http://localhost:3000/api/mqtt-client/publish `
  -Method Post `
  -ContentType 'application/json' `
  -Body (@{ topic = '/test'; message = @{ hello = 'world' } } | ConvertTo-Json -Depth 5)
```

## 测试

后端 Jest：

```powershell
npm --prefix backend test
```

后端覆盖率：

```powershell
npm --prefix backend run test:cov
```

设备 CLI 测试：

```powershell
npm run test:device-cli
npm run test:device-cli:mock
```

前端构建校验：

```powershell
npm --prefix frontend run build
```

## 数据与日志

独立后端：

- 默认数据目录由 `backend/utils/fileStorage.js` 决定。
- 开发环境日志目录为 `backend/logs`。
- 可用 `LOG_DIR` 覆盖日志目录。

Electron：

- 数据目录：`app.getPath('userData')/data`
- 日志目录：`app.getPath('userData')/logs`

## 已知实现差异

- `GET /api/network/ips` 使用 Node `os.networkInterfaces()`，不依赖 WSL 或 `ifconfig`。
- `POST /api/mdns/publish` 当前不读取请求体；Windows 固定启动 `mdns_tool.exe 8080`。
- 非 Windows mDNS 发布尚未实现。
- 前端游戏配置页会调用 `POST /api/games/:id/config/reset`，后端尚未实现。
