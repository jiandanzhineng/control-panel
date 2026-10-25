# 玩法载体统一方案设计文档

> 状态：待审阅 · 最后更新 2026-07-03

## 1. 背景与目标

当前面板里「游戏」与「插件」在用户眼中是两个独立系统：侧边栏有「游戏管理」「当前游戏」「插件」「浏览器」四个入口，各有各的列表页、配置页和运行界面。但按 `CONTEXT.md` 的领域语言，游戏和插件本就是同一上位概念「**玩法（Play）**」的两种**玩法载体（Play Carrier）**——游戏的载体是面板 iframe，插件的载体是加载真实网站的 webview。二者在后端早已统一（同一 bridge、同一 DeviceAPI 协议、同一「全局唯一活跃玩法」约束，见 `adr/0004`、`adr/0005`）。

**目标**：把这层「概念上统一、前端上分裂」的错配收敛掉，让用户看到的也是「一类玩法 + 一个浏览器」，而不是两个系统。

具体要达成：

- 侧边栏从 4 项收敛为 **「玩法」+「浏览器」两项**。
- 游戏和插件成为「玩法」下的**两种类型**，共用同一个列表页（玩法库）。
- **统一一个配置页**，按玩法类型决定启动动作。
- 运行壳（导航栏 + iframe/webview）抽成公共组件，消除三份重复。

本方案三期一并落地。

## 2. 现状诊断：分裂只在前端表面层

统一之所以成立，是因为分裂只发生在前端的 4 个表面处，后端与协议层无需改动。逐项列出（均已读代码确认）：

| 层 | 游戏 | 插件 | 浏览器 | 重复性质 |
| --- | --- | --- | --- | --- |
| 侧边栏入口 | 游戏管理 + 当前游戏 | 插件 | 浏览器 | 4 个入口指向同一类事 |
| 列表页 | `GameListView.vue` | `PluginListView.vue` | — | 卡片布局各写一份 |
| 配置页 | `GameStartConfigView.vue` | `PluginConfigView.vue` | — | 设备映射 + 参数表单两份，约 90% 相同 |
| 运行壳 | `GameCurrentView.vue`（iframe + 停止 FAB） | `PluginRunView.vue`（toolbar + webview） | `BrowserView.vue`（toolbar + webview） | 导航/停止逻辑写了三遍 |
| 停止路径 | `POST /api/games/stop-current` | `window.pluginApi.stopCurrent()` + webview 销毁 | — | 两套停止入口 |

两个关键事实决定了统一是「收敛表层」而非「重构架构」：

1. **两个配置页几乎同构**。`GameStartConfigView` 与 `PluginConfigView` 的设备映射表格、参数表单、`recomputeBlocking` 校验、localStorage 回填逻辑高度重复——因为 game manifest 和 plugin manifest 的 `devices`/`params` 字段本就对齐（见 `PLUGIN_SYSTEM.md` §4）。差异只在**数据源**（`/api/games/:id` vs `/api/plugins/:id`）和**启动动作**（跳 iframe 运行页 vs `POST /activate` 后跳 webview 运行页）。插件配置页当初就是「照抄游戏配置页改一份」（`PLUGIN_SYSTEM.md` §7 明确记录）。

2. **`BrowserView` 已经能「在网页里发现玩法并接入设备」**。它轮询 `/api/games/external/meta?url=`，命中则显示 banner「检测到可控制硬件的游戏」，点击跳 `game_config`。也就是说「浏览网页 → 发现玩法 → 接入设备运行」这条链路已存在，插件本质上就是「浏览器 + 命中 matchUrls 的检测脚本」。这为第三期提供了现成骨架。

## 3. 关键决策

| 决策项 | 结论 | 理由 |
| --- | --- | --- |
| 侧边栏 | 收敛为「玩法」+「浏览器」两项 | 「当前游戏」是运行态（全屏覆盖层），不该常驻侧边栏；游戏/插件归一为「玩法」 |
| 玩法类型 | 游戏、插件是「玩法」下的 `carrierType`，不是两个系统 | 对齐 `CONTEXT.md` 领域语言（玩法载体） |
| 列表页 | 合并为一个「玩法库」，卡片按类型区分 | 消除 `GameListView`/`PluginListView` 重复 |
| 配置页 | **合并为一份**，按 `carrierType` 决定数据源与启动动作 | 两份已 90% 同构，合并收益（改一处、行为一致）大于抽象成本 |
| 运行壳 | 抽 `PlayCarrierShell` 公共组件（导航栏 + 停止 + slot 承载 iframe/webview） | 消除三份 toolbar/停止重复 |
| bridge / DeviceAPI | **不动**，保持游戏侧与 detector 侧两份独立实现 | `PLUGIN_SYSTEM.md` §6 已论证：合并会为插件重构跑得好的游戏代码，得不偿失 |
| 后端 session 逻辑 | **不动**（唯一性顶旧 / 退出信号复位 / 60 秒宽限） | 该层本就是统一的，见 `adr/0005` |

