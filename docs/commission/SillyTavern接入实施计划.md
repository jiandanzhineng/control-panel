# SillyTavern（酒馆）接入实施计划

> 本文件是接任务者的**技术蓝图**。配套的委托说明见同目录 [委托说明.md](./委托说明.md)——先读它，再读本文件。

## 0. 目标一句话

让 SillyTavern（酒馆）里的 NPC 角色，通过 LLM function calling 自主调用本控制面板（UnderSilicon, 以下简称 CP）连接的真实电击设备。

## 1. 架构总览

```
酒馆浏览器 UI
  └─ UI 扩展 (third-party/under-silicon)
       ├─ registerFunctionTool('trigger_shock')   ← LLM 自主调用
       ├─ registerFunctionTool('stop_shock')      ← LLM 可主动停
       └─ 设置面板（设备ID/上限/冷却/总开关）
            │  fetch 同源，无 CORS
            ▼
酒馆 Node 后端
  └─ Server Plugin (server-plugins/under-silicon)
       └─ POST /api/plugins/under-silicon/shock
            ├─ 安全钳制（电压/时长/冷却）  ← 不可被 LLM 绕过
            ├─ 调度 stop（REST 无自动停止，必须自己补）
            └─ 转发 → http://127.0.0.1:5278/api/devices/:id/operations/start
                                        │
                                        ▼ MQTT /drecv/:id → 物理设备
```

### 为什么分两层（UI 扩展 + server plugin）

1. **CORS**：浏览器直接 `fetch('http://localhost:5278')` 跨端口会触发预检；走酒馆 Node 后端代理 = server-to-server，彻底无 CORS。
2. **安全**：钳制逻辑放在 Node 侧，LLM 改不了浏览器内存也绕不过。
3. **REST 无自动停止**：CP 的 REST operations 路径没有 bridge 的 1–10s 自动停止（见 [REST_设备控制指南.md](../guides/REST_设备控制指南.md) 第七节注意事项第 4 条），必须在 server plugin 自己 `setTimeout` 调 stop。

## 2. 组件清单

### A. CP（control-panel）侧——基本不动

REST 接口已现成可用，**无需改 CP 代码**。只需确认：
- `POST /api/devices/:id/operations/start` body `{params:{voltage}}` 能触发电击（DIANJI 类型）。
- `POST /api/devices/:id/operations/stop` 能停止。

可选小改：给 REST operations 加 auto-stop 兜底（对齐 bridge 行为），消除"server plugin 崩溃则电击不停"风险。这是**可选项**，不影响 MVP。

### B. 酒馆 Server Plugin——`server-plugins/under-silicon/index.js`

