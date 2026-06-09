# 游戏配置与运行时改造方案

> 目标：让「启动前配置（设备映射 + 参数）」和「游戏运行」对齐最新 design
> （`game-runtime-unified-design.html`）。承载方式 = 全屏纯 iframe + URL query 注入，
> 外部第三方网页经后端代理同源化。不考虑向后兼容，直接改成新格式。

## 0. 根因回顾

本次 diff 把游戏从「后端 embedded JS」改造成「HTML manifest 自包含」，但前端两个页面
和后端部分路由没跟上，导致：

1. **无法选设备映射**：前端读 `game.requiredDevices`，后端 manifest 给的是 `game.devices`。
2. **无法设参数**：前端读 `parameterSchema`/`parameter`，后端给的是 `params`。
3. **运行页是旧注入式**：`GameCurrentView` fetch 已废弃的 `/api/games/current/html`（恒 404），
   且 `/start` 返回的 `gamePath/deviceMap/params` 没被前端使用。

## 1. 数据契约（统一以 manifest 为唯一来源）

后端 `gameService` 已从 `index.html` 的 `<script id="game-manifest">` 解析出：

```
{ id, name(title), description, version, gamePath, folder,
  devices: [{ id, capabilities[], required }],
  params:  [{ key, type, default, label, min?, max?, enum? }] }
```

**前端全面改用 `devices` / `params` 字段，删除对 `requiredDevices` / `parameterSchema`
/ `parameter` 的引用。** 不再做字段别名兼容。

字段映射约定（前端内部使用）：
- 逻辑设备 ID = `device.id`（如 `sensor`/`motor`），展示名也用 `id`（manifest 无 name）。
- 参数标签 = `param.label`，键 = `param.key`。

### 1.1 游戏来源（本地 + 第三方统一）

游戏文件来源两种，**manifest 解析统一由后端负责**，前端配置页对两者体验一致：

| 来源 | manifest 解析 | gamePath |
|------|------|------|
| **本地游戏**（`/games/*`） | `gameService` 扫描 `index.html` 的 `<script id="game-manifest">` | `/games/<folder>/index.html` |
| **第三方网页** | 后端 fetch 该 URL，提取同一个 `<script id="game-manifest">` 内联块 | 经代理同源化后的 URL（见 §2 / §3.3） |

- 第三方游戏也须遵循 `game-manifest` 内联约定，否则配置页无法自动列出设备/参数。
- 后端新增 `GET /api/games/external/meta?url=...`：抓取第三方 URL → 解析 manifest →
  返回与本地游戏一致的 `{ id, name, description, version, devices, params, gamePath, external:true }`。
- 复用 `gameService.extractManifestFromHtml`（已存在）。

## 2. 承载与配置传递（已定方案）

- **承载**：游戏运行页 = 全屏纯 iframe。iframe `position:fixed; inset:0; border:0`
  占满视口，配 `allow="fullscreen"`，视觉等同独立网页。控制台保留一个浮层「停止」按钮。
- **配置注入**：URL query。iframe src =
  `<游戏URL>?deviceMap=<encodeURIComponent(JSON)>&params=<encodeURIComponent(JSON)>`。
  `device-api-bridge.js:204-213` 已实现读取这两个 query 并在 `connect()` 前注入，
  **Bridge 时序无需改动**。
- **外部网页同源化（按需转发反代）**：配置页填外部 URL，后端做**前缀代理**而非一次性全抓。
  - iframe src = `/games/proxy/<外部域名>/<路径>?deviceMap=...&params=...`。
  - 游戏页加载子资源（`<script src="game.js">`、css、图片等）→ 浏览器按相对路径请求
    `/games/proxy/<外部域名>/game.js` → 后端**收到请求再转发**到第三方对应文件，原样返回。
  - **多文件按需转发，不预先爬取**：游戏要哪个文件，后端就转发哪个（用户问题的正解）。
  - **轻量版范围**：只处理同域名下相对资源，适配自包含小游戏（如本地 `pressure-edging` 那种
    单页 + 引一个 Bridge 脚本）。复杂跨域站点 / cookie / 绝对 URL 改写不在本期目标。
  - 同源化后绕开混合内容 / LNA / 证书三关。外部网页需自引
    `<script src="/bridge-api/device-api-bridge.js">`。
- **外部网页安全提示**：**不做 URL 白名单**。改为在配置页点「启动」时，若目标是外部 URL，
  先弹确认框（`ElMessageBox.confirm`）：
  > 您即将进入外部网页（`<目标URL>`），该页面不受硅基之下控制，请注意安全。
  用户确认后再跳运行页。`<目标URL>` 动态填实际地址。

## 3. 改动清单

### 3.1 前端 `GameStartConfigView.vue`（设备映射 + 参数，重写数据层）

- `requiredDevices` 计算属性改为读 `game.devices`，字段 `id`→逻辑ID、`capabilities`、`required`。
- `schemaEntries` 改为读 `game.params`（数组，`key/type/default/label/min/max/enum`），
  删除 `parameterSchema`/`parameter` 分支。`name` 展示用 `label`。
