设备接口说明

- 目的：通过统一的“接口”描述设备能力，游戏按接口筛选可用设备。
- 定义位置：`backend/config/deviceTypes.js`
  - `interfaceConfig`：接口及其规范（如 `strength` 强度控制，`spec.mqttKey='power'`，`range=[0,255]`）。
  - `typeInterfaceMap`：设备类型实现的接口（如 `TD01` 实现 `strength`）。

常用方法

- `getAllInterfaces()`：返回所有接口名。
- `hasInterface(type, iface)`：判断设备类型是否实现接口。
- `getTypesByInterface(iface)`：按接口获取支持的设备类型列表。
- `getInterfaceConfig(iface)`：获取接口的规范信息。
- `getTypeInterfaces(type)`：获取某设备类型实现的接口。

示例

- `getTypesByInterface('strength')` → `['TD01']`
- `hasInterface('TD01','strength')` → `true`
- `getInterfaceConfig('strength')` → `{ name: '强度控制', spec: { mqttKey: 'power', range: [0, 255] } }`

扩展

- 新增接口：在 `interfaceConfig` 增加条目并设定 `name/spec`。
- 绑定设备：在 `typeInterfaceMap` 的对应设备类型数组加入接口名。
