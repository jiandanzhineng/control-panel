# QTZ 踮脚压力接入与能力可读值契约重构

## 结论

QTZ 接入踮脚压力**可以实现**，且现有 `button0`、`button1` 上报已足够，不需修改设备固件。

但本文档采用的方案不是「给 QTZ 派生一个 `pressure1` 属性」，而是更彻底的 **T2：能力可读值契约重构** —— 让玩法读「`tiptoePressure` 能力的当前值」，而非某个设备的裸底层属性名。QTZ 用按钮派生踮脚压力，只是这套契约下的一个 per-device 值解析规则。

采用 T2 后：

- 玩法与硬件字段名解耦，同一游戏 HTML 可跨设备、跨端（PC/手机）无差别运行。
- QTZ 接入踮脚压力不再需要伪造 `pressure1` 属性。
- 后续新设备接入任意能力，只需声明该能力的值解析规则。

## 背景与动机

当前游戏运行时里，玩法直接读取设备的**裸底层属性名**，把游戏逻辑和硬件字段名硬耦合。读裸属性的游戏共 6 个：

- `maid-punishment/game.js:191`：`onProperty('pressure1')`（踮脚压力）
- `pressure-edging/game.js:240`、`pressure-edging-v2/game.js:326`、`pelvic-training/game.js:133`：`onProperty('pressure')`（括约压力）
- `pushup-detection/game.js:203`：`onProperty('distance')`
- `drink-pee-unlock/game.js`：`onProperty('weight')` / `read('weight')` / `onProperty('pressure')` / `onProperty('button0'|'button1')`

读取链路（`backend/services/bridgeService.js`）三个入口全部直取 `dev.data`：

- `readForSession`（:465）：`return dev?.data?.[msg.property]` —— 按属性名直接取。
- `subscribeProperty` / `propertyChange`（:189-193、:247-258）：按属性名 key 转发。
- `capabilityEvent`（:308-323）：payload 是 `data.props = dev.data`（整包裸属性），不含归一化标量值。

**问题**：同一能力在不同设备上底层字段和算法不同——QTZ 用 `button0/button1` 派生踮脚压力，CUNZHI01 直接上报 `pressure1`——但游戏被迫写死某一个设备的字段名。这导致新设备接入某能力必须伪造出对应属性名；游戏无法跨设备复用；能力这一层形同虚设。

**目标终态**：让「能力」成为游戏与硬件之间的稳定契约。玩法读「`tiptoePressure` 的当前值」，不关心底层是 `pressure1` 还是 `button0/button1`。设备差异收敛到能力的 per-device 值解析规则里。

## 当前实现（现状核对）

### 踮脚压力能力

- `tiptoePressure` 已存在，事件 `pressureChange` 监听设备属性 `pressure1`：`backend/devices/capabilities.js:66-76`。
- 监控元数据把该能力映射到 `pressure1`：`backend/devices/monitorSpec.js`。
- 当前只有 `CUNZHI01` 注册了此能力，QTZ 尚未注册：`backend/devices/registry.js:84-99`。

### QTZ 按钮

- QTZ 已注册 `distance`、`buttonInput`、`reporting` 三项能力：`backend/devices/registry.js:70-75`。
- QTZ 两个脚踏状态以 `button0`、`button1` 属性进入设备状态。
- 现有女仆惩罚玩法直接监听这两个属性，以值 `1` 表示按下：`maid-punishment/game.js:184-185`。

### 玩法设备映射

- 配置页按玩法声明的能力过滤可选设备，设备必须包含全部要求能力：`frontend/src/views/PlayConfigView.vue`。
- 女仆惩罚的压力传感器角色要求 `tiptoePressure + reporting`：`maid-punishment/index.html:15`。
- 因此 QTZ 必须注册 `tiptoePressure` 能力，配置页才会把它列为可选设备。

### 能力 override 机制（已存在，可复用）

- `BaseDeviceType` 构造函数已支持能力 override：`capabilities` 传对象时，值为对象的键进入 `capabilityOverrides`（`baseDeviceType.js:16-24`）。
- `resolveCapability`（:56）合并 override 与中心化能力定义。
- 本方案的「设备对某能力的特殊值解析」正是挂在这套 override 机制上，不需新造。

## 与 T1（派生属性）方案的关系

存在一个更小的方案 T1：给 QTZ 派生一个 `pressure1` 属性，游戏零改动，`onProperty('pressure1')` 直接生效。本文档选择 T2（契约级重构），范围更大但更彻底。二者关系：

- T1 的「声明式规则 + 跨端解释器」是 T2 的子集，在 T2 中原样复用，不白做。
- 差异仅在产物归属：T1 产出「一个设备属性」，T2 产出「能力的可读值」。
- 采用 T2 后不再需要为 QTZ 伪造 `pressure1` 属性；能力成为游戏读取的唯一契约。
- 若需先快速让 QTZ 踮脚可用，可先做 T1 再演进到 T2，二者不冲突。

## 设计原则