- `deviceMappings` / `rdKey` / `updateMapping` 改用 `id` 作为逻辑键（不再用 `logicalId`/`name`）。
- `getAvailableDevicesForRole` / `typeSupportsCapabilities` 逻辑保留（能力过滤不变）。
- `loadAll()`：删除对 `/meta` 字段差异的合并兼容；**删除 `/config`、`/config/reset`
  两个后端接口的调用**，改为 **localStorage 默认配置**（见下）。
- **默认配置（localStorage）**：
  - 点「启动」时把当前 deviceMap + params 存到 `localStorage["gameConfig:<gameId>"]`。
  - `loadAll()` 优先读 localStorage 回填；无则用 manifest 的 `param.default`
    和「能力匹配的第一个在线设备」。
  - 回填设备映射时**校验物理设备当前是否在线**，离线的忽略并回退默认，避免回填已拔掉的设备。
  - 「恢复默认配置」按钮改为纯前端：清除该 game 的 localStorage 项 + 重置为 manifest 默认。
  - **Electron 兼容性**：打包后控制台前端走 `http://127.0.0.1:5277`（`electron/main.js` 起的
    本地前端服务器，非 `file://`），是固定 http origin，**localStorage 持久化有效**，重启 app 仍在。
    `file://` 那条仅为 dist 丢失时的兜底，实际不会走到。
- `start()`：成功后改为 `router.push({ name:'game_current', query:{ id, deviceMap, params } })`，
  把规范化后的 deviceMap/params 经路由 query 带到运行页。

### 3.2 前端 `GameCurrentView.vue`（重写为全屏 iframe）

- 删除 DOMParser 注入、`executeScripts`、EventSource 包装等全部旧逻辑。
- 从路由 query 读 `id`/`deviceMap`/`params`，用 `gameService` 的 `gamePath` 拼 iframe src：
  `gamePath?deviceMap=...&params=...`（内置游戏）或 `/games/proxy?url=...&deviceMap=...`（外部）。
- 模板：全屏 `<iframe :src allow="fullscreen">` + 浮层「停止游戏」按钮。
- 「停止游戏」：卸载 iframe（src 置空）→ WebSocket 断开 → 后端 180s 兜底 close（design §10）。
  可选：调一个轻量 `/api/games/stop-current` 仅用于前端状态，真正安全停机靠 Bridge close。

### 3.3 后端

- `routes/games.js`：
  - `/start` 保留（已正确规范化 deviceMap）。可精简为只做校验 + 回显，因配置改走 query。
  - **新增** `GET /api/games/external/meta?url=...`：抓取第三方 URL → 解析 manifest →
    返回与本地游戏一致的结构（含 `external:true`、代理后的 gamePath）。复用
    `gameService.extractManifestFromHtml`。
  - **新增** `GET /games/proxy/<外部域名>/<路径>`：**前缀式按需反向代理**（同源化）。
    收到请求时按前缀还原目标 URL，转发到第三方并原样返回响应。
    **不预先全抓、不做 URL 白名单**（按用户决定，靠前端启动前提示兜底安全）。
    轻量版：处理同域名相对资源即可。
  - **不新增** `/:id/config`、`/config/reset`：默认配置改用前端 localStorage。
- `routes/gameplay.js`、`/api/games/current/html`：运行页不再使用，可删或保留 404。
- `bridgeService.js`：运行期映射、双向路由、close 兜底已完整，业务逻辑无需改。
  - **新增 WS Origin 校验**（`verifyClient`）：**只放行控制台同源**（本机 host）。
    外部游戏走 `/games/proxy` 同源化后 Origin 即控制台自身，不受影响。
    作用：阻止用户误开的恶意网页静默连本地 Bridge 操作真实设备。

## 4. 安全停机与生命周期（对齐 design §10）

- 关 iframe / 切走 / 刷新 → WS `close` → `bridgeService.closeSession` 对所有映射物理设备
  调 `invokeDeviceClose`（电机归零、停电击）。已实现，确认链路连通即可。
- 下一个游戏启动时，前一会话设备自动 close（design §10），由新 WS init 触发。

## 5. 验证

- `npm run build`（前端）确保 TS 通过。
- 后端 `npm test` 跑现有 games/bridge 相关用例。
- 手动：启动 `pressure-edging` → 确认设备映射表可勾选、参数表可填、iframe 全屏加载、
  虚拟设备下发指令经 `/api/virtual-devices/:id/commands` 可见、停止后 close 下发。

## 6. 已确认的决策

- **游戏来源**：本地与第三方统一由**后端解析 manifest**（第三方经 fetch 抓取 + 同一内联块），
  配置页对两者体验一致。
- **多文件第三方游戏**：**前缀式按需反向代理**（收到前台请求再转发），不预先全抓；
  轻量版只处理同域名相对资源。
- **外部网页**：不做 SSRF 白名单；启动前弹「您即将进入外部网页…该页面不受硅基之下控制，
  请注意安全」确认框。
- **配置持久化**：前端 localStorage 存默认配置，删除后端 `/config` 路由依赖；
  回填时校验设备在线状态。
- **WS Origin 校验**：加上，只放行控制台同源；外部游戏走代理同源化不受影响。

