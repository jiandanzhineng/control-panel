# 设备能力说明

本文按当前 `backend/devices/*` 实现整理。

## 代码位置

- 能力契约：[backend/devices/capabilities.js](../../backend/devices/capabilities.js)
- 能力值解释器：[backend/devices/capabilityValue.js](../../backend/devices/capabilityValue.js)
- 能力到 MQTT payload 的绑定：[backend/devices/bindings.js](../../backend/devices/bindings.js)
- 设备类型注册表：[backend/devices/registry.js](../../backend/devices/registry.js)
- 设备类型基础类：[backend/devices/baseDeviceType.js](../../backend/devices/baseDeviceType.js)

## 能力列表

当前能力：

- `strength`：强度控制，动作 `set(value: 0..255)`，默认映射到 MQTT 字段 `power`。
- `reporting`：上报频率控制，动作 `setReportDelay(ms: 0..99999)`，默认映射到 `report_delay_ms`。
- `sphincterPressure`：括约压力，默认可读值来自 `pressure`。
- `tiptoePressure`：踮脚压力，默认可读值来自 `pressure1`。
- `shock`：电击控制，动作 `start(voltage?: 0..100)`、`stop()`，默认字段 `shock`、`voltage`。
- `lock`：锁控制，动作 `setOpen(open: boolean)`，默认字段 `open`。
- `weight`：重量上报，默认可读值来自 `weight`。
- `buttonInput`：按钮输入，默认监控字段 `button0`、`button1`。
- `distance`：距离检测，默认可读值来自 `distance`，动作 `configure(lowBand?, highBand?, reportDelayMs?)`。

## 能力可读值

传感器能力通过 `value.source` 和 `value.watch` 声明当前标量值。玩法使用 `readValue(capability)` 做一次性读取，使用 `onValue(capability, callback)` 订阅变化；两个入口和启动初始化共用相同解析规则。

首期支持 `prop` 与 `anyEquals` 两个算子。设备类型可以 override 能力的 `value`，但规则必须是声明式数据，以便 PC JavaScript 与移动端 Dart 解释器保持同构。底层属性接口 `read(property)` / `onProperty(property)` 继续保留用于兼容和调试。

## 已注册设备类型

- `PJ01`：往复电机控制器，能力 `strength`。
- `TD01`：偏轴电机控制器，能力 `strength`。
- `OSR6`：OSR6 控制器，能力 `strength`。
- `QIYA`：气压传感器，能力 `sphincterPressure`、`reporting`。
- `DIANJI`：电脉冲设备，能力 `shock`。
- `ZIDONGSUO`：自动锁，能力 `lock`、`buttonInput`。锁体按键上报 `key_clicked`，对应 `buttonInput.pressed`。
- `QTZ`：测距及脚踏传感器，能力 `distance`、`buttonInput`、`tiptoePressure`、`reporting`。`tiptoePressure` 由 `button0/button1` 派生：任一值数值化后等于 1 时为 200，否则为 0。
- `DZC01`：电子秤，能力 `weight`、`reporting`。
- `CUNZHI01`：寸止玩法设备，能力 `sphincterPressure`、`tiptoePressure`、`strength`、`shock`、`reporting`；踮脚压力仍读取真实 `pressure1`。
- `GXP_XA9935`：gxp艾萝机娘二代，能力 `strength`（往复电机 0–255→0–100%）。

未知设备类型会返回一个基础设备类型，显示名为类型本身，不包含能力、操作或监控字段。

## API

相关接口见 [后端 API 文档](../api/Backend_API.md#设备类型与能力)：

- `GET /api/device-types`
- `GET /api/device-types/configs`
- `GET /api/device-types/:type/config`
- `GET /api/device-capabilities`

## 游戏中的使用

玩法通过 `requiredDevices` 声明逻辑设备和所需能力：

```js
requiredDevices: [
  {
    logicalId: 'stim',
    name: '刺激设备',
    required: true,
    capabilities: ['strength']
  }
]
```

启动时，前端会根据 `/api/device-capabilities` 的 `typeCapabilityMap` 过滤可选设备。后端启动玩法时还会再次校验：

- `required=true` 的逻辑设备必须映射。
- 已映射设备必须存在并在线。
- 已映射设备类型必须同时满足声明的全部能力。

玩法运行时通过注入的 `DeviceAPI` 调用能力动作或读取能力值：

```js
DeviceAPI.device('stim').invoke('strength', 'set', { value: 120 })
DeviceAPI.device('sensor').onValue('sphincterPressure', (value) => console.log(value))
const values = await DeviceAPI.device('sensor').readValue('sphincterPressure')
```

底层会把能力动作转换为具体 MQTT payload，并发布到 `/drecv/{deviceId}`。
