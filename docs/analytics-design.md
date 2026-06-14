# OpenPanel 埋点接入设计文档

> 状态:待审阅 · 最后更新 2026-06-09

## 1. 背景与目标

为 control-panel 项目接入 [OpenPanel](https://openpanel.dev) 产品分析,了解用户实际使用情况:哪些功能被使用、用了多少设备、玩了哪些游戏、固件升级使用率等。

本项目有**三种运行形态**,埋点方案需全部兼容:

| 形态 | 前端 serve 方式 | 前端运行环境 |
|------|----------------|-------------|
| Electron 桌面端 | `electron/main.js` 起本地 server serve `frontend/dist` | Chromium 渲染进程 |
| 服务器 / Termux | `npm run dev:all` → Vite dev server(5173) | 用户浏览器 |
| 本地开发 | 同上 | 开发者浏览器 |

三种形态共用同一份前端代码,均为标准浏览器环境,因此采用统一的 `@openpanel/web` SDK,**无需分叉**。

## 2. 关键决策

| 决策项 | 结论 |
|--------|------|
| SDK | `@openpanel/web`(客户端 SDK) |
| 凭证 | Client ID + **write 权限 Secret**(见 §3,该 Secret 非密、可公开) |
| API 地址 | `https://op.shiroha.tech/api`(SDK 拼成 `/api/track`) |
| 隐私开关 | **默认开启,不做开关**(方案 3) |
| 初始化位置 | `frontend/src/main.ts` |
| 封装 | 统一封装到 `frontend/src/analytics.ts` |
| 失败处理 | 所有埋点调用 try/catch 包裹,**埋点失败绝不影响主功能** |

## 3. 安全说明:为什么这个 Secret 可以公开

| 凭证 | 权限 | 能做 | 能否公开 |
|------|------|------|---------|
| **Client ID** | — | 标识 client | ✅ 可公开 |
| **write Secret**(本项目用的这把) | write | 只能写入埋点 | ✅ 可公开(见下) |
| read / root Secret(本项目未使用) | read/root | 读取 / 导出 / 删除数据 | ❌ 绝不公开 |

### 为什么必须带 Secret

排查发现:该自托管实例(`op.shiroha.tech`)**未开放纯 CORS 白名单上报**,客户端仅凭 Client ID 上报会被拒(`401 Invalid cors or secret`)。必须同时携带 client-secret 才能成功入库。这与 OpenPanel 云端默认行为不同。

### 为什么这把 Secret 可以随客户端分发

正常情况下 Secret 不应进客户端,但本项目特殊:

1. **它是 write 权限**:只能写入埋点,**不能读取 / 导出 / 删除**任何数据。已实测 `read` 权限被拒(`Client is not allowed to export`)。
2. **客户端藏不住密钥**:Electron / 前端分发给用户,任何密钥都能被解包,无论是否写进源码。
3. **泄露的最坏后果**:他人用它灌入垃圾埋点污染看板。可控、可通过 revoke 重置,且不会泄露任何已收集数据。

因此采用方案 B:**write Secret 直接写入前端代码**,并在代码注释中标明其非密性质。

> ⚠️ 如需读取数据(看用户提交的埋点):另在看板生成 **read 权限** client,其 Secret 仅放本地 / 服务器环境变量,**绝不进仓库 / 前端**。

## 4. 多形态兼容处理

同一份前端代码跑在三种形态下,需处理三个差异点。

### 4.1 不能用 `import.meta.env.DEV` 区分开发者与真实用户

Termux / 服务器模式跑的是 `npm run dev:all`(Vite dev server),此时 `import.meta.env.DEV === true`。若用 `DEV` 标志禁用埋点,会**误伤真实的 Termux 用户**。

✅ 方案:不用 `DEV` 一刀切。默认开启上报;开发者本机调试时手动设 `localStorage.setItem('op_disable', '1')` 关闭。

### 4.2 版本号注入不依赖 Electron 主进程

Electron 可从主进程 `app.getVersion()` 取版本,但服务器模式没有主进程。

✅ 方案:用 Vite `define` 在构建期注入版本号(读 `package.json` 的 `version`),两种形态统一可取,不依赖 Electron。

### 4.3 增加 `runtime` 维度区分来源

每个事件附加 `runtime: 'electron' | 'web'` 维度,看板中可区分桌面端用户与服务器 / Termux 部署用户的行为差异。

✅ 检测方式:`navigator.userAgent` 是否包含 `Electron`。

## 5. 埋点清单

所有事件自动附加全局维度:`runtime`(electron/web)、`app_version`。

### 5.1 第一层:页面浏览(PageView)

在 vue-router 全局后置钩子统一上报,一处覆盖全部 9 个页面。hash 模式(`createWebHashHistory`)下手动上报比 SDK 自动 `trackScreenViews` 更可控。

上报内容:路由 `name` + `meta.title`(已有中文标题)。

覆盖页面:首页 / 设备管理 / 批量固件升级 / 自动化测试 / 游戏管理 / 当前游戏 / 游戏配置 / 网络设置 / 日志管理。

### 5.2 第二层:关键业务动作(Track Event)

| 事件名 | 触发位置(文件:函数) | 关键属性 | 价值 |
|--------|----------------------|---------|------|
| `app_launch` | `main.ts` 初始化时 | app_version, runtime | DAU / 启动量 |
| `game_start` | `GameStartConfigView.vue` 启动游戏(startBusy 处) | game_id, 设备数 | **核心**:哪些游戏被玩 |
| `game_stop` | `GameCurrentView.vue:stopGame` / `GameListView.vue:stopCurrent` | game_id | 配对使用时长 |
| `game_upload` | `GameListView.vue:onFileSelected` | — | 用户是否自传游戏 |
| `game_delete` | `GameListView.vue:deleteGame` | game_id | — |
| `device_connect` | `DevicesView.vue` 设备上线 / 连接 | device_type | **核心**:设备数量与型号 |
| `firmware_upgrade` | `FirmwareBatchUpgrade.vue:startBatchUpgrade` | 批量数量 | 固件升级使用率 |

## 6. 实现结构

### 6.1 封装层 `frontend/src/analytics.ts`

对外暴露:

- `initAnalytics()` —— 在 `main.ts` 调用一次:初始化 SDK(传 Client ID)、探测 runtime、注册 router 后置钩子上报 PageView、上报 `app_launch`。
- `track(event, props?)` —— 业务点调用。内部:检查 `op_disable` 开关 → 合并全局维度(runtime / app_version)→ try/catch 调 SDK。

设计原则:业务代码只多一行 `track('game_start', { ... })`;SDK 调用集中在此文件,失败静默不影响主流程。

### 6.2 改动文件清单

| 文件 | 改动 |
|------|------|
| `frontend/package.json` | 新增依赖 `@openpanel/web` |
| `frontend/vite.config.ts` | `define` 注入 `package.json` 版本号 |
| `frontend/src/analytics.ts` | **新增**:封装层 |
| `frontend/src/main.ts` | 调用 `initAnalytics()` |
| `frontend/src/views/GameStartConfigView.vue` | `game_start` |
| `frontend/src/views/GameCurrentView.vue` | `game_stop` |
| `frontend/src/views/GameListView.vue` | `game_stop` / `game_upload` / `game_delete` |
| `frontend/src/views/DevicesView.vue` | `device_connect` |
| `frontend/src/views/FirmwareBatchUpgrade.vue` | `firmware_upgrade` |

Client ID 与 write Secret 直接写在 `analytics.ts`(均可公开,理由见 §3):
- Client ID:`1fc33a58-9762-4aab-908f-be2c16abe0ca`
- write Secret:`sec_b9789b2940a6313d20aa`(仅可写埋点,不能读数据)
- apiUrl:`https://op.shiroha.tech/api`

## 7. 验收

1. `npm run build:frontend` 构建通过(`vue-tsc` 无类型错误)。
2. Electron 与浏览器两种形态启动后,看板能收到 PageView 与 `app_launch`,且 `runtime` 维度正确区分。
3. 触发各业务动作,看板出现对应事件。
4. 断网或上报失败时,主功能(启动游戏、设备连接等)不受影响。

## 8. 待实现(分阶段)

- **阶段一**:接入封装层 + PageView + `app_launch`,跑通看板有数据。
- **阶段二**:补齐第 5.2 节全部业务事件。
