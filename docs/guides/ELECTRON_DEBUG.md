# Electron 调试速查

调试分两条独立通道，别搞混：

| 通道 | 调什么 | 用什么 |
|------|--------|--------|
| **CDP**（Chrome DevTools Protocol） | 渲染进程：Vue 前端页面、`<webview>` 内置浏览器。控制台 / 网络 / DOM / 执行 JS | 远程调试端口 `9224`（dev 脚本） |
| **Node inspector** | 主进程：`electron/main.js` 里的 IPC、后端启动、自动更新 | `--inspect` 端口 `5858` |

> 一句话：**页面出问题看 CDP，主进程/IPC/启动逻辑出问题看 Node。**

---

## 0. 本项目的开发环境怎么启动

正常开发（不带调试）直接启动 Electron 即可：

```bash
# 会自动启动/复用 vite dev server（http://localhost:5173），等待可用后再开 Electron
npm run electron:dev
```

后端由 electron 自己拉起（`main.js` 里 `startBackendThenWindow`，监听 5278），
所以开发时一般不用单独起后端。纯浏览器开发可用 `npm run dev:all`；
要单独起后端：`npm run dev:backend`。

启动脚本一览（`package.json`）：

| 脚本 | 作用 |
|------|------|
| `dev:frontend` | 起 vite（5173） |
| `electron:dev` | 启动/复用 vite（5173），再起 electron 加载 dev 页面 |
| `electron:prod` | 起 electron，加载打包好的 `frontend/dist` |
| `electron:debug` | = `electron:dev` + **开 CDP 端口 9224** |
| `electron:debug:prod` | = `electron:prod` + **开 CDP 端口 9222** |

---

## 1. CDP 调试（渲染进程 / 页面）

### 第一步：带调试端口启动 electron

```bash
# 自动启动/复用 vite，并开启 Electron CDP 端口
npm run electron:debug
```

验证端口开了：浏览器打开 `http://127.0.0.1:9224/json`，
能看到一个 JSON 页面列表（每个页面/webview 一个条目）就说明成功。

### 第二步：连上去调试，两种方式

**方式 A — 用 Chrome 自带的 inspector（人工调）**
在任意 Chrome 地址栏输入 `chrome://inspect` → 点 `Configure` 加入
`127.0.0.1:9224` → 下方 `Remote Target` 会列出 electron 里的页面 →
点 `inspect` 就弹出一个完整的 DevTools 面板，和平时按 F12 一模一样。

**方式 B — 让 AI（Kiro）用 chrome-devtools 工具连（自动调）**
需要把 `chrome-devtools` MCP 配成连接模式，指向 9224。
详见文末「附录：让 AI 连上 9224」。连上后 AI 能读控制台、抓网络请求、
取 DOM 快照、执行 JS、跑性能 trace。

### 最省事：直接在代码里弹 DevTools

不想连端口，只想自己看，在 `electron/main.js` 的 `createWindow()` 里加：

```js
win.webContents.openDevTools();   // 启动就自动弹出 F12 面板
```

---

## 2. Node 侧调试（主进程 / IPC / 后端启动）

`main.js` 的逻辑跑在 Node 里，CDP 看不到，要用 Node inspector。

### 启动

```bash
# 开发模式 + 主进程调试端口 5858
node tools/electron-dev.js --inspect=5858

# 想让它在第一行代码就断住、等你连上再跑，用 --inspect-brk
node tools/electron-dev.js --inspect-brk=5858
```

### 连上去，两种方式

**方式 A — Chrome**
地址栏输入 `chrome://inspect` → 找到 `Remote Target` 里的 Node 目标 →
点 `inspect`，就得到一个专门调 Node 的 DevTools（能打断点、看调用栈、
看变量）。

**方式 B — VS Code**
`.vscode/launch.json` 加一个 attach 配置：

```json
{
  "type": "node",
  "request": "attach",
  "name": "Attach Electron Main",
  "port": 5858
}
```

先用上面的命令启动 electron，再在 VS Code 里按 F5 选这个配置连上，
就能在 `main.js` 里直接下断点（比如 `registerUpdateIpcHandlers`、
`startBackendThenWindow`）。

---

## 3. 同时调页面 + 主进程

两个端口一起开即可：

```bash
node tools/electron-dev.js --inspect=5858 --remote-debugging-port=9224
```

`chrome://inspect` 里会同时出现 Node 目标（主进程）和页面目标（渲染进程）。

---

## 4. 调试打包后的 exe

打包后的 `.exe` 还是 Chromium，同样支持。启动时带参数即可：

```bash
"C:\安装路径\UnderSilicon.exe" --remote-debugging-port=9222
```

然后用第 1 节的方式连 9222。前提：`main.js` 没有针对 `app.isPackaged`
关掉调试（本项目没关，默认可用）。

> 生产版**不建议**在代码里默认常开调试端口——任何本地程序都能借端口
> 控制应用。要留调试口，用「设了环境变量才开」的开关方式，不要写死。

---

## 附录：让 AI（Kiro）连上 9224

当前 `chrome-devtools` MCP 是「自启一个独立 Chrome」模式（配置里带
`--userDataDir=C:/chrome-mcp-profile`），**连不到 electron**。

要让 AI 连 electron，把 MCP 改成连接模式，给 args 加一行：

```jsonc
// C:/Users/46907/.claude.json → mcpServers.chrome-devtools.args
[
  "chrome-devtools-mcp@latest",
  "--browserUrl=http://127.0.0.1:9224"   // 加这行；连接模式下可去掉 userDataDir
]
```

步骤：
1. 先 `npm run electron:debug` 把 electron 和 9224 端口起起来；
2. 关掉当前占用 `C:/chrome-mcp-profile` 的 Chrome 实例；
3. 改完 `.claude.json` **重启会话**（MCP 配置重启才会重新加载）；
4. 之后 AI 调 `list_pages` 就能看到 electron 里的页面，开始调试。

> 更灵活的做法：不动现有 chrome-devtools，另加一个专用 server（如
> `electron-cdp`）指向 9224，两个并存互不干扰。


---