1. **能力值是声明式的，不是 JS 闭包。** per-device 差异用可跨语言表达的规则描述，PC(JS) 与手机端(Dart) 各写一个解释器，保证两端同构。禁止在设备定义里写自由函数——闭包无法在 Dart 运行时执行，会导致两端行为漂移。
2. **能力值三入口一致**：一次性读取（`readValue`）、变化订阅（`onValue`）、初始化读取，三者返回同一套解析结果。
3. **向后兼容**：`onProperty` / `read(property)` 裸属性接口保留，迁移期两套并存；不破坏现有已发布玩法配置。
4. **改动收敛**：解析规则集中在能力定义 + 设备 override，bridge 只认通用解析入口，游戏只认能力名。

## 契约设计

### 能力值解析声明

能力定义（`backend/devices/capabilities.js`）增加 `value` 段，声明「本能力的可读值如何从设备 props 得到」：

```js
tiptoePressure = {
  key: 'tiptoePressure',
  name: '踮脚压力',
  value: {
    source: { op: 'prop', key: 'pressure1' },  // 默认解析：直接取某属性
    watch: ['pressure1'],                        // 值依赖的属性列表
  },
  events: { /* 保留现有 pressureChange，迁移期不动 */ },
};
```

设备可在 registry 条目里 override 某能力的 `value` 解析（QTZ）：

```js
new BaseDeviceType({
  type: 'QTZ',
  capabilities: {
    distance: 'distance',
    buttonInput: 'buttonInput',
    reporting: 'reporting',
    tiptoePressure: {
      value: {
        source: { op: 'anyEquals', keys: ['button0','button1'], equals: 1, on: 200, off: 0 },
        watch: ['button0', 'button1'],
      },
    },
  },
})
```

### 解析器算子（首期）

- `prop`：直接返回 `props[key]`。
- `anyEquals`：任一 `keys` 的值（数值化后）等于 `equals` 则返回 `on`，否则 `off`。

首期只实现这两个，避免引入通用表达式语言。后续复杂逻辑**新增具名算子**，两端解释器各加一处，而非写闭包。解析语义：

- 使用「已有属性快照 + 本次上报」的合并结果读取 source 字段。
- 数字与数字字符串统一按数值比较，`1` 与 `"1"` 都表示按下。
- source 字段缺失时使用已有快照；首次出现且无历史值时按未触发处理。
- 只有解析后的值实际变化时，才推送值变化事件。

### 值订阅与读取语义

- `onValue(capability, cb)`：订阅能力值变化。bridge 侧当 `value.watch` 任一属性变化时解析能力当前值，与该 session 该能力上次缓存值比较，变化才推送 `capabilityValueChange`（携带标量 `value`、`oldValue`）。button0 抖动但压力仍 200 时不误发。
- `readValue(capability)`：返回能力当前解析值（数组，对应映射的物理设备），取 `dev.data` 经解析器算出。

## 实施阶段

### 阶段一：架构文档与契约固定

更新 `docs/architecture/game-runtime-unified-design.md`：

- 能力定义章节增加 `value` 段（source 算子 + watch）规范。
- 说明能力值三入口（readValue / onValue / 初始化）语义一致。
- 说明设备可 override 能力 `value` 解析；两端须解释同一份规则。
- 明确 `capabilityValueChange` payload 形态（标量 value/oldValue）。

先固定契约，防止 PC 与手机端实现出不同语义。

### 阶段二：PC 值解析器

1. 新增 `backend/devices/capabilityValue.js`：`prop`、`anyEquals` 算子解析器 `resolveValue(source, props)`。
2. `backend/devices/capabilities.js`：给 `tiptoePressure`、`sphincterPressure`、`weight`、`distance` 等被游戏读取的能力补 `value` 段（默认取现有属性名，行为不变）。
3. `backend/devices/baseDeviceType.js`：
   - 构造函数接收能力 override 里的 `value`（复用 `capabilityOverrides`，:16-24）。
   - `resolveCapabilityValue(capabilityKey, props)`：合并 override 与默认 `value`，调用解析器。
   - `getCapabilityValueWatch(capabilityKey)`：返回该能力值依赖的属性列表。
4. `backend/devices/registry.js`：QTZ 增加 `tiptoePressure` 并 override 其 `value` 为按钮派生规则；CUNZHI01 保持默认（真实 `pressure1`）。

### 阶段三：PC bridge 值入口

`backend/services/bridgeService.js`：

1. `read` 增加能力读取分支 `readValueForSession`，走 `resolveCapabilityValue`；保留裸属性 `readForSession`。
2. 增加值订阅 action（`subscribeValue`/`unsubscribeValue`），每 session 维护「能力 → 上次值」缓存。
3. `handleDeviceDataChange`（:238）：属性变化时，对订阅了值的能力检查 `value.watch` 是否命中；命中则解析当前值，与缓存比较，变化才推送 `capabilityValueChange`。
4. 复用现有 change detection 思路，值不变不重复推送。

### 阶段四：DeviceAPI 客户端

`backend/public/device-api-bridge.js`：