> **偏离既有决策的一处**：`PLUGIN_SYSTEM.md` §7 当初为快速落地插件，刻意「照抄配置页、不抽公共组件」。现在两份都已稳定，合并配置页的收益已反超抽象成本。本方案**主动推翻这一条前端取舍**——但严格限定在前端视图层，`PLUGIN_SYSTEM.md` §6「不抽 DeviceAPI 公共层」的后端/协议取舍继续保留。

## 4. 统一后的信息架构

### 4.1 侧边栏

从 8 项（首页 / 设备管理 / 游戏管理 / 当前游戏 / 插件 / 浏览器 / 网络设置 / 日志管理）中，把「游戏管理」「当前游戏」「插件」三项合并为一项「**玩法**」，「浏览器」保留：

```
首页
设备管理
玩法        ← 原「游戏管理」+「当前游戏」+「插件」
浏览器      ← 保留
网络设置
日志管理
```

- 运行态入口（原「当前游戏」）不再进侧边栏。玩法运行页是 z-index 覆盖层，靠「启动」进入、靠「停止」退出。
- 若某个玩法正在运行，玩法库页顶部显示一条「当前运行：XXX ｜ 返回运行页 / 停止」的提示条，替代原「当前游戏」侧边栏项。

### 4.2 路由

复用「玩法」语义，游戏与插件收敛到 `/plays` 前缀；旧路径保留重定向（沿用现有 `/gamelist`→`/games` 的做法）。

| 新路由 | 组件 | 说明 |
| --- | --- | --- |
| `/plays` | `PlayLibraryView`（合并 Game/Plugin 两个 List） | 玩法库，游戏 + 插件卡片 |
| `/plays/:type/:id/config` | `PlayConfigView`（合并两个 Config） | `type` = `game` \| `plugin`，决定数据源与启动动作 |
| `/plays/game/current` | `GameRunView`（原 `GameCurrentView`，改用 `PlayCarrierShell`） | iframe 运行壳 |
| `/plays/plugin/:id/run` | `PluginRunView`（改用 `PlayCarrierShell`） | webview 运行壳 |
| `/browser` | `BrowserView`（改用 `PlayCarrierShell`） | 保留 |

重定向：`/games`→`/plays`、`/games/current`→`/plays/game/current`、`/games/:id/config`→`/plays/game/:id/config`、`/plugins`→`/plays`、`/plugins/:id/config`→`/plays/plugin/:id/config`、`/plugins/:id/run`→`/plays/plugin/:id/run`；旧 `/gamelist`、`/services` 现有重定向不变。

### 4.3 玩法类型模型

前端引入一个轻量 `carrierType` 判别，不落后端（后端接口不变）：

```ts
type CarrierType = 'game' | 'plugin';

interface PlayItem {
  carrierType: CarrierType;
  id: string;
  title: string;
  description?: string;
  version?: string;
  devices?: PlayDevice[];   // 与 manifest.devices 对齐
  params?: PlayParam[];     // 与 manifest.params 对齐
  // plugin 专属
  homeUrl?: string;
  // game 专属
  gamePath?: string;
  externalUrl?: string;
}
```

玩法库页并发拉 `/api/games` 与 `/api/plugins`，各自打上 `carrierType` 后合并渲染。配置页据 `route.params.type` 走对应分支。

## 5. 实施方案（三期一并落地）

三期按依赖顺序推进：先抽运行壳打底（第一期），再合并列表/配置（第二期），最后把浏览器接入统一发现（第三期）。

### 5.1 第一期：抽运行壳 + 合并侧边栏

**目标**：消除三份运行壳重复，收敛侧边栏。纯前端、不碰后端与 DeviceAPI。

新增 `frontend/src/components/PlayCarrierShell.vue`，把三个运行页共有的部分抽出：

