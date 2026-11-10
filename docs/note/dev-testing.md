# 开发与测试环境

## 一键检查

仓库根目录 `npm run check`：后端 Jest、前端 Node 测试、前端类型检查/生产构建。CI 用 Node 22 最新补丁版；前端 TypeScript 测试用 Node 内置类型擦除，建议本地 Node 22.18+。

- 后端单测：`npm --prefix backend test -- --runInBand`；前端：`npm --prefix frontend test`；构建：`npm run build:frontend`。
- 只跑某套件可追加文件名，如 `npm --prefix backend test -- --runInBand pushup-detection-output.test.js`。

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
- **移动 worktree 要先断 junction**：`git worktree move` 遇 junction 会 Permission denied；用 `Move-Item` 更危险——会顺着 junction 把主仓 `node_modules` 内容掏空到新位置，还可能因 `default_app.asar` 等文件被锁而搬一半。正确做法：先 `cmd /c rmdir <wt>\node_modules` 断开 junction，再 `git worktree move`（或 `Move-Item` 后手动修 `.git`/`gitdir` 指向），最后重建 junction。删 worktree 同理，用 `tools/worktree/safe_remove.py`（先断联接再交给 git）。
