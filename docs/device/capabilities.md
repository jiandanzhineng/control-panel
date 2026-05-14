设备能力说明

- 目的：通过统一的“能力”描述设备可执行动作和可上报状态，游戏按能力筛选和调用设备。
- 定义位置：
  - `backend/devices/capabilities.js`：能力契约，例如 `strength.set`、`shock.start`、`reporting.setReportDelay`。
  - `backend/devices/bindings.js`：设备协议绑定，把能力动作转换成具体 MQTT payload。
  - `backend/devices/registry.js`：设备类型注册表，每个设备类型组合一组能力绑定。

常用方法

- `getAllCapabilities()`：返回所有能力名。
- `hasCapability(type, capability)`：判断设备类型是否支持某能力。
- `hasCapabilities(type, capabilities)`：判断设备类型是否同时支持多个能力。
- `getTypesByCapability(capability)`：按能力获取支持的设备类型列表。
- `getTypeCapabilities(type)`：获取某设备类型支持的能力列表。

示例

- `getTypesByCapability('strength')` → `['PJ01', 'TD01', 'OSR6', 'CUNZHI01']`
- `hasCapabilities('CUNZHI01', ['strength', 'pressure', 'shock'])` → `true`
- 游戏声明：`{ logicalId: 'STIM_DEVICE', capabilities: ['strength'], required: true }`
- 游戏调用：`deviceManager.setStrength('STIM_DEVICE', 120)`

扩展

- 新增能力：在 `capabilities.js` 增加契约。
- 新增默认或特殊实现：在 `bindings.js` 增加 binding。
- 绑定设备：在 `registry.js` 的对应设备类型中加入能力 binding。