- 顶部导航栏：后退 / 前进 / 刷新 / 地址显示（只读或可输入，由 prop 控制）/ 停止按钮。
- 停止行为：通过 `onStop` 回调交给外层（游戏调 `/api/games/stop-current`，插件调 `pluginApi.stopCurrent()` + 销毁 webview，浏览器无停止）。
- 主体用默认 slot 承载 `<iframe>` 或 `<webview>`——**壳不感知载体类型**，只提供框架与导航事件绑定（`did-navigate` 等）。

props 草案：

```ts
defineProps<{
  mode: 'iframe' | 'webview' | 'browser';  // 决定是否显示停止、地址栏是否可输入
  address: string;
  canBack: boolean;
  canForward: boolean;
  stopping?: boolean;
}>();
// emits: back / forward / reload / navigate / stop
```

改造三处消费方：

- `GameCurrentView.vue` → 用 `PlayCarrierShell mode="iframe"`，slot 放 iframe，`onStop` 走 `stop-current`。
- `PluginRunView.vue` → `mode="webview"`，slot 放带 `:preload` 的 webview，`onStop` 走 `pluginApi.stopCurrent()`。
- `BrowserView.vue` → `mode="browser"`，slot 放 webview，地址栏可输入，无停止；保留其「外部玩法检测 banner」逻辑（第三期扩展它）。

侧边栏改造（`App.vue`）：删「游戏管理」「当前游戏」「插件」三项，加一项「玩法」指向 `/plays`；「浏览器」保留。

> 第一期即可独立发布：路由可暂时维持旧路径，`PlayCarrierShell` 先落地、三个页面先接入，风险最低。

### 5.2 第二期：统一玩法库列表 + 统一配置页

**目标**：合并列表页与配置页，落地 `/plays` 路由与 `carrierType` 模型。

1. **`PlayLibraryView.vue`**（替代 `GameListView` + `PluginListView`）：
   - 并发 `GET /api/games` + `GET /api/plugins`，各打 `carrierType` 合并。
   - 卡片统一样式，用 tag 区分「游戏 / 插件」；插件额外显示目标域名（`hostOf(homeUrl)`）。
   - 保留游戏侧的「刷新 / 加载外部玩法 / 删除」和插件侧的「刷新」动作（按 `carrierType` 条件显示）。
   - 顶部「当前运行」提示条（见 §4.1）。
   - 点卡片 → `/plays/:type/:id/config`。

2. **`PlayConfigView.vue`**（合并两个 Config）：
   - 结构以 `GameStartConfigView` 为基（它更完整：高级参数折叠、tooltip、强行启动）。
   - `loadAll()` 按 `type` 选数据源：`game` 用 `/api/games/:id`（或 external meta）；`plugin` 用 `/api/plugins/:id`。设备列表 `/api/devices`、能力表 `/api/device-capabilities` 两类共用。
   - 设备映射表格、参数表单、`recomputeBlocking`、localStorage 回填**完全共用一份**。localStorage key 按 `type` 区分命名空间（沿用现有 `gameConfig:` / `pluginConfig:` 前缀）。
   - `start()` 按 `type` 分支：
     - `game`：`router.push` 到 `/plays/game/current`，deviceMap/params 走 query 注入（现有做法）。
     - `plugin`：先弹「插件启动确认」框（现有 HTML 提示），`POST /api/plugins/:id/activate`，再跳 `/plays/plugin/:id/run`。
   - 外部游戏的「外部网页提示」确认框与插件确认框合流为「进入外部载体确认」的同一段逻辑（文案按 type 微调）。

3. 挂新路由 + 旧路径重定向（见 §4.2）。删除 `PluginConfigView.vue`、`PluginListView.vue`、`GameListView.vue`（内容并入新组件）。

### 5.3 第三期：浏览器即统一玩法入口

**目标**：让「打开网页 → 接入设备」成为游戏/插件/外部游戏共同的入口，体验彻底合一。

扩展 `BrowserView` 已有的检测逻辑：`onNavigated` 后除了查 `/api/games/external/meta`，再比对当前 URL 是否命中任一已安装插件的 `matchUrls`（列表来自 `/api/plugins`，前端做通配匹配）。

- 命中外部游戏 → banner「检测到可接入设备的玩法」→ 点击跳 `/plays/game/external/config?externalUrl=`（现有）。
- 命中插件 matchUrls → 同一条 banner → 点击跳 `/plays/plugin/:id/config`。