路由（挂在 `/api/plugins/under-silicon/` 下）：

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/shock` | 主入口。body `{voltage, durationMs}` |
| POST | `/stop` | 立即停止（急停） |
| GET | `/devices` | 代理 `GET 127.0.0.1:5278/api/devices`，给 UI 列设备 |
| GET | `/status` | 探活，返回 CP 是否在线 + 当前配置 |

`/shock` 内部流程：
1. 读配置（deviceId、voltageMax、durationMax、cooldownMs、enabled）。
2. 若 `enabled=false` → 拒绝。
3. 钳制：`voltage = clamp(voltage, 0, voltageMax)`、`durationMs = clamp(durationMs, 200, durationMax)`（默认 50 / 5000ms）。
4. 冷却：距上次触发不足 cooldownMs → 拒绝（防 LLM 刷屏）。
5. 转发 `POST 127.0.0.1:5278/api/devices/:id/operations/start` `{params:{voltage}}`。
6. `setTimeout(durationMs)` 后调 `.../operations/stop`（REST 无自动停止，必须自己补）。
7. 记日志（时间、电压、时长、来源）。
8. 返回 `{ok, voltage, durationMs}` 给 LLM。

配置持久化到 plugin data 目录的 JSON。端口/host 可配（打包 Electron 是 5278，裸跑 backend 是 3000）。

### C. 酒馆 UI 扩展——`public/extensions/third-party/under-silicon/`

文件：
- `manifest.json`——`loading_order`、`hooks.activate`。
- `index.js`：
  - `registerFunctionTool('trigger_shock')`，参数 `{intensity:number(0-100), durationMs:number(200-5000)}`，action 里 `fetch('/api/plugins/under-silicon/shock')`。
  - `registerFunctionTool('stop_shock')`——LLM 可主动停。
  - 注册 `/shock-off` 斜杠命令（人工急停，绕过 LLM）。
  - 设置面板：总开关、设备ID下拉（从 `/devices` 拉）、voltageMax 滑块、durationMax、cooldownMs。
- `settings.html`、`style.css`。

functionTool 的 `description` 要写清楚，例如：

> "控制连接到用户身体的真实电击设备。当剧情中 NPC 对用户施加电击/电罚/刺激时调用。intensity=强度0-100，durationMs=时长毫秒。非必要时不要调用。"

描述质量决定 LLM 调用时机是否自然。

## 3. 安全设计（LLM 自主调用必须做）

1. **硬上限**：voltageMax 默认 50、durationMax 默认 5000ms，在 server plugin（Node）强制，LLM 改不了。
2. **冷却**：默认 3000ms 间隔，防 LLM 连续刷。
3. **总开关**：UI 扩展一键禁用所有触发。
4. **急停**：`/shock-off` 斜杠命令 + `stop_shock` 工具，任何时刻可停。
5. **日志**：每次触发落盘，可审计。
6. **deviceID 绑定**：只对设置里选定的设备生效，不暴露任意设备。

## 4. 风险与注意

- **REST 无自动停止**：必须 server plugin 自己 `setTimeout` 调 stop。若 server plugin 崩溃，可能电击不停 → 建议再加一道兜底：CP 侧给 REST operations 加 auto-stop（对齐 bridge），或依赖设备固件层最长运行时间。
- **会话不抢占**：REST 路径无会话，酒馆和现有插件 UI / 游戏可并存；若都触发电击会叠加，需文档说明。
- **CP 未运行**：server plugin 探活失败时给 LLM 返回友好错误，不让酒馆卡死。
- **模型支持**：functionTool 仅 Chat Completion 系（OpenAI/Claude/Gemini/Mistral），要在设置里提示用户开启"Enable function calling"。

## 5. 代码存放

建议在本仓库新建 `integrations/sillytavern/` 目录，放 server plugin + UI 扩展源码 + 安装说明（拷贝到酒馆对应目录）。这样和 CP 版本一起演进，以后能加自动安装脚本。

## 6. 落地步骤

1. 在 `integrations/sillytavern/` 下建骨架：server plugin `index.js` + UI 扩展 `manifest/index.js/settings.html`。
2. 写 server plugin：路由、钳制、冷却、stop 调度、设备代理。
3. 写 UI 扩展：functionTool 注册、设置面板、急停命令。
4. 写 `integrations/sillytavern/README.md`：安装步骤、配置、安全说明。
5. 可选：给 CP 后端 REST operations 加 auto-stop 兜底（对齐 bridge）。

## 7. 参考资料锚点

### CP 侧（本仓库）
- REST 接口总览：[docs/guides/REST_设备控制指南.md](../guides/REST_设备控制指南.md)——**必读**。
- 设备操作路由：`backend/routes/devices.js:298`（`POST /api/devices/:id/operations/:operationKey`）。
- 设备服务：`backend/services/deviceService.js:392`（`executeDeviceOperation`）。
- 电击能力定义：`backend/devices/capabilities.js:1-17`（`shock.start` 写 `{voltage, shock:1}`）。
- DIANJI 设备类型：`backend/devices/registry.js:48-57`（operations `start`/`stop`）。
- 端口：Electron 打包后 backend 5278、前端代理 5277（`electron/main.js:399,432`）；裸跑 backend 默认 3000。
- shanbay-shock 插件（电击触发的参考实现，走的是 WS bridge 而非 REST）：`backend/plugins/shanbay-shock/detector.js:381`。

### 酒馆侧（外部文档/仓库）
- UI 扩展编写指南：https://docs.sillytavern.app/for-contributors/writing-extensions/
- Function Calling：https://docs.sillytavern.app/for-contributors/function-calling/
- Server Plugins：https://docs.sillytavern.app/for-contributors/server-plugins/
- STscript：https://docs.sillytavern.app/usage/st-script/
- 最近似先例（关键词扫描→设备）：https://github.com/SpicyMarinara/SillyTavern-Lovense
