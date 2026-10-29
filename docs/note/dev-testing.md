# 开发与测试环境

## 一键检查

仓库根目录 `npm run check`：后端 Jest、前端 Node 测试、前端类型检查/生产构建。CI 用 Node 22 最新补丁版；前端 TypeScript 测试用 Node 内置类型擦除，建议本地 Node 22.18+。

- 后端单测：`npm --prefix backend test -- --runInBand`；前端：`npm --prefix frontend test`；构建：`npm run build:frontend`。
- 只跑某套件可追加文件名，如 `npm --prefix backend test -- --runInBand pushup-detection-output.test.js`。

## 本机依赖缓存

- 本机根 `node_modules` 的部分包目录联接到 `tmp/digital-human-debug-deps/node_modules`；该目录是当前调试依赖缓存，清理前须先重新安装根依赖。前后端依赖仍分别在各自目录。
- Windows 的 Electron `dist/resources/default_app.asar` 被占用时，`npm ci` 可能报 `EBUSY`；不要为此终止无关 Electron。下载可用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，正常启动必须同时具备 Electron 包元数据、`path.txt` 和完整 `dist`。

## 前端构建

- 组件按需导入用 `unplugin-vue-components@29.2.0`，配置在 `frontend/vite.config.ts`。保留 Element Plus 全局样式以维持主题覆盖顺序，图标由各组件显式导入。

## 后端写盘

- 设备上报保存窗口 1 秒，异步写临时文件后替换设备记录；日志每 100ms 批量追加。后端退出、日志下载与诊断上传会等待队列完成。

## 测试约定

- Electron 客户端页面与游戏测试用 CDP，不用 Computer Use 测 Electron。
- 视觉验证可用 BrowserOS neo；前端 Vite 端口 5174，后端 `npm run dev:backend`。
- 独立远程工作区路由 `/remote-game`。

## git worktree

- worktree 不带 node_modules：把主仓的 `node_modules`、`play-registry/node_modules` 用目录联接（`New-Item -ItemType Junction`）链进来，`backend`/`frontend` 的 node_modules 要单独 `npm install`。
