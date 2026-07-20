# QTZ 接入踮脚压力能力调研与实施计划

## 结论

可以实现，并且现有 QTZ 的 `button0`、`button1` 上报已经足够，不需要修改设备固件。

推荐把 QTZ 的按钮状态在后端设备层派生为统一属性 `pressure1`：

- `button0` 或 `button1` 任意一个等于 `1`：`pressure1 = 200`
- 两个按钮都不等于 `1`：`pressure1 = 0`

同时给 QTZ 注册 `tiptoePressure` 能力。这样玩法配置页会允许把 QTZ 映射到要求 `tiptoePressure` 的逻辑设备，现有监听 `pressure1` 的玩法也可以直接复用。

## 当前实现

### 踮脚压力能力

- `tiptoePressure` 已存在，监听设备属性 `pressure1` 的变化：`backend/devices/capabilities.js`。
- 监控元数据也把该能力映射到 `pressure1`：`backend/devices/monitorSpec.js`。
- 当前只有 `CUNZHI01` 注册了此能力，QTZ 尚未注册：`backend/devices/registry.js`。

### QTZ 按钮

- QTZ 已注册 `distance`、`buttonInput`、`reporting` 三项能力：`backend/devices/registry.js`。
- QTZ 的两个脚踏状态已经以 `button0`、`button1` 属性进入设备状态：`backend/devices/monitorSpec.js`。
- 现有女仆惩罚玩法直接监听这两个属性，并以值 `1` 表示按下：`backend/games/maid-punishment/game.js`。

### 玩法设备映射

- 配置页会按玩法声明的能力过滤可选设备，设备必须包含全部要求能力：`frontend/src/views/PlayConfigView.vue`。
- 女仆惩罚中的压力传感器角色要求 `tiptoePressure` 和 `reporting`：`backend/games/maid-punishment/index.html`。
- 因此只派生 `pressure1` 但不把 `tiptoePressure` 加入 QTZ 能力集，配置页仍然无法选择 QTZ。

## 推荐接入方案

### 1. 为设备类型增加声明式上行数据派生规则

在 `DeviceType` 声明中增加 `derivedProperties`，由设备类型注册表声明硬件字段到统一能力字段的转换。PC 和手机端分别实现相同的规则解释器，并在属性进入宿主缓存前执行。

QTZ 的派生规则使用“本次上报字段覆盖已有设备状态”后的完整按钮状态计算，避免设备只上报单个按钮变化时误判：

```json
{
  "target": "pressure1",
  "sources": ["button0", "button1"],
  "operator": "anyEquals",
  "equals": 1,
  "trueValue": 200,
  "falseValue": 0
}
```

比在 PC 的 `deviceService` 或手机端的 `GameBridge` 中写死 QTZ 判断更合适，因为硬件协议适配仍由设备类型模块负责，并且规则能够在两端保持同构。

### 2. 给 QTZ 注册 `tiptoePressure`

QTZ 能力集调整为：

```text
distance, buttonInput, tiptoePressure, reporting
```

完成后，要求 `tiptoePressure + reporting` 的玩法角色会自动把 QTZ 列为可选设备。

### 3. 保留统一属性名 `pressure1`

现有 `tiptoePressure` 能力、监控 UI 和女仆惩罚玩法都使用 `pressure1`。使用同名派生属性可以避免玩法层区分 CUNZHI01 和 QTZ，也不需要为 QTZ 单独增加玩法分支。

## 需要处理的边界

### 初始状态

`onProperty` 当前只在属性发生变化时推送，不会在订阅时自动回放当前值；后端已有 `DeviceAPI.device(...).read(property)` 可读取当前属性。因此玩法启动时应先读取一次 `pressure1`，再订阅变化，否则按钮在玩法启动前已经按下且之后一直不变时可能暂时漏判。

### 部分字段上报

派生压力时必须合并旧状态。若某次消息只包含 `button0`，不能把缺失的 `button1` 当作未按下。

### 展示单位

`pressure1` 当前监控单位标为 `kPa`，但 QTZ 的 `0/200` 是兼容既有阈值逻辑的状态值，并非真实压力。功能上没有问题，但设备监控页可能显示成 `200 kPa`。实施时可选择：

- 最小改动：保留现状，并在文档中说明 QTZ 为模拟值；
- 完整处理：支持设备类型覆盖监控字段名称/单位，把 QTZ 的该字段显示为“压力状态值”。

### 重复映射

女仆惩罚当前同时提供 QTZ 按钮角色和独立踮脚压力角色。如果同一台 QTZ 同时映射到两个角色，会同时走按钮判定和派生压力判定，结果一致但属于重复输入。后续可以简化该玩法的设备声明或保留兼容行为。

