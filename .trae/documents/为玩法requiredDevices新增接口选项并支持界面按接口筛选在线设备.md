## 目标
- 在玩法的 `requiredDevices` 中支持 `interface` 字段，与原有 `type` 二选一。
- 当某项指定 `interface` 时，前端设备映射界面只展示“支持该接口的在线设备”。
- 保持现有按 `type` 的行为不变，兼容所有已有玩法与接口。

## 设计要点
- `接口定义来源`：使用 `backend/config/deviceTypes.js` 中的 `interfaceConfig/typeInterfaceMap/getTypesByInterface/hasInterface`（e:\develop\control-panel\backend\config\deviceTypes.js:99-178）。
- `玩法元信息`：`getGameplayMeta` 原样返回 `requiredDevices`（e:\develop\control-panel\backend\services\gameplayService.js:228-244），无需额外处理。
- `校验策略`：后端只在“必需设备 required=true”时校验映射与在线；新增接口匹配校验仅在存在 `interface` 且该必需项已映射时触发，保持简洁。
- `前端筛选`：`GameStartConfigView.vue` 在计算候选设备时，针对 `rd.interface` 使用“类型是否实现接口”+“设备在线”为过滤条件。

## 后端改动
- 新增接口路由：`GET /api/device-interfaces`
  - 返回 `{ interfaces: string[], interfaceConfig, typeInterfaceMap }`。
  - 代码位置：新增 `backend/routes/deviceInterfaces.js` 并在 `backend/index.js` 注册（e:\develop\control-panel\backend\index.js:66-71 旁新增 `app.use('/api/device-interfaces', require('./routes/deviceInterfaces'))`）。
- 依赖校验增强（可选、简洁）：
  - 在 `validateDeviceDependencies` 中，若 `item.interface` 存在且该项 `required=true`：
    - 读到映射的 `deviceId` 与设备 `type`（e:\develop\control-panel\backend\services\gameplayService.js:282-304）。
    - 使用 `hasInterface(type, item.interface)` 校验；不匹配则视为阻塞（同“类型不匹配”级别）。

## 前端改动
- 类型补充：
  - `GameItem.requiredDevices` 增加 `interface?: string`（e:\develop\control-panel\frontend\src\views\GameStartConfigView.vue:314-322）。
- 拉取接口映射：
  - 在 `loadAll()` 并行请求 `/api/device-interfaces`，持有 `typesByInterface` 或直接 `typeInterfaceMap`（e:\develop\control-panel\frontend\src\views\GameStart