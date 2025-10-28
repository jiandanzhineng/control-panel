# PRD — 外部玩法服务（GameplayService）

## 背景与目标
- 背景：系统支持“外部玩法”（JS 文件定义的玩法逻辑）与硬件设备交互，需在客户端统一管理玩法加载、设备映射、消息处理、循环执行与结束流程。
- 目标：定义外部玩法的运行服务（GameplayService）的产品需求，确保玩法在标准流程内稳定、可观测、易扩展地运行。

## 范围
- 包含：玩法加载与校验、设备映射与依赖验证、MQTT 消息监听与分发、玩法生命周期（start/loop/end/stop）、日志与性能统计、设备属性读写与监听。
- 不包含：具体设备驱动实现、主进程 MQTT 客户端实现、UI 交互细节（但定义必要的对接点）。

## 角色与使用场景
- 角色：
  - 玩法开发者：编写外部玩法 JS 文件，依赖 GameplayService 提供的接口运行。
  - 运营/测试人员：在 UI 中选择玩法、配置设备映射与参数，启动/停止玩法，观察日志与运行状态。
  - 设备管理员：保障设备在线、可用，并提供正确的设备映射。
- 场景：
  - 选择玩法文件 → 加载并校验 → 配置设备映射与参数 → 启动 → 循环运行（接收设备数据、执行逻辑、发指令）→ 结束或停止 → 查看日志与统计。

## 用户故事
- 作为玩法开发者，我可以导出一个包含 `title/description/requiredDevices/start/loop` 的对象或类，系统能加载、校验并运行它。
- 作为玩家，我可以在 UI 中映射玩法所需的设备，并在玩法运行时看到设备消息与日志；必要时可一键停止玩法。
- 作为玩法逻辑，我可以通过注入的 `deviceManager` 操作设备属性、监听设备消息/属性变化；通过 `log` 输出结构化日志。

## 功能需求
- 玩法文件加载
  - 支持读取本地 JS 文件内容。
  - 兼容 ESModule 导出与 CommonJS：将 `export default`/`export {}` 转换为 `module.exports` 后在隔离环境执行。
  - 若导出为类，需实例化；若为对象，直接使用。
  - 运行前校验：必须包含 `title/description/requiredDevices/start/loop`；`start/loop` 必须为函数。
- 设备映射与依赖验证
  - 用户提供 `deviceMapping: { logicalId: deviceId }`。
  - `applyDeviceMapping` 将映射写入 `deviceManager.deviceMap`，记录成功/失败日志。
  - `validateDeviceDependencies` 遍历 `currentGameplay.requiredDevices`：
    - 必需项（`required: true`）必须已映射且设备 `connected === true`。
    - 不满足时抛错并记录错误日志。
- MQTT 消息监听与处理
  - 通过 mqttClientService.js 注册监听。
  - 仅处理设备上报主题：`/dpub/{deviceId}`；非该主题直接忽略，deviceID不在设备列表中也忽略。
  - 仅处理包含 `method` 字段的消息；无 `method` 忽略。
  - 支持注册设备消息监听：`listenDeviceMessages(logicalId, callback)`。
- 设备消息与属性监听
  - 通过deviceService.js注册监听
  - 通过DeviceManager对象提供设备相关操作功能
  - deviceID不在设备列表中忽略。
- 支持注册属性监听：`listenDeviceProperty(logicalId, property, callback)`，当属性值由旧值变为新值时触发。
- 设备属性操作
  - `setDeviceProperty(logicalId, properties)`：向 `/drecv/{deviceId}` 发送 `method: 'update'` 的合并属性。
  - `sendDeviceMqttMessage(logicalId, message)`/`sendMqttMessage(topic, message)`：封装发送与日志。
  - `getDeviceProperty(logicalId, property)`：从 deviceService.js 读取。
