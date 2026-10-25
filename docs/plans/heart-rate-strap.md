# 心率带设备支持 + heartRate 能力（实施方案）

日期：2026-10-08　分支：`worktree-feat-heart-rate`（基于 `feat/remote-session-mode`）

## 目标

1. 新能力 `heartRate`：玩法可 `readValue/onValue('heartRate')` 读实时心率（bpm）。
2. 新设备类型 `HRM`（显示名「心率带」），能力 `['heartRate']`。
3. 后端 noble 直连任何**标准 BLE 心率带**（GATT `0x180D` / `0x2A37`），不限品牌。
4. 用 `tools/hrm-c3-mock`（ESP32-C3，COM17，广播名 `HRM-Virtual`）联调。

## 数据约定（设备 data 属性）

| 属性 | 含义 |
| --- | --- |
| `heart_rate` | 心率 bpm，整数。**0 = 当前无有效读数**（未接触 / 超时无数据） |
| `hr_status` | `ok` / `no_contact` / `stale`（5s 未收到测量帧） |
| `hr_contact` | 1/0，设备不支持接触检测时不写 |
| `rr_interval` | 最近一个 RR 间期，毫秒（帧里没有就不写） |
| `energy` | 能量消耗 kJ（帧里没有就不写） |
| `battery` | 电量 %（有 0x180F 时） |

`heartRate` 能力：`value.source = {op:'prop', key:'heart_rate'}`，`watch:['heart_rate']`；
事件 `heartRateChange`（prop heart_rate）、`statusChange`（prop hr_status）。无动作，无需 stop。
monitorSpec：heart_rate(bpm, 图表) / hr_status / rr_interval(ms) / battery(%)。

## 识别与连接

- 扫描识别：广播 `serviceUuids` 含 `180d` **或** 名字含 `HRM`（及常见心率带名关键字）→ brand `hrm`。
  不能把 `hrm` 的识别做成按名字兜底到 ycy（前端 `classifyBleBrand` 现在未知名字兜底 ycy，要修）。
- 连接：hrm 走独立分支，**不要求写特征**。发现服务后：
  1. 订阅 `0x2A37` notify，用纯函数 `protocols/hrs.js` 解析（flags bit0 16 位心率、bit2 支持接触检测、
     bit1 已检测到接触（0x06=支持且接触，0x04=支持未接触，0x00/0x02=不支持）、bit3 能量、bit4 RR，RR 单位 1/1024s）。
  2. 有 `0x2A19` 就读一次并订阅。
  3. 有 `0xFF04` 就读身份 JSON：设备 ID = `device_id`（ADR 0009/0010）；存在但非法 → 拒绝连接（ADR 0011）；
     没有 `0xFF04`（第三方心率带）→ 设备 ID 回退为规范化的 BLE 地址（与现有品牌 native 一致）。
- 监听 `peripheral` 的 `disconnect` 事件：设备置离线、清会话，交给已有自动连接 tick 重连。
- 看门狗：5s 没有测量帧 → `heart_rate=0, hr_status='stale'`。
- 下行命令（如监控弹窗发的 `report_delay_ms`）静默忽略，不报错。

## 涉及位置（来自代码梳理）

- 能力：`backend/devices/capabilities.js`、`monitorSpec.js`、`registry.js`（`HRM` 类型）。
- noble：`backend/brands/nobleBle.js`（按广播服务识别、hrm 连接/订阅/读身份/断线事件）、
  `nobleConnection.js` 或新 `hrmConnection.js`、`brandService.js`（`SUPPORTED`、`resolveDeviceType`、
  discover 过滤、safeConnect 分支、`isBrandBleRecord`、自动连接）、`brandLabels.js`。
- 上报：经 `deviceService.handleTransportMessage({method:'update', ...}, ...)`，与其他传感器同路径，
  bridge / 监控 SSE / 远程投影自动生效。
- 远程：`backend/services/remoteOutputGuard.js` 的 `DEVICE_CAPABILITIES` 加 HRM（心率字段只读）。
- 前端：`BrandsPanel.vue`（识别 hrm、卡片上显示实时心率/状态/电量）、`api/brands.ts` brand 联合类型、
  `PlayConfigView` 能力标签 i18n（zh/en `playConfig.caps.heartRate`）、支持设备清单加「标准蓝牙心率带」（理论支持）。
- 文档：`docs/device/capabilities.md`、`docs/device/device-registry.md`、玩法作者能看到的 DeviceAPI 能力说明。

## 不在本次范围

移动端 Dart 解释器、示例游戏。
