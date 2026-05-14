# 设备能力说明

本文按当前 `backend/devices/*` 实现整理。

## 代码位置

- 能力契约：[backend/devices/capabilities.js](../../backend/devices/capabilities.js)
- 能力到 MQTT payload 的绑定：[backend/devices/bindings.js](../../backend/devices/bindings.js)
- 设备类型注册表：[backend/devices/registry.js](../../backend/devices/registry.js)
- 设备类型基础类：[backend/devices/baseDeviceType.js](../../backend/devices/baseDeviceType.js)

## 能力列表

当前能力：

- `strength`：强度控制，动作 `set(value: 0..255)`，默认映射到 MQTT 字段 `power`。
- `reporting`：上报频率控制，动作 `setReportDelay(ms: 0..99999)`，默认映射到 `report_delay_ms`。
- `pressure`：压力上报，默认监控字段 `pressure`。
- `shock`：电击控制，动作 `start(voltage?: 0..100)`、`stop()`，默认字段 `shock`、`voltage`。
- `lock`：锁控制，动作 `setOpen(open: boolean)`，默认字段 `open`。
- `weight`：重量上报，默认监控字段 `weight`。
- `buttonInput`：按钮输入，默认监控字段 `button0`、`button1`。
- `distance`：距离检测，监控字段 `distance`，动作 `configure(lowBand?, highBand?, reportDelayMs?)`。

## 已注册设备类型

- `PJ01`：往复电机控制器，能力 `strength`。
- `TD01`：偏轴电机控制器，能力 `strength`。
- `OSR6`：OSR6 控制器，能力 `strength`。
- `QIYA`：气压传感器，能力 `pressure`、`reporting`，监控 `pressure`、`temperature`。
- `DIANJI`：电脉冲设备，能力 `shock`。
- `ZIDONGSUO`：自动锁，能力 `lock`。
- `QTZ`：测距及脚踏传感器，能力 `distance`、`buttonInput`、`reporting`。
- `DZC01`：电子秤，能力 `weight`、`reporting`。
- `CUNZHI01`：寸止玩法设备，能力 `strength`、`pressure`、`reporting`、`shock`，监控 `pressure`、`pressure1`。

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

玩法运行时可通过注入的 `deviceManager` 调用能力：

```js
deviceManager.setStrength('stim', 120)
deviceManager.setReportDelay('sensor', 250)
deviceManager.startShock('shock', { voltage: 24 })
deviceManager.stopShock('shock')
deviceManager.setLockOpen('lock', true)
deviceManager.configureDistance('distance', { lowBand: 20, highBand: 80 })
```

底层会把能力动作转换为具体 MQTT payload，并发布到 `/drecv/{deviceId}`。
