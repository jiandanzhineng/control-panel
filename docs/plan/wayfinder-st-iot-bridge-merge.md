# Wayfinder: st-iot-bridge 以独立窗口形式并入 control-panel

## Destination

产出一份**关键决策清单**（handoff spec）：窗口形态、接口契约、代码归属。不写完代码，不定文件级迁移细节。

## Notes

- 主仓：`E:\smart\project\control-panel`，develop 分支
- 副仓：`E:\smart\project\st-iot-bridge`，含 SillyTavern 插件 + 一份 control-panel 副本（`integrations/control-panel/`）
- 已定大方向：设备相关功能归主客户端，酒馆插件继续注入酒馆，玩法/面板以某种形式进入主客户端
- 会话风格：HITL，每票一次只解一个

## Decisions so far

- [window-mode](#window-mode-独立窗口-vs-iframe-游戏-vs-两步走) — 游戏化独立窗口：小念作为游戏列表一项，manifest 声明 `windowMode: 'external'`，启动时开独立 BrowserWindow，复用 DeviceAPI/deviceMap/退出信号等游戏机制
- [device-config-ownership](#device-config-ownership-设备映射--ai-配置归属) — 设备映射归主客户端（现成 deviceMap），AI/安全/运行时配置全塞小念内部 localStorage（共 10 项），酒馆插件零配置
- [tavern-bootstrap](#tavern-bootstrap-酒馆与插件的自动安装入口) — 主客户端是唯一产品入口，小念内按钮触发酒馆/插件安装；安装器代码全在主客户端；只在线下载酒馆（后续可能加 Cloudflare 中转）；插件源码作为主客户端数据模板注入酒馆
- [hud-fate](#hud-fate-sillytavern-聊天页-hud-保留简化删除) — 保留完整 HUD 14 模块，但 HUD 只是渲染器，所有数据经酒馆插件转发到主客户端；急停 3 入口沿用现状；手动控制两边都要；安全协议两边都弹
- [provision-migration](#provision-migration-provision-服务迁移是否仍独立进行) — **暂缓执行**，详见 [`2026-08-04-provision-migration-deferred.md`](2026-08-04-provision-migration-deferred.md)

## Tickets

### window-mode: 独立窗口 vs iframe 游戏 vs 两步走

Blocked by: —
Status: resolved
Type: Grilling

#### Question

st-iot-bridge 面板以什么形态出现在主客户端？
- A. HTML 游戏（iframe，零架构改动）
- B. 独立窗口（Electron BrowserWindow，体验好但要改主进程）
- C. 两步走（先 iframe 跑通，再升级独立窗口）

#### Answer

**选 D. 游戏化独立窗口**——把「小念」做成游戏列表里的一项，启动时开独立 BrowserWindow 而非 iframe。

关键事实：
- 用户要求小念**以游戏方式连接后端**（DeviceAPI/WS）→ 复用现有游戏机制
- 面板实际是两样东西：**小念**（一直开着）+ **酒馆配置**（低频，嵌入主客户端设置页）
- 小念独立存在，不依赖酒馆 → 是主客户端一等功能
- 主客户端一直运行，玩酒馆时也在后台 → 小念挂在主客户端上合理

**最终形态**：
- **小念** → 游戏列表中的一项，启动时开独立 BrowserWindow（一直开）
- **酒馆配置** → 嵌入主客户端设置页（低频）

**实现机制**：
- `backend/games/xiaonian/` 作为一个游戏目录，含 `index.html` + `manifest.windowMode: 'external'` 声明
- 主客户端游戏启动逻辑加分支：识别 `windowMode: 'external'` → 开独立 BrowserWindow 而非 iframe
- 窗口内仍通过 `device-api-bridge.js` 连 WS `/bridge`，与其他游戏**完全一致的设备调用方式**
- 复用游戏的 deviceMap / params / 退出信号 / 急停 / 设备复位机制

**解耦**：主客户端不需要懂"AI 精灵"概念，只识别 `manifest.windowMode`。将来其他大型面板（如音乐可视化、多设备仪表盘）也可用同样机制。

**主客户端改动**：
- 游戏启动逻辑加 `windowMode: 'external'` 分支（~50 行）
- Electron 主进程加 external game window 管理（~100 行）
- 无需新增 SpiritAPI/精灵载体等抽象概念

**st-iot-bridge 仓相应改动**：
- `ui/dashboard.html` + `ui/extension.js` 重写为小念游戏（去酒馆依赖，改用 DeviceAPI）
- `ui/settings.html` 改写为主客户端设置页
- `src/games/*.js` 状态机浏览器化（去 Node require，改挂 window）
- `manifest.json` 声明 `windowMode: 'external'`、所需设备能力、参数

---

### hud-fate: SillyTavern 聊天页 HUD 保留/简化/删除

Blocked by: —
Status: resolved
Type: Grilling

#### Question

酒馆聊天页面里的 HUD 浮窗（实时显示设备状态/急停/最近动作）在合并后还保留吗？
- 保留：HUD 仍由酒馆插件渲染，数据从主仓 HTTP 拉
- 简化：HUD 只留急停按钮
- 删除：用户切到主客户端独立窗口看状态

#### Answer

**保留完整 HUD（14 个模块），但 HUD 只是渲染器**——所有数据/操作通过酒馆插件转发到主客户端，HUD 本身零逻辑零配置。其他尽量与项目已有实现保持一致。

**4 项关键决策**：

1. **HUD 保留完整 14 个模块**（Q1-A）：DevicePicker / SafetyConfig / Provisioning / ManualControls / SharedControl / AiAutonomy / ToolChannel / InputStatus / RuntimeTelemetry / OutputRail / DisplayControls / SafetyDialog 等全保留。

2. **急停 3 入口全保留**（Q2）：HUD 急停按钮 + `/stop-all` + `/shock-off` 斜杠命令，全部沿用现状 HTTP 转发路径。新架构下急停底层：
   - 酒馆 HUD → 酒馆插件 → HTTP 转发 → 主客户端 `/api/tavern-plugin/stop` → 设备归零
   - 小念窗口 → DeviceAPI WS → 主客户端 → 设备归零（现成机制）
   - 保留关键安全机制：本机访问无需 token、设备读回验证、多设备遍历、降级 fallback

3. **手动控制两边都要**（Q3-C）：酒馆 HUD 和小念窗口都有手动控制按钮。酒馆侧通过插件转发到主客户端；小念侧通过 DeviceAPI。

4. **安全协议两边都弹**（Q4-C）：小念首次启动弹一次（写小念 localStorage）；酒馆 HUD 首次启动也弹一次（写酒馆 localStorage）。两处独立，互不影响。

**解耦原则**：
- HUD 只是**渲染器**——所有数据（设备列表、传感器值、安全上限、配网状态）都从主客户端拉
- 酒馆插件只做**转发**——HTTP 收到 HUD 请求 → 转发给主客户端 → 返回响应
- HUD/插件都**不存任何业务状态**——配置在小念 localStorage，设备状态在主客户端
- 酒馆插件零 npm 依赖（除了 SillyTavern 自带的 express）

**与项目已有实现保持一致**：
- HUD 急停底层逻辑沿用现有 `src/routes/stop.js` 的多设备遍历 + 读回验证模式
- HUD 渲染逻辑沿用现有 `ui/extension.js` 的 14 个 render 函数模式
- 酒馆斜杠命令沿用现有 `/stop-all` `/shock-off` 注册方式

---

### device-config-ownership: 设备映射 + AI 配置归属

Blocked by: window-mode
Status: resolved
Type: Grilling

#### Question

设备映射（逻辑设备→物理设备）和 AI 配置（服务商/Key/模型）由谁管？
- 主客户端：用户在主客户端统一配置，酒馆插件只是转发调用
- 酒馆插件：保留现有配置界面，主客户端不感知
- 拆分：设备映射归主客户端，AI 配置归酒馆插件

#### Answer

**全部塞进小念游戏内部，用 localStorage 持久化**。主客户端只管设备映射（游戏 deviceMap 现成机制），其他配置主客户端零感知。

**配置清单**（小念内部 localStorage，共 10 项）：

```js
{
  // 必填（首次启动向导）
  aiProvider: 'openai',           // 选服务商
  aiApiKey: '...',                // 填 Key
  aiModel: 'gpt-4-turbo',         // 选模型
  safetyConsentVersion: 'v1',     // 确认安全协议

  // 可调（设置页，有默认值）
  voltageMax: 50,                 // 电压上限 0-100
  strengthMax: 50,                // 强度上限 0-255
  maxDurationMs: 5000,            // 单次时长上限
  cooldownMs: 3000,               // 冷却时间
  shockEnabled: true,             // 电击开关
  strengthEnabled: true,          // 强度开关
}
```

**硬编码**（不让用户碰）：
- minDurationMs=200 / realtimeReportMs=250 / idleReportMs=1000 / reportHoldMs=60000 / deepIdleReportMs=5000 / deepIdleHoldMs=300000 / gameTickMs=250 / aiAutonomy='active'

**归属表**：

| 配置 | 归属 | 理由 |
|---|---|---|
| 设备映射 | 主客户端（游戏 deviceMap） | 现成机制 |
| AI 配置 | **小念内部 localStorage** | 自包含 |
| 安全上限 + 同意 | **小念内部 localStorage** | 自包含 |
| 运行时参数 | **小念内部硬编码** | 用户不用碰 |
| 酒馆插件 | **零配置** | 只转发 LLM 调用 |

**关键好处**：
- 主客户端零侵入——不加全局配置存储/界面
- 真正解耦——小念完全自包含，换掉/删除不影响主客户端
- 符合游戏模型——游戏 params 本来就是游戏自己管
- localStorage 简单可靠，10 项小数据完全够

**代价/接受**：
- 换电脑/清缓存会丢配置——用户接受（重新走一遍首次向导成本低）
- 主客户端无法集中管理多个 AI 游戏的 Key——目前只有小念一个，将来再说

---

### ~~plugin-repo-future: st-iot-bridge 仓保留范围与命名~~ (已取消)

Blocked by: hud-fate
Status: open
Type: Grilling

#### Question

~~合并后 st-iot-bridge 仓只剩什么？改名吗？~~

**取消原因**（tavern-bootstrap resolve 后）：用户明确"现在不讨论 st-iot-bridge 还保留什么，重点是融入主客户端"。st-iot-bridge 仓不再作为独立产品存在，"保留什么/改名"不再是有意义的问题。仓本身的处理（归档/删除）是执行阶段的琐事，不需要 wayfinder 决策。

#### Answer

（已取消）

---

### tavern-bootstrap: 酒馆与插件的自动安装入口

Blocked by: —
Status: resolved
Type: Grilling

#### Question

用户拿到主客户端后，酒馆和插件如何装上？

**用户场景**：
- 用户下载 control-panel 主客户端，装完**没有**酒馆和插件
- 主客户端里有个功能，可以**自动安装酒馆和插件**
- 如果用户**已经装好酒馆**，主客户端可以**注入插件**到现有酒馆

**关键事实**：
- 小念和酒馆是**独立玩法**（Q2-B）——小念不依赖酒馆也能用
- 酒馆 LLM 配置在酒馆里，跟主客户端无关
- 酒馆插件零配置，只转发 function calling 给主客户端

**待决策**：
- 主客户端的「安装酒馆/插件」功能界面长什么样（独立菜单？小念内部？）
- 酒馆安装器 + 离线包 + 版本清单放在哪（主客户端仓 vs 独立仓）
- 已装酒馆的探测与注入流程
- 酒馆版本更新策略（用户自己更新 vs 主客户端协助）

#### Answer

**主客户端是用户唯一产品入口**，集成酒馆安装与插件注入能力。st-iot-bridge 仓不再作为独立产品存在——其功能全部融入主客户端。

**5 项关键决策**：

1. **入口位置**：**小念窗口内部**加按钮「启用酒馆联动」→ 跳转安装流程（Q1-B）。低频操作，不占主窗口侧边栏。

2. **酒馆探测**：**自动扫描 + 手动指定**（Q2-C）。先扫常见路径（`~/SillyTavern`、`~/Documents/SillyTavern`、Program Files），扫不到让用户文件选择器指定。

3. **版本更新**：**用户自己更新**（Q3-A）。主客户端不管酒馆版本升级，只检测当前版本是否兼容（≥1.18.0），不兼容就提示。

4. **离线包策略**：**只在线下载**（Q4-B）。安装时从 GitHub codeload 下载酒馆 zip（~100MB）。后续可能加 Cloudflare 中转加速（user 提及）。不再支持发行包带离线 zip。

5. **安装器代码归属**：**全部搬到主客户端仓**（Q5-A）。st-iot-bridge 不再带安装器。具体落地：
   - `backend/services/tavernInstallService.js` —— 酒馆下载/校验/安装/插件注入
   - `backend/routes/tavernInstall.js` —— HTTP 端点供小念调用
   - `backend/data/sillytavern-release.json` —— 酒馆版本清单（含 SHA-256）
   - `backend/services/tavernPluginTemplate/` —— 插件源码模板（要从 st-iot-bridge 的 `index.js` + `src/` + `ui/` 改造而成）

**关键架构**：

```
主客户端
  ├─ 游戏列表
  │   └─ 小念 (windowMode: external)
  │       ├─ localStorage 配置（AI/安全/上限）
  │       └─ 按钮「启用酒馆联动」
  │           ↓ 调主客户端 HTTP
  │           /api/tavern-install/detect    （扫已装酒馆）
  │           /api/tavern-install/download  （下载酒馆）
  │           /api/tavern-install/inject    （注入插件到指定酒馆）
  │
  └─ 酒馆插件源码（作为数据存在主客户端内）
      └─ backend/services/tavernPluginTemplate/
          ├─ index.js         （SillyTavern 插件入口）
          ├─ src/             （HTTP 路由，转发 LLM 调用到主客户端）
          └─ ui/              （HUD）
```

**解耦原则**：
- 主客户端**不包含** st-iot-bridge 的运行时——插件源码只是**模板数据**，注入到酒馆后跑在酒馆进程里
- 主客户端只通过 HTTP（插件调过来）和 WS（小念连过来）与外部通信
- 酒馆插件源码改造后只依赖**主客户端的 HTTP API**，不依赖任何 npm 包（除了 SillyTavern 自带的 express）

---

### provision-migration: provision 服务迁移是否仍独立进行

Blocked by: window-mode
Status: resolved (暂缓执行)
Type: Research

#### Question

之前定的「provision 服务搬到主仓」在独立窗口方案下还需要单独做吗？

#### Answer

**已完成调研，但暂缓执行**。用户决定 provision 服务整个不搬，单独文档处理，晚点另行处置。

**结论**：不能整体直搬，需要"挑增量合入"——直搬 5 个文件，改主仓 4 处，不搬 ESP32 固件和副仓其他 service 整文件。

**详细方案与风险点**：见 [`docs/plan/2026-08-04-provision-migration-deferred.md`](2026-08-04-provision-migration-deferred.md)。

**调研报告**：`.tmp/provision-migration-research.md`。

## Not yet specified

- 独立窗口的设备映射传递机制（IPC vs URL query vs 共享状态文件）—— 等 window-mode 定了再具体化
- 酒馆插件调起独立窗口的 HTTP 接口契约 —— 等 window-mode + device-config-ownership 定了再具体化
- 玩法状态机浏览器化的具体改造路径 —— 等 window-mode 定了再具体化

## Out of scope

- 文件级迁移清单（哪些文件搬哪去、改成什么样）—— 留给执行阶段
- WS 协议扩展（加 action）—— 已确认现有 action 够用，不再讨论
- controller-hub 迁移 —— 已决定不搬，插件内部自管