- 玩法生命周期
  - `startGameplay(config, deviceMapping, parameters)`：
    - 检查是否已有运行中玩法；注入 `log` 接口。
    - 应用设备映射、验证依赖；调用玩法 `start(deviceMapping, parameters)`。
    - 标记 `isRunning = true`，记录 `startTime`；启动游戏循环。
  - 游戏循环：
    - `startGameLoop()` 每 1 秒调用一次玩法 `loop(deviceManager)`。
    - 若 `loop` 返回 `false` 或抛错，则调用 `endGameplay()` 结束。
  - 结束与停止：
    - `endGameplay()` 清理 interval 与监听器，调用玩法 `end(deviceManager)`（若存在），重置状态。
- 日志与可观测性
  - 统一 `sendLog(level)` 输出至前端（通过 `setLogCallback` 注册）与控制台。

## 非功能需求
- 性能：
  - 循环执行频率默认 1s，可在后续版本中支持可配置化。
- 稳定性与容错：
  - 设备未映射、设备离线、消息解析失败、缺少 `method` 均应被安全忽略或抛错并记录。
  - 结束与停止流程必须清理所有定时器与监听器，避免资源泄露。
- 可扩展性：
  - 玩法接口设计遵循“最小必要”原则，但支持注入更多服务（如语音识别、AI 服务）且不破坏现有约定。

## 接口与数据结构
- 对玩法注入的接口
  - `deviceManager`：
    - `listenDeviceMessages(logicalId, callback)`
    - `listenDeviceProperty(logicalId, property, callback)`
    - `setDeviceProperty(logicalId, properties)`
    - `sendDeviceMqttMessage(logicalId, message)`
    - `getDeviceProperty(logicalId, property)`

- 玩法对象/类约定
  - 字段：`title: string`、`description: string`、`requiredDevices: Array`。
  - 方法：`start(deviceManager, parameters)`、`loop(deviceManager)`、可选 `end(deviceManager)`、可选 `updateParameters(parameters)`。
  - `requiredDevices` 项示例：`{ logicalId: 'sensor1', name: '压力传感器', required: true }`。

- 设备对象（抽象）
  - 最小字段：`id: string`、`name: string`、`type: string`、`status: 'online'|'offline'`、`connected: boolean`、`data: Record<string, any>`。

- MQTT 主题与负载
  - 上报主题：`/dpub/{deviceId}`（仅处理映射到当前玩法的设备）。
  - 下发主题：`/drecv/{deviceId}`。
  - 负载：
    - 上报：必须含 `method` 字段；`update` 搭配 `key/value` 或其他对象结构。
    - 下发：`{ method: 'update', ...properties }`。

## 流程说明（摘要）
1. 加载玩法 → 校验导出与必需字段 → 实例化。
2. 应用设备映射 → 验证必需设备在线。
3. 注入 `log/deviceManager` → 调用 `start`。
4. 启动循环，每秒调用 `loop`；必要时结束。
5. 监听 `/dpub/{id}`，解析并分发到 `DeviceManager`；属性监听触发回调。
6. 结束/停止：清理循环与监听器，调用 `end`，记录时长。

## 验收标准
- 玩法加载：不符合导出约定的文件被拒绝并记录错误信息。
- 设备映射与验证：必需设备未映射或离线时，`startGameplay` 抛错并输出错误日志。
- 消息处理：仅 `/dpub/{id}` 且含 `method` 的消息被处理；`update(key,value)` 被转换为键值对象。
- 循环执行：`loop` 每秒调用一次；返回 `false` 或异常将触发结束流程。
- 日志与统计：能在 UI 中接收结构化日志；超过阈值的处理时间有警告。

## 风险与开放问题
- 外部玩法执行的安全性：需后续引入沙箱策略与能力白名单。
- 设备对象字段一致性：`connected` 与 `status` 均被使用；需在设备模型中统一含义与来源。
- 循环频率：目前固定 1s；建议支持参数化配置（如 `loopIntervalMs`）。
