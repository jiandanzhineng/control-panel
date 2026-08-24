# 品牌设备接入（郊狼 DGLab / 役次元 YCY）

本目录在既有控制面板架构之上，扩展对 **郊狼（DGLab）** 与 **役次元（YCY / YOKONEX）**
两个品牌设备的支持：设备发现、连接管理与控制指令交互，使客户端能同时识别并操控两者。

协议均直接取自两品牌的公开 GitHub 仓库：

| 品牌 | 公开仓库 | 采用协议 |
| --- | --- | --- |
| 郊狼 DGLab | [open-toys-controller/open-DGLAB-controller](https://github.com/open-toys-controller/open-DGLAB-controller) | App「娱乐模式」本地 WebSocket 控制接口 |
| 役次元 YCY | [YCY-YOKONEX/YCY-YOKONEX-OpenSource](https://github.com/YCY-YOKONEX/YCY-YOKONEX-OpenSource) <br> [YCY-YOKONEX/API-bridge](https://github.com/YCY-YOKONEX/API-bridge) <br> [YCY-YOKONEX/PyDGLab-WS-for-YCY](https://github.com/YCY-YOKONEX/PyDGLab-WS-for-YCY) | IM `game_cmd` / API-bridge（WebSocket→IM）；BLE 直连（YSKJ_EMS_BLE / YSKJ_TOY_BLE） |

## 架构

品牌设备复用既有 `deviceConnectionService` 的 transport adapter 模型：

```
玩法 / Bridge / 设备映射
        │  DeviceAPI（init/invoke/writeProps/subscribe）
        ▼
deviceService.invokeDeviceCapability / publishDeviceMessage
        │  adapter.send(品牌命令)
        ▼
BrandConnection（dglabConnection / ycyConnection）
        │  翻译为协议帧
        ▼
DGLab App 娱乐模式 WebSocket  │  YCY API-bridge(WS→IM)  │  YCY BLE 直连
```

- `deviceConnectionService` 新增 `brand` 与 `brandBle` 传输类型（`VALID_TRANSPORTS`）。
- 新增三种设备类型（`backend/devices/registry.js`）：`DGLAB`、`YCY_EMS`、`YCY_TOY`。
  它们只负责发出“品牌命令”（如 `{ brand:'dglab', cmd:'setPattern', ... }`），真正的协议
  翻译由品牌连接适配器完成，从而与既有 Bridge、设备映射、玩法复位等能力无缝协作。
- `brandService` 统一编排发现 / 连接 / 断开 / 控制，并把连接注册进 `deviceService`，
  因此品牌设备会出现在 `/api/devices`、可被设备映射选中、可由玩法驱动。

## 郊狼（DGLab）协议

App 开启「娱乐模式」后暴露本地 WebSocket：`ws://<手机IP>:<端口>/1`（端口默认 60536）。
连接后发送 JSON：

```json
{ "cmd": "set_pattern", "pattern_name": "经典", "intensity": 100, "ticks": -1 }
{ "cmd": "stop_pattern" }
{ "cmd": "change_max_intensity", "delta_intensity": 10 }
{ "cmd": "set_background_pattern", "pattern_units": [{"pattern_intensity":50,"frequency":100}], "intensity":60, "ticks":-1 }
```

- `intensity`：0~100 整体强度。`ticks`：0=播放一遍后停止，-1=循环，正整数=持续 0.1×ticks 秒。
- 娱乐模式为单活动波形模型（波形同时作用于双通道）。如需 A/B 双通道独立强度与波形，
  应使用官方 `DG-LAB-OPENSOURCE` socket 协议（终端起 WebSocket 服务、App 扫码绑定），
  可在 `dglabConnection.js` 中扩展一个 `socket/bind` 连接模式复用同一 `send()` 翻译层。

发现：在 UI 填入手机 IP（娱乐模式界面显示），后端探测 `ws://host:60536/1` 可达性。

### 形态 1：原版 V2 蓝牙直连（Web Bluetooth）

针对**没有 App、只能通过 BLE 控制的原版郊狼 V2（Coyote / D-LAB ESTIM01 / YSKJ\*）**，
PC 客户端可在 **Windows / Linux / Android 的 Chromium** 上通过 Web Bluetooth 直接连接硬件，
无需手机 App 或中转服务。该路径复用了既有 BLUFI `ble` 传输链的 IPC 桥接模式，
新增一条平行的 `brandBle` 通道：

```
前端 BrandsView（点「蓝牙直连」）
   │  window.brandBleApi.connect()  →  navigator.bluetooth.requestDevice
   ▼
renderer: BrandBleClient（解析 GATT，缓存 handle）
   │  ipcRenderer.invoke('brandBle:connected', metadata)
   ▼
main: brandMainIntegration（ipcMain.handle）  →  deviceService.connectTransportDevice(..., { kind:'brandBle', send })
   │  sender.send('brandBle:command', ...)  →  renderer 写 GATT
   ▼
后端 brandService.attachWebBle(id, send)  →  注册 DGLabV2WebBleConnection
   │  高层 control 动作 → v2.toGattOps(品牌命令)  →  transportSend({ op, handle, payload })
   ▼
GATT 特征写入（电量 0x1500 / A·B 强度 0x1504 / A 波形 0x1505 / B 波形 0x1506）
```

**V2 GATT 协议要点**（`protocols/dglabV2.js`，纯函数便于测试与标定）：

- 服务基 UUID：`955Axxxx-0FE2-F5AA-A094-84B8D4F3E8AD`。服务短号 `0x180B`；电量挂在 `0x180A/0x1500`。
- 特征：
  - `PWM_AB2`（0x180B/0x1504）— A/B 双通道总强度。硬件范围 0–2047，App 显示值 = S/7。
  - `PWM_A34`（0x180B/0x1505）— 通道 A 波形；`PWM_B34`（0x180B/0x1506）— 通道 B 波形。
  - 波形三段：X(5bit 0–31) / Y(10bit 0–1023) / Z(5bit 0–31)，频率 = X + Y。
- **字节序为小端（little-endian）**，与 `coyote2.py` 参考实现一致。
- ⚠️ **标定提示**：官方文档与 `coyote2.py` 在 `PWM_AB2` 的 A/B 位排布上不一致
  （文档 bit 10–0 = A、21–11 = B；参考实现 A = data>>13、B = (data>>2)&0x3FF）。
  模块以 `packStrength(..., layout)` 支持两种布局（`'official'` / `'coyote2'`），**默认 `'coyote2'`**，
  实际下发前需用真机校准并切换 `DGLAV2_STRENGTH_LAYOUT` 环境变量（见下方）。

UI 入口：郊狼 tab 内「连接方式」可选择 **App 娱乐模式（WebSocket）** 或 **蓝牙直连（Web Bluetooth）**。
蓝牙直连下实时读取电量并在控制面板显示。

> 注意：macOS 的 Chromium 对 Web Bluetooth 受限，原版 V2 在 macOS 上通常仍需借 App「娱乐模式」WebSocket；
> 蓝牙直连在 Windows / Linux / Android 客户端上可用。

普通用户视角的连接与标定步骤见 **[V2-WEBBLE-GUIDE.md](./V2-WEBBLE-GUIDE.md)**。

## 役次元（YCY）协议

提供两条外部控制路径：

### 1) API-bridge（推荐，无需蓝牙）
[YCY-YOKONEX/API-bridge](https://github.com/YCY-YOKONEX/API-bridge) 将 WebSocket/HTTP 指令
翻译为腾讯 IM 的 `game_cmd`。控制以“指令 ID”触发 App 内已配置玩法；全局停止指令为 `_stop_all`。

```json
{ "type": "login", "uid": "game_5", "token": "..." }
{ "type": "sendCommand", "commandId": "player_hurt" }
{ "type": "sendCommand", "commandId": "_stop_all" }
```

连接码格式为 `UID 空格 Token`（`parseConnectCode` 解析）。发现：填入桥接服务地址探测连通性。

### 2) BLE 直连（YSKJ_EMS_BLE / YSKJ_TOY_BLE）
经 `noble` 直连设备，原始下发强度/通道/波形（无需 App 中转）。依据开放协议文档的数值范围与
通道语义构造 GATT 帧：

- 电击器 `YSKJ_EMS_BLE`：通道 A/B，强度 0–276，波形 1–17。
- 玩具/电机 `YSKJ_TOY_BLE`：电机 A/B/C，速度 0–20，模式 1–4。

> 说明：开放蓝牙仓库给出的是协议总览与数值范围；本实现据此构造了信封
> （`0xAA + 命令 + 通道 + 值(LE) + 校验和 + 0x55`）与数值映射。具体命令 opcode 与
> GATT UUID 需以对应固件 / 开放蓝牙仓库为准，集中在 `protocols/ycy.js` 顶部的常量区，
> 便于按机型校准。

发现：BLE 扫描并按广播名关键字（`YCY`/`YOKONEX`/`YSKJ`/`役次元`）过滤。

## 文件结构

```
backend/brands/
  index.js              模块入口（init）
  brandService.js       发现/连接/断开/控制编排 + 注册进 deviceService（含 webble 路径）
  dglabConnection.js    郊狼连接适配器（transport adapter 接口）
  ycyConnection.js      役次元连接适配器（bridge / ble 双模式）
  webBleConnection.js   原版 V2 蓝牙直连适配器（brandBle transport，send 经 IPC 写 GATT）
  discovery.js          设备发现（可达性探测 / BLE 扫描）
  protocols/
    dglab.js            郊狼 WebSocket 协议（帧构造 + DGLabSocketClient）
    dglabV2.js          原版 V2 BLE 协议（UUID / 强度 / 波形 / GATT 操作纯函数）
    ycy.js              役次元协议（IM/桥接消息 + BLE 帧构造 + 客户端/传输层）
  __smoke__.js          无依赖逻辑冒烟测试（node 直接运行）
electron/ble/
  brandDeviceClient.js  渲染进程 V2 GATT 客户端（镜像 BleDeviceClient，连接 D-LAB ESTIM01 / YSKJ*）
  brandMainIntegration.js  主进程 brandBle:* IPC 桥接（镜像 mainIntegration）
frontend/src/web-ble/
  brandBle.ts           封装 window.brandBleApi 的前端模块
```

## REST 接口

前缀 `/api/brands`：

- `GET  /status` — 支持列表与已连接设备
- `GET  /discover?brand=dglab&host=...` — 发现（役次元见 README 参数）
- `POST /connect` — 连接（`{ brand, ... }`）
- `GET  /` — 已连接品牌设备列表
- `POST /:deviceId/control` — 高层控制（`{ action, ... }`）
- `POST /:deviceId/disconnect` — 断开

通用设备能力（shock/strength）也可经既有 `POST /api/devices/:id/capabilities/:cap/actions/:action`
触发，品牌设备同样适用（设备类型层会翻译为品牌命令）。

## 测试

```bash
# 无依赖逻辑测试（协议/翻译/设备类型集成）
node backend/brands/__smoke__.js

# 项目 jest 套件（需先 npm install）
cd backend && npm test          # 含 tests/brandDevices.test.js / dglabV2.test.js / webBle.test.js
```

环境变量：

- `DGLAV2_STRENGTH_LAYOUT`：`'official'` 或 `'coyote2'`（默认 `'coyote2'`），用于切换 V2 强度位排布，
  真机标定后调整。

## 扩展新品牌

1. 在 `protocols/` 增加协议构造文件（命令/帧 builder + 客户端或传输层）。
2. 在 `brandService.discover/connect` 中按 `brand` 分支接入。
3. 在 `devices/registry.js` 增加对应设备类型，其能力动作发出 `{ brand, cmd, ... }` 命令。
4. 在 `routes/brands.js` 的 `control` 动作表中登记高层动作。