## 建议测试

- QTZ 能力集中包含 `tiptoePressure`。
- `button0=0, button1=0` 派生 `pressure1=0`。
- 任一按钮为 `1` 派生 `pressure1=200`。
- 单字段更新时使用另一个按钮的已有状态。
- 两个按钮从任一按下恢复为都未按下时，产生 `pressure1: 200 -> 0` 的属性变化。
- Bridge 的 `pressure1` 属性订阅和 `tiptoePressure.pressureChange` 能力事件都能收到派生变化。
- 配置页可把 QTZ 选择为要求 `tiptoePressure + reporting` 的设备角色。

## 初步改动范围

- `backend/devices/baseDeviceType.js`：增加设备上行数据派生入口。
- `backend/devices/registry.js`：QTZ 注册能力和派生规则。
- `backend/services/deviceService.js`：入库前调用设备类型派生逻辑。
- `backend/games/maid-punishment/game.js`：启动时读取一次当前 `pressure1`。
- `backend/tests/*`：补充能力、派生属性及 Bridge 事件测试。
- `docs/device/*`、`play-registry/docs/devices.html`：同步 QTZ 能力说明。
- 手机端 `device_registry.dart`、`game_bridge.dart`、`game_run_page.dart`：实现同构规则、实时派生与初始化派生。

## 与统一游戏运行时架构的关系

原方案把转换放在设备抽象层，而不是玩法页面中，方向符合 `docs/architecture/game-runtime-unified-design.md` 的分层：设备上报先更新宿主属性快照，再产生 `propertyChange` 和 `capabilityEvent`；设备差异由 `DeviceType` 负责适配。

但如果只在 PC 的 `BaseDeviceType` 中加入 JavaScript 函数钩子，则不完全符合该文档的跨端目标。文档要求 PC 与 Android 共享能力定义和设备类型声明，而 Android 运行时当前使用 Dart 版 `CapabilityRegistry`、`DeviceTypeRegistry`，不会自动执行 PC 的函数。

更符合统一架构的形式，是在 `DeviceType` 中增加可跨语言表达的派生属性规则，例如：

```json
{
  "target": "pressure1",
  "sources": ["button0", "button1"],
  "operator": "anyEquals",
  "equals": 1,
  "trueValue": 200,
  "falseValue": 0
}
```

PC 和 Android 都在“更新属性快照之前”执行同一种规则。派生出的 `pressure1` 与真实属性一样进入缓存、触发属性事件，并参与 `tiptoePressure.pressureChange` 能力事件。这样玩法页面不需要判断宿主平台或设备型号。

## 手机端支持情况

手机端可以支持，而且基础链路已经存在：

- 已识别 QTZ 设备类型，并在 BLE 属性目录中声明 `button0`、`button1`。
- 游戏运行时已有 `tiptoePressure` 能力，监听字段同样是 `pressure1`。
- Android Bridge 已实现属性缓存、`propertyChange`、`capabilityEvent` 和 `read(property)`。
- 游戏配置页同样按 `DeviceTypeRegistry` 的能力集过滤设备。

手机端仍需同步完成以下修改：

- QTZ 的能力列表增加 `tiptoePressure`。
- 属性缓存更新路径执行同一套派生规则；按钮任一变化时重新计算 `pressure1`。
- `GameRunPage` 初始化属性缓存时，根据当前 `button0/button1` 派生初始 `pressure1`，不能直接使用 QTZ 状态中未派生的默认压力值。
- 增加 QTZ 按钮到模拟压力、初始读取和能力事件测试。

因此该功能能够做到同一游戏 HTML 在 PC 和手机端无差别运行，但不能只修改 PC 仓库；两个宿主运行时必须同步实现同一条设备类型派生规则。

## 完整实施计划

以下计划是后续实现的执行基准，取代前文“预计改动范围”中的 PC 单端函数钩子方案。

### 目标

- QTZ 任一按钮按下时，对游戏运行时暴露 `pressure1 = 200`；两个按钮都未按下时暴露 `pressure1 = 0`。
- QTZ 在 PC 和手机端都声明 `tiptoePressure` 能力。
- 同一游戏 HTML、manifest 和阈值配置在 PC 与手机端行为一致。
- CUNZHI01 的真实 `pressure1` 行为保持不变。

### 非目标

- 不修改 QTZ 固件协议和真实 `button0/button1` 上报。
- 不删除现有 `buttonInput` 或 QTZ 距离能力。
- 不在本次修改中重构所有设备能力定义为跨仓库共享包。
- 不因功能开发直接更新应用版本号；若进入发版，再按 `docs/agent/update.md` 执行。