- `device(id)` 增加 `readValue(capability)`、`onValue(capability, cb)`、`offValue(capability, cb)`。
- `handleEvent`（:98）增加 `capabilityValueChange` 分派。
- `restoreSubscriptions`（:36）支持值订阅重连恢复。
- 同步 `play-registry/docs/device-api.html`。

### 阶段五：游戏迁移

按能力语义逐个迁移，保留旧接口兼容，每个游戏独立提交与验证：

- `maid-punishment/game.js`：`onProperty('pressure1')` → `onValue('tiptoePressure')`；启动 `readValue('tiptoePressure')` 初始化，避免开局前已按住导致漏判。
- `pressure-edging`、`pressure-edging-v2`、`pelvic-training`：`onProperty('pressure')` → `onValue('sphincterPressure')`。
- `pushup-detection`：`onProperty('distance')` → distance 能力值订阅（distance 需定义 `value`）。
- `drink-pee-unlock`：`weight` → `onValue('weight')`；按钮/压力按能力迁移。

### 阶段六：手机端同构

目标仓库：`E:\develop\smart\control_panel_mobile`。

- 新增 Dart 版值解析器（`prop`、`anyEquals`），与 PC 同一规则模型。
- `DeviceTypeRegistry`/能力定义补 `value` 段；QTZ override 按钮派生规则并加 `tiptoePressure`。
- `GameBridge` 增加能力值读取、值订阅、change detection 与初始化解析。
- 保留 `device_property_catalog.dart` 中 QTZ 的 `button0/button1`，不声明不存在的 BLE `pressure1` 特征。
- 遵守手机仓库约定：每次写入不超过 50 行，提交前执行 `docs/pre-commit-checks.md`。

### 阶段七：文档与监控

- `docs/device/device-registry.md`、`docs/device/capabilities.md`：补能力 `value` 说明与 QTZ tiptoePressure，说明其值为按钮派生的 `0/200` 状态值。
- `play-registry/docs/devices.html`、`device-api.html`：同步能力表与 API。
- `pressure1` 监控单位当前标 `kPa`，QTZ 的 `0/200` 是兼容阈值逻辑的状态值。本次采用最小策略：保留字段名，文档说明 QTZ 为模拟值；如需精确显示，后续单独加 DeviceType 级 monitor metadata override。

## 测试计划（PC）

- `backend/tests`：值解析器单测（`prop`、`anyEquals`、数字字符串 `"1"`、缺字段用历史快照、值不变不重复 change）。
- QTZ 能力集含 `tiptoePressure`，`value` override 生效；CUNZHI01 不变。
- bridge：`readValue` 返回解析值；`onValue` 收到 `capabilityValueChange`；button1 按住再切 button0 过程中值稳定为 200 不误降。
- 兼容：`onProperty`/`read(property)` 裸接口仍工作。

验证命令：

```powershell
npm --prefix backend test
```

## 测试计划（手机端）

- Dart 值解析器测试矩阵与 PC 完全一致。
- QTZ 能力/override 测试；`GameBridge` 值读取与订阅测试；初始化解析测试（开局前已按住 → 首次 readValue 返回 200）。
- 回归：QTZ 仍保留 `distance`、`buttonInput`、`reporting`。

验证命令：

```powershell
flutter test
flutter analyze
```

## 跨端联合验收

同一份游戏资源、相同参数，PC 与 Android 分别验证：

1. 两按钮松开 → 踮脚压力值 `0`，不违规。
2. 按下任一按钮 → 值 `200`，超默认阈值 `100`，防抖后触发违规。
3. 松开恢复 `0`。
4. button1 按住再切 button0，值始终 `200`，中途不误降为 `0`。
5. 游戏启动前已按住 → 进入游戏首次 `readValue` 即 `200`。
6. CUNZHI01 走真实 `pressure1`，不经按钮换算。
7. `sphincterPressure`/`weight`/`distance` 各游戏迁移后行为不变；QTZ 距离检测、按钮原始事件、上报频率配置正常。

## 实施顺序与提交边界

1. 架构文档 + 契约。
2. PC 值解析器 + 单测。
3. PC bridge 值入口 + 测试。
4. DeviceAPI 客户端 + QTZ 接入。
5. 游戏逐个迁移（每个独立提交）。
6. 手机端同构 + 测试。
7. 文档同步。
8. 跨端联合验收。

## 非目标

- 不移除 `onProperty`/`read(property)` 裸属性接口（迁移期兼容）。
- 不引入通用表达式语言（只用具名算子）。
- 不修改 QTZ 固件协议与真实 `button0/button1` 上报。
- 不删除现有 `buttonInput` 或 QTZ 距离能力。
- 不因功能开发直接升版本号；若发版按 `docs/agent/update.md` 执行。

## 完成标准

- 迁移范围内的游戏通过能力名读取语义值，不再依赖裸属性名。
- QTZ 在 PC 与手机端均可配置为 `tiptoePressure + reporting` 设备，行为一致。
- readValue / onValue / 初始化三入口结果一致。
- 现有能力与设备无回归，旧接口兼容；CUNZHI01 真实 `pressure1` 不变。
- 两端单测、完整测试、静态检查通过；架构、设备、play-registry 文档与实现一致。
