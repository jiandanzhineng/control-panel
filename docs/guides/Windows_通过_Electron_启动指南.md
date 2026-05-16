# Windows Electron 启动指南

本文按当前 `electron/main.js` 和 `electron/preload.js` 实现整理。

## 开发模式

1. 启动前端：
   ```powershell
   npm --prefix frontend run dev
   ```
2. 启动 Electron：
   ```powershell
   npm run electron:dev
   ```

`electron:dev` 会设置：

```powershell
VITE_DEV_SERVER_URL=http://localhost:5173
```

Electron 主进程仍会启动内置后端：

- 后端地址：`http://127.0.0.1:5278`
- Renderer 地址：`http://localhost:5173`

`electron/preload.js` 会把 renderer 内的相对 API 调用改写到后端：

- `fetch('/api/...')` -> `http://127.0.0.1:5278/api/...`
- `new EventSource('/api/...')` -> `http://127.0.0.1:5278/api/...`

## 生产模式

生产模式不依赖 Vite dev server。启动流程：

1. 主进程加载 `backend/index.js`，监听 `127.0.0.1:5278`。
2. 设置 `process.env.BACKEND_URL=http://127.0.0.1:5278`。
3. 启动本地前端静态服务，监听 `127.0.0.1:5277`。
4. 静态服务托管 `frontend/dist`。
5. 静态服务把 `/api` 代理到后端。
6. BrowserWindow 加载 `http://127.0.0.1:5277`。

如果 `frontend/dist` 不存在，主进程会回退创建窗口，但页面会显示前端文件缺失。

## 数据和日志目录

Electron 启动后会设置：

```js
process.env.BACKEND_DATA_DIR = path.join(app.getPath('userData'), 'data')
```

日志目录由 `logService` 决定：

- Electron 环境：`app.getPath('userData')/logs`
- 非 Electron 且 `LOG_DIR` 存在：`LOG_DIR`
- 开发环境：`backend/logs`
- 其它生产环境：系统用户目录下的应用数据目录

## 自动更新

打包环境下会启用 `electron-updater`：

- 正式版 Feed URL：`http://firmware.undersilicon.cn/control-panel/stable/`
- 测试版 Feed URL：`http://firmware.undersilicon.cn/control-panel/test/`
- 首页系统信息中可以切换是否接收测试版更新。
- 更新设置保存到 Electron `userData/update-settings.json`。
- 下载完成后弹窗询问是否重启安装。
- 开发环境不检查更新。

## 窗口参数

主窗口：

- 宽度：1200
- 高度：800
- preload：`electron/preload.js`
- `contextIsolation: false`

## 退出清理

应用退出前会关闭：

- 内置后端 server
- 本地前端静态 server

后端模块本身的 `SIGINT` 清理只在独立 Node 进程收到信号时执行，Electron 关闭 server 不等同于触发该分支。