两种命中共用同一条 banner 组件与文案，用户视角只有一件事：**这个网页能接入设备，点此运行**。

> 第三期是纯增量、可选。不做也不影响前两期的统一收益；做了则「浏览器」和「玩法库」两个入口在功能上打通（一个是「主动挑玩法」，一个是「逛到哪触发到哪」）。

## 6. 明确不做的事

- **不合并 bridge / DeviceAPI 的两份实现**。游戏侧 `device-api-bridge.js`（浏览器 WebSocket）与 detector 侧 Node `ws` 版是刻意分开的（`PLUGIN_SYSTEM.md` §6），合并会为插件重构稳定的游戏代码。本方案只统一视图层。
- **不改后端**。`/api/games/*`、`/api/plugins/*` 接口、`active-plugin.json` 配置信箱、bridge session 唯一性/复位/60 秒宽限（`adr/0004`、`adr/0005`）全部不动。玩法库并发拉两个现有列表接口即可。
- **不改 electron 主进程的 webview 注入逻辑**（`will-attach-webview` 校验 detectorPath + matchUrls、销毁发退出信号）。运行壳只是换了 Vue 组件外壳，webview 元素与 `:preload` 绑定方式不变。
- **不引入后端层面的「玩法」统一模型**。`carrierType` 只是前端聚合两个数据源的判别字段。

## 7. 影响文件清单

**第一期**

- 新增：`frontend/src/components/PlayCarrierShell.vue`
- 改：`frontend/src/views/GameCurrentView.vue`、`PluginRunView.vue`、`BrowserView.vue`（接入 shell）
- 改：`frontend/src/App.vue`（侧边栏三项 → 一项「玩法」）

**第二期**

- 新增：`frontend/src/views/PlayLibraryView.vue`、`PlayConfigView.vue`
- 改：`frontend/src/router/index.ts`（`/plays` 路由 + 旧路径重定向）
- 改：`GameCurrentView.vue` / `PluginRunView.vue` 的路由名与返回目标（指向 `/plays`）
- 删：`GameListView.vue`、`PluginListView.vue`、`GameStartConfigView.vue`、`PluginConfigView.vue`（并入新组件）

**第三期**

- 改：`frontend/src/views/BrowserView.vue`（matchUrls 检测 + 统一 banner）

> 后端、`electron/`、`backend/` 目录**零改动**。

## 8. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 合并配置页后，游戏/插件某类专属校验被漏掉 | 以 `GameStartConfigView`（更完整）为基底，逐条比对 `PluginConfigView` 的差异（插件确认框、无「高级参数」时的降级）后并入 |
| 运行壳抽象过度，webview 特有属性（`partition`/`allowpopups`/`:preload`）被吞掉 | shell 只提供导航栏与 slot，webview/iframe 元素本体仍由各页面在 slot 内声明，特有属性保留在页面侧 |
| 旧路径外链/书签失效 | 全部旧路由保留 `redirect`，与现有 `/gamelist`→`/games` 一致 |
| 三期一起改动面大 | 三期解耦：第一期(壳+侧边栏)、第二期(列表+配置)、第三期(浏览器发现)各自可独立编译发布，按期验收 |

回滚：每期均为纯前端改动，`git revert` 对应提交即可，无数据迁移、无后端状态变更。

## 9. 验收清单

- [ ] 侧边栏只剩「玩法」「浏览器」两个玩法相关入口，无「当前游戏」独立项。
- [ ] 玩法库页同时列出游戏与插件，卡片可区分类型；插件显示目标域名。
- [ ] 同一个配置页能配置并启动游戏与插件；设备映射、参数校验、localStorage 回填、强行启动均正常。
- [ ] 游戏 iframe 运行、插件 webview 运行、内置浏览器三处共用 `PlayCarrierShell`，导航/停止行为与改造前一致。
- [ ] 插件启动仍走 `activate` + webview 销毁发退出信号；游戏停止仍走 `stop-current`；bridge 复位与「全局唯一玩法顶旧」不受影响。
- [ ] 旧路径 `/games`、`/plugins`、`/games/current` 等重定向到新 `/plays` 路由。
- [ ]（第三期）内置浏览器浏览到命中 matchUrls 的插件目标站或外部游戏时，弹同一条「可接入设备」banner，点击进入对应配置页。
- [ ] 登录态保留、冷却/上限/急停、断线宽限等既有插件安全行为全部回归通过。
