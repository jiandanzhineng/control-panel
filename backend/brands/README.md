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

- `deviceConnectionService` 新增 `brand` 传输类型（`VALID_TRANSPORTS`）。
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
  brandService.js       发现/连接/断开/控制编排 + 注册进 deviceService
  dglabConnection.js    郊狼连接适配器（transport adapter 接口）
  ycyConnection.js      役次元连接适配器（bridge / ble 双模式）
  discovery.js          设备发现（可达性探测 / BLE 扫描）
  protocols/
    dglab.js            郊狼 WebSocket 协议（帧构造 + DGLabSocketClient）
    ycy.js              役次元协议（IM/桥接消息 + BLE 帧构造 + 客户端/传输层）
  __smoke__.js          无依赖逻辑冒烟测试（node 直接运行）
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
cd backend && npm test          # 含 tests/brandDevices.test.js
```

## 扩展新品牌

1. 在 `protocols/` 增加协议构造文件（命令/帧 builder + 客户端或传输层）。
2. 在 `brandService.discover/connect` 中按 `brand` 分支接入。
3. 在 `devices/registry.js` 增加对应设备类型，其能力动作发出 `{ brand, cmd, ... }` 命令。
4. 在 `routes/brands.js` 的 `control` 动作表中登记高层动作。