### 派生属性契约

两端采用相同的声明式规则结构：

```json
{
  "target": "pressure1",
  "sources": ["button0", "button1"],
  "operator": "anyEquals",
  "equals": 1,
  "trueValue": 200,
  "falseValue": 0
}
```

首期只实现 `anyEquals`，避免引入通用表达式语言。规则语义如下：

- 使用“已有属性快照 + 本次上报”的合并结果读取所有 source。
- 数字和数字字符串统一按数值比较，`1` 与 `"1"` 都表示按下。
- source 缺失时使用已有快照；首次出现且无历史值时按未按下处理。
- 初始化缓存和实时属性更新必须调用同一规则解释器。
- 只有派生值实际变化时，才发送 `propertyChange` 和能力事件。

### 阶段一：补充统一架构契约

更新 `docs/architecture/game-runtime-unified-design.md`：

- 在 §5.1.1 属性缓存链路中加入 DeviceType 派生步骤。
- 在 §5.3 DeviceType 声明中增加 `derivedProperties` 示例与执行时机。
- 明确派生属性与真实属性具有相同的缓存、读取和事件语义。
- 在 §9 说明两端须保持派生规则 schema 与解释结果一致。

此阶段先固定行为契约，防止 PC 和手机端分别实现出不同语义。

### 阶段二：PC 设备抽象层

1. 在 `backend/devices/baseDeviceType.js` 接收并保存 `derivedProperties` 声明，提供统一的派生方法。
2. 增加小型规则解释器；可放在 `backend/devices/derivedProperties.js`，避免把运算逻辑散落在设备服务中。
3. 在 `backend/services/deviceService.js` 的属性入库入口执行派生：
   - 获取当前设备类型和旧属性快照；
   - 对 report、单属性 update、整体 update 采用同一处理；
   - 将原始更新与派生更新一次性交给 `updateDeviceData`；
   - 继续复用现有 change detection 和 Bridge 事件链。
4. 在 `backend/devices/registry.js` 为 QTZ：
   - 增加 `tiptoePressure`；
   - 声明按钮到 `pressure1` 的派生规则。
5. 不修改 `backend/devices/capabilities.js` 中 `tiptoePressure` 的公共契约，继续监听 `pressure1`。

### 阶段三：手机端设备抽象层

目标仓库：`E:\develop\smart\control_panel_mobile`。

1. 新增 `lib/features/games/runtime/derived_properties.dart`，实现与 PC 相同的规则模型和 `anyEquals` 解释器。
2. 扩展 `lib/features/games/runtime/device_registry.dart`：
   - `DeviceTypeDef` 增加派生规则声明；
   - QTZ 能力增加 `tiptoePressure`；
   - QTZ 声明相同的按钮派生规则。
3. 调整 `lib/features/games/runtime/game_bridge.dart` 的实时更新链路：
   - 收到 `button0/button1` 后先计算完整更新集；
   - 逐个写入 `GameSession.propCache`；
   - 对真实属性和派生属性统一发送事件；
   - 确保 `pressure1` 变化触发 `tiptoePressure.pressureChange`。
4. 调整 `lib/features/games/views/game_run_page.dart` 的 `_seedInitialProps`：
   - 先构造设备原始属性快照；
   - 根据物理设备类型执行派生规则；
   - 再写入 Session 缓存；
   - 保证游戏首次 `read('pressure1')` 已得到正确值。
5. 保留 `lib/core/transport/device_property_catalog.dart` 中 QTZ 的 `button0/button1` 定义，不为 QTZ 声明不存在的 BLE `pressure1` 特征。
6. 遵守手机仓库约定：每次文件写入不超过 50 行，并在提交前执行其 `docs/pre-commit-checks.md` 要求。

### 阶段四：玩法兼容处理

更新 `backend/games/maid-punishment/game.js`，并同步相同游戏文件到手机端要求的游戏资源位置：

- 注册 `pressure1` 订阅后，调用 `DeviceAPI.device(TIPTOE).read('pressure1')` 读取初始值。
- 正确处理 `read` 返回的数组，使用第一个已映射设备值初始化压力判定。
- 保留现有 QTZ 按钮角色，避免破坏旧配置和直接按钮玩法。
- 同一台 QTZ 同时映射到按钮角色与压力角色时允许重复判定；两条判定结果一致，不改变惩罚语义。
- 不在玩法中加入 `deviceType === 'QTZ'` 判断。

若手机端直接加载 PC/在线游戏资源，则只需保证发布资源同步；若仓库内有游戏副本，按手机仓库“游戏和 PC_CLIENT_DIR 保持一致”的规则同步修改。

### 阶段五：监控显示与文档

本次采用最小兼容策略：保留公共字段名 `pressure1`，但避免把 QTZ 模拟值描述为真实压力。

- `docs/device/device-registry.md`：QTZ 能力增加 `tiptoePressure`，说明值为按钮派生的 `0/200` 状态值。
- `docs/device/capabilities.md`：补充 `tiptoePressure` 字段和设备列表，顺便修正旧的 `pressure` 命名描述。
- `play-registry/docs/devices.html`：同步能力表和 QTZ 说明。
- 手机端相关设备/游戏文档同步说明 QTZ 支持模拟踮脚压力。
- 暂不把全局 `pressure1` 单位从 `kPa` 改为无单位，避免影响 CUNZHI01；若设备监控页需要精确显示，后续单独增加 DeviceType 级 monitor metadata override。

### PC 测试计划

在 `backend/tests/deviceCapabilities.test.js` 增加：

- QTZ 能力包含 `tiptoePressure`。
- QTZ 公共配置包含派生后的监控字段。
- CUNZHI01 能力和配置保持不变。

为派生规则增加独立单元测试，覆盖：

- `0/0 -> 0`、`1/0 -> 200`、`0/1 -> 200`、`1/1 -> 200`。
- 数字字符串 `"1"`。
- 单字段更新保留另一按钮的历史状态。
- 派生结果未变化时不制造重复 change。

在 Bridge/设备服务测试中覆盖：

- QTZ report 初始化时生成 `pressure1`。
- 单属性 update 能生成 `pressure1: 0 -> 200 -> 0`。
- `subscribeProperty('pressure1')` 收到派生变化。
- `tiptoePressure.pressureChange` 收到能力事件，`data.props.pressure1` 正确。
- `read('pressure1')` 返回当前派生缓存。

建议验证命令：

```powershell
npm --prefix backend test -- deviceCapabilities.test.js
npm --prefix backend test -- bridgeBrowserDeviceSession.test.js
npm --prefix backend test
```

### 手机端测试计划

更新或新增以下测试：

- `test/features/games/device_registry_test.dart`：QTZ 包含 `tiptoePressure` 和派生规则。
- `test/features/games/game_bridge_test.dart`：按钮属性变化产生 `pressure1` 的属性事件和能力事件。
- 新增 `test/features/games/derived_properties_test.dart`：与 PC 完全相同的规则测试矩阵。
- 为初始化缓存增加测试：游戏启动前按钮已经按下时，`read('pressure1')` 返回 `200`。
- 验证 QTZ 仍保留 `distance`、`buttonInput`、`reporting`，避免能力回归。

建议验证命令：

```powershell
flutter test test/features/games/derived_properties_test.dart
flutter test test/features/games/device_registry_test.dart
flutter test test/features/games/game_bridge_test.dart
flutter analyze
```

### 跨端联合验收

使用同一份女仆惩罚游戏资源和相同参数，在 PC 与 Android 分别验证：

1. 两按钮均松开，读取压力为 `0`，不触发压力违规。
2. 按下按钮 0，压力变为 `200`，超过默认阈值 `100`，经过防抖后触发违规。
3. 松开按钮 0 且按钮 1 未按，压力恢复 `0`。
4. 按住按钮 1，再切换按钮 0，压力始终保持 `200`，中间不得错误降为 `0`。
5. 游戏启动前已按住任一按钮，进入游戏后首次读取即为 `200`。
6. CUNZHI01 仍上报真实 `pressure1`，不经过 QTZ 的 `0/200` 转换。
7. QTZ 的距离检测、按钮原始事件和上报频率配置继续正常。

### 实施顺序与提交边界

建议按以下顺序实施，确保每一步可独立验证：

1. 更新架构文档和派生规则契约。
2. PC：规则解释器及单元测试。
3. PC：接入设备状态更新、QTZ 能力和 Bridge 测试。
4. 手机：规则解释器及单元测试。
5. 手机：接入实时/初始化缓存、QTZ 能力和 Bridge 测试。
6. 更新玩法初始读取逻辑并同步游戏资源。
7. 更新设备文档和 play-registry 文档。
8. 执行两端完整测试与硬件联合验收。

### 完成标准

- PC 与手机端 QTZ 都能被配置为 `tiptoePressure + reporting` 设备。
- 两端对所有按钮组合产生完全一致的 `pressure1` 值。
- 初始化读取、属性订阅和能力事件三种入口行为一致。
- CUNZHI01 和 QTZ 其他能力无回归。
- 两端相关单元测试、完整测试和静态检查通过。
- 架构文档、设备文档、play-registry 文档与实际实现一致。
