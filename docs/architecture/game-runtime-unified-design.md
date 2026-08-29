# 统一游戏运行时方案设计

> 游戏 = 网页 · 前台运行 · 通过 Bridge 控制设备 · PC 和 Android 统一

## 1. 核心理念

**游戏就是一个网页。** 逻辑和 UI 都在同一个 HTML/JS 中，通过统一的 `DeviceAPI` Bridge 操作设备。不需要独立 JS 引擎（QuickJS），不需要逻辑/UI 分离。

**开发者体验**
写游戏 = 写网页。用任何前端技术栈（原生 JS / Vue / React），标准调试工具，热更新。

**运行模型**
前台运行。WebView 前台执行稳定不中断。配合屏幕常亮 + 保活提示。

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  Game Page (HTML + JS + CSS)                                │
│  逻辑 + UI 一体，通过 DeviceAPI Bridge 控制设备              │
│  window.DeviceAPI.device('motor').invoke('strength','set',…) │
└────────────────────────────┬────────────────────────────────┘
                             │  Bridge 调用
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Host Runtime (宿主层)                                       │
│  PC: Node.js 后端 (WebSocket)                               │
│  Android: Dart 层 (JavaScriptChannel)                       │
│                                                             │
│  职责: Bridge 请求路由 → 设备抽象层 → 状态推送回网页         │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│  Device Abstraction Layer                                    │
│  Capability 契约 → DeviceType 实现 → Transport 下发          │
│  ┌────────┐  ┌────────┐  ┌────────────┐                    │
│  │ MQTT   │  │ BLE    │  │ Future     │                    │
│  └────────┘  └────────┘  └────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

## 3. DeviceAPI Bridge

注入到每个游戏网页中的统一 API。PC 端和 Android 端接口完全相同。

```js
window.DeviceAPI = {

  // 获取设备代理
  device(logicalId) {
    return {
      invoke(capability, action, params),  // 调用设备能力方法（走 Capability 路由，有校验）
      writeProps(props),                     // 直接写属性字典（跳过能力层）
      sendMessage(msg),                    // 直接发消息给设备（跳过能力层）
      on(capability, event, callback),     // 监听能力事件（由能力的 events 定义）
      off(capability, event, callback),    // 取消能力事件监听
      onValue(capability, callback),       // 监听能力标量值变化
      offValue(capability, callback),      // 取消能力值监听
      onProperty(property, callback),      // 监听底层属性变化（低层接口）
      offProperty(property, callback),     // 取消属性监听
      onMessage(callback),                 // 监听设备原始消息（低层接口）
      offMessage(callback),                // 取消原始消息监听
      async read(property),                 // 读属性缓存值（异步，返回数组，顺序同 deviceMap）
      async readValue(capability),          // 读能力当前值（异步，返回数组）
      isMapped(),                          // 该逻辑设备是否已映射到物理设备 (bool)
    };
  },

  // 列出已连接设备及其能力
  getDevices(),  // → [{id, type, capabilities, connected}]

  // 当前会话的逻辑→物理映射（同 deviceMap，方法形式便于运行时查询）
  getDeviceMap(),  // → {logicalId: physicalId[]}  固定为数组，未映射则为 []

  // 写一条日志，回传宿主统一聚合（落 logService / 控制台）
  log(level, message, meta),  // level: 'debug'|'info'|'warn'|'error'

  // 监听宿主推送的系统日志（设备离线警告等）
  onSystemLog(callback),     // callback({level, message, meta})
  offSystemLog(callback),

  // 游戏元信息（由宿主在加载时注入）
  params,        // 用户启动时配置的参数
  deviceMap,     // {logicalId: physicalId[]} 一个逻辑设备可映射多个物理设备，恒为数组
  ready,         // Promise，Bridge 就绪后 resolve。游戏应 await DeviceAPI.ready 后再操作设备
};
```

> **writeProps vs invoke：** `invoke` 走 Capability 路由（有校验、映射）；`writeProps` 直接把属性字典发给设备（跳过能力层）；`sendMessage` 直接给设备发消息（跳过能力层）。

> **on(capability, event, cb)：** 监听能力定义的事件。能力内部封装了底层属性变化和设备消息的监听逻辑，游戏只需关心能力级事件，不用关心底层属性名或消息格式。不同设备底层实现可能不同，能力层屏蔽差异。

> **onValue / readValue：** 读取能力的归一化标量值。`onValue(capability, cb)` 的回调参数为 `(value, oldValue, physicalId)`；`readValue(capability)` 返回与 `deviceMap` 物理 ID 顺序一致的数组。玩法处理连续传感器值时应优先使用这两个入口。

> **onProperty / onMessage：** 低层接口，直接监听底层属性变化或设备原始消息。适合调试或能力体系未覆盖的场景。推荐优先使用 `on(capability, event)`。

> **属性缓存：** 宿主为每个物理设备维护一份属性快照，设备上报时实时更新（MQTT: `report`/`update` 消息；BLE: 属性特征通知）。`read(property)` 是**异步方法**（返回 Promise），从宿主缓存读取，返回**数组**——顺序与 `deviceMap` 中物理 ID 顺序一致。属性更新同时触发 `onProperty` 回调和相关能力事件。

> **能力值一致性：** `readValue`、`onValue` 和游戏启动时的首次 `readValue` 都使用同一个设备类型值解析规则。订阅只在解析后的标量实际变化时推送；底层属性变化但语义值不变时不重复回调。

> **deviceMap 恒为数组：** `deviceMap` 和 `getDeviceMap()` 的值**固定是 `physicalId[]`**（一个逻辑设备可对应多个物理设备），未映射时为空数组 `[]`，不会出现单值或 undefined。`device(id).isMapped()` 等价于「该逻辑设备的数组非空」。

> **多物理设备语义：** 当一个逻辑设备映射多个物理设备时：**下行广播**——`invoke`/`writeProps`/`sendMessage` 对所有映射物理设备执行同一操作；**上行逐设备触发**——`on(capability, event)` 回调中 `data` 包含触发源物理设备 ID（`data.physicalId`）及该设备的属性，每个物理设备独立触发、不合并。

> **ready：** Bridge 注入脚本保证在页面 DOM 可用前完成，但 WebSocket 连接（PC 端）或 JavaScriptChannel 注册（Android 端）需要时间。游戏在 `await DeviceAPI.ready` 之后再调用设备 API，确保通道就绪。

> **设备离线处理：** `invoke`/`writeProps`/`sendMessage` 调用时若设备离线，宿主不抛错，而是通过 `systemLog` 推送一条 `warn` 级别日志（「设备 X 可能离线」），游戏可通过 `onSystemLog` 监听。

### 使用示例

```js
// 通过能力调用（推荐，有校验）
DeviceAPI.device('motor').invoke('strength', 'set', { value: 128 });
DeviceAPI.device('punish').invoke('shock', 'start', { voltage: 30 });

// 直接写属性（跳过能力层）
DeviceAPI.device('motor').writeProps({ power: 128 });

// 直接发消息给设备（跳过能力层）
DeviceAPI.device('motor').sendMessage({ method: 'action', action: 'blink' });

// 监听能力事件（能力封装底层属性/消息差异）
DeviceAPI.device('sensor').on('sphincterPressure', 'pressureChange', (data) => {
  updateGauge(data.props.pressure);
  if (data.props.pressure > threshold)
    DeviceAPI.device('punish').invoke('shock', 'start', { voltage: 30 });
});

// 监听按钮事件（底层是设备消息，能力封装为统一事件）
DeviceAPI.device('qtz').on('buttonInput', 'pushDown', () => {
  onPushDown();
});

// 读取当前值（异步，返回数组，顺序同 deviceMap 中物理 ID）
const pressures = await DeviceAPI.device('sensor').readValue('sphincterPressure'); // → [72] 或 [72, 68]

DeviceAPI.device('sensor').onValue('sphincterPressure', (value, oldValue, physicalId) => {
  console.log(physicalId, oldValue, '→', value);
});

// 可选设备：未映射则跳过相关逻辑
if (DeviceAPI.device('punish').isMapped())
  DeviceAPI.device('punish').invoke('shock', 'start', { voltage: 30 });

// 回传日志到宿主统一聚合
DeviceAPI.log('info', '进入惩罚阶段', { count: 3 });

// 低层接口：直接监听底层属性变化
DeviceAPI.device('sensor').onProperty('pressure', (value, oldValue) => {
  console.log('pressure:', oldValue, '→', value);
});

// 低层接口：直接监听设备原始消息
DeviceAPI.device('qtz').onMessage((msg) => {
  console.log('raw message:', msg);
});
```

## 4. 游戏页面结构

```
games/
├── pressure-edging/
│   ├── index.html        // 游戏主页面（逻辑+UI+内联元数据，单文件即可运行）
│   ├── style.css         // 样式（可选）
│   └── game.js           // 逻辑（可选，也可内联）
└── maid-punishment/
    └── index.html        // 元数据内联其中
```

### 元数据（内联在 index.html 中）

元数据全部内联在 index.html 里，**不使用独立 manifest.json**。游戏始终是单文件自包含的，既能经宿主启动，也能直接打开运行：

```html
<!-- index.html 的 <head> 中 -->
<script type="application/json" id="game-manifest">
{
  "id": "pressure-edging",
  "title": "压力寸止",
  "description": "通过压力传感器控制强度，超阈值惩罚",
  "version": "1.0.0",
  "devices": [
    { "id": "sensor",  "capabilities": ["sphincterPressure", "reporting"], "required": true },
    { "id": "motor",   "capabilities": ["strength"],              "required": true },
    { "id": "punish",  "capabilities": ["shock"],                 "required": false }
  ],
  "params": [
    { "key": "duration",  "type": "number", "default": 300, "label": "时长(s)" },
    { "key": "threshold", "type": "number", "default": 80,  "label": "压力阈值" }
  ]
}
</script>
```

> 游戏页面用 `document.getElementById('game-manifest')` 读取自身元数据；宿主在扫描/启动游戏时抓取 index.html、解析同一个 `<script id="game-manifest">` 内联块。只有这一处来源，不存在副本，无需同步。

### 两种入口的运行差异

| | 经宿主启动 | 直接打开网页（脱离宿主） |
|---|---|---|
| **设备校验** | 宿主按 devices 校验能力，required 缺失则拦截 | 无宿主拦截；页面用 `isMapped()` 自检，缺 required 设备时自行降级/提示 |
| **deviceMap** | 用户在宿主 UI 选定，注入 `DeviceAPI.deviceMap`（恒为 `physicalId[]`） | Bridge 按 devices 的 capabilities **自动匹配在线设备**填入数组；可选设备匹配不到则为 `[]` |
| **params** | 用户在宿主参数 UI 填写后注入 | 页面读内联块的 `default` 值作为 `DeviceAPI.params` |

> **页面侧写法不变：** 无论哪种入口，游戏代码都只读 `DeviceAPI.params` 和 `DeviceAPI.deviceMap`、并用 `device(id).isMapped()` 判断可选设备。降级逻辑由 Bridge/宿主统一兜底，游戏页面无需区分自己跑在哪种入口下。

## 5. 设备抽象层

**核心设计：能力和操作都是"方法"，最底层调用两个原语完成设备交互。**

| 层 | 职责 | 输出 |
|---|---|---|
| **Capability（能力）** | 通用标准方法，跨设备复用 | 调用底层原语 |
| **Operation（操作）** | 设备自带方法，可调用能力或原语 | 调用底层原语 |
| **Transport** | 底层原语的具体实现 | MQTT publish / BLE write |

### 5.1 底层原语

所有方法最终调用两个原语：

| 原语 | MQTT | BLE |
|---|---|---|
| `ctx.writeProps(props)` | 自动附加 `method:'update'`，publish `{method:'update', ...props}` 到 `/drecv/{id}` | 逐属性写 GATT 特征值（通过用户描述定位 UUID） |
| `ctx.sendMessage(msg)` | 消息对象作为 JSON publish 到 `/drecv/{id}`（msg 自带 method 字段） | UTF-8 JSON 写入命令通道 `0xFF03`（上限 256 字节） |

#### 5.1.1 属性缓存与上行更新

宿主为每个物理设备维护一份**属性快照**（key-value 字典），设备上报时实时合并更新：

| Transport | 更新来源 |
|---|---|
| MQTT | `/dpub/{id}` 收到的 `method:'report'`（整体合并）和 `method:'update'`（单属性或整体合并）消息 |
| BLE | 属性特征的通知（notify），属性值变化时自动推送 |

**属性更新时触发事件链：**

```
设备上报 → 宿主更新属性快照
  ├─ 触发 propertyChange 推送（低层，供 onProperty 使用）
  ├─ 检查能力 events 的 watch/trigger → 满足则触发 capabilityEvent 推送（供 on 使用）
  └─ 检查能力 value.watch → 解析值变化时触发 capabilityValueChange（供 onValue 使用）
```

游戏侧 `read(property)` 异步从宿主缓存读取（返回 Promise），不发起设备查询。返回数组，顺序与 `deviceMap` 物理 ID 一致。

`readValue(capability)` 从同一快照按设备类型解析能力值；因此一次性读取、订阅变化和启动初始化不会出现不同语义。

### 5.2 Capability — 能力方法定义

能力 = 通用的、标准化的方法。每个 action 内部直接调用底层原语：

```js
export const shock = {
  key: 'shock',
  actions: {
    start: (ctx, params) => ctx.writeProps({ e_vol: params.voltage, e_en: 1 }),
    stop:  (ctx) => ctx.writeProps({ e_en: 0 }),
  },
  events: {}, // shock 无上行事件
};

export const strength = {
  key: 'strength',
  actions: {
    set: (ctx, params) => ctx.writeProps({ power: params.value }),
  },
};

export const sphincterPressure = {
  key: 'sphincterPressure',
  actions: {}, // 纯上行能力，无下行动作
  value: {
    source: { op: 'prop', key: 'pressure' },
    watch: ['pressure'],
  },
  events: {
    pressureChange: {
      watch: [{ type: 'prop', key: 'pressure' }],
      trigger: (data) => true,
    },
  },
};

export const buttonInput = {
  key: 'buttonInput',
  actions: {},
  events: {
    pressed: {
      watch: [{ type: 'msg', match: { method: 'action', action: 'key_clicked' } }],
      trigger: (data) => true,
    },
    pushDown: {
      watch: [{ type: 'msg', match: { method: 'low' } }],
      trigger: (data) => true,
    },
    pushUp: {
      watch: [{ type: 'msg', match: { method: 'high' } }],
      trigger: (data) => true,
    },
  },
};

export const distance = {
  key: 'distance',
  actions: {
    configure: (ctx, params) => ctx.writeProps({
      low_band: params.lowBand, high_band: params.highBand, report_delay_ms: params.reportDelayMs
    }),
  },
  events: {
    enterLow: {
      watch: [{ type: 'msg', match: { method: 'low' } }],
      trigger: (data) => true,
    },
    enterHigh: {
      watch: [{ type: 'msg', match: { method: 'high' } }],
      trigger: (data) => true,
    },
  },
};
```

> **事件 trigger 参数 data：** `data.props`（设备属性快照）、`data.changed`（变化属性 key）、`data.msg`（收到的消息对象）。watch 支持混合监听属性和消息。

#### 5.2.1 能力可读值

连续传感器能力用声明式 `value` 定义标量读取契约。首期解释器只支持：

- `prop`：返回快照中的单个属性。
- `anyEquals`：任一属性数值化后等于目标值则返回 `on`，否则返回 `off`；数字和数字字符串等价。

规则必须是可序列化数据，禁止在设备定义中使用 JS 闭包。PC（JavaScript）与 Android（Dart）各自解释同一规则模型。解析读取的是“已有快照 + 本次上报”合并结果，缺失字段沿用已有快照；没有历史值时按未触发处理。

### 5.3 DeviceType — 设备类型声明

```js
// 标准设备：声明能力列表，用能力默认实现
{ type: 'DIANJI',   capabilities: ['shock'] }
{ type: 'CUNZHI01', capabilities: ['sphincterPressure', 'tiptoePressure', 'strength', 'shock', 'reporting'] }

// 特殊设备：覆写某个能力的 action 或 event 的底层映射
{ type: 'SPECIAL', capabilities: {
    shock: {
      actions: {
        start: (ctx, params) => ctx.writeProps({ shock_v: params.voltage * 10 }),
        stop:  (ctx) => ctx.writeProps({ shock_v: 0 }),
      },
    },
    strength: 'strength',  // 字符串 = 用能力默认实现
}}

// QTZ 用按钮快照派生 tiptoePressure，不伪造 pressure1 属性
{ type: 'QTZ', capabilities: {
    distance: 'distance',
    buttonInput: 'buttonInput',
    reporting: 'reporting',
    tiptoePressure: { value: {
      source: { op: 'anyEquals', keys: ['button0', 'button1'], equals: 1, on: 200, off: 0 },
      watch: ['button0', 'button1'],
    }},
}}
```

> **解析优先级：** DeviceType 覆写（actions/events/value）→ Capability 默认实现 → 报错未实现。设备清单详见 `device/device-registry.md`。

### 5.4 Operation — 设备自带方法

操作 = 设备特有的编排方法，通过 invoke 函数实现：

```js
// 单能力调用
{
  key: 'start', name: '启动',
  invoke: (ctx, params) => {
    ctx.cap('strength', 'set', { value: 255 });
  }
}

// 多能力编排
{
  key: 'start', name: '启动',
  invoke: (ctx, params) => {
    ctx.cap('shock',    'start', { voltage: 24 });  // 立即下发
    ctx.cap('strength', 'set',   { value: 255 });   // 立即下发
  }
}

// 也可直接调底层原语
{
  key: 'blink', name: '闪烁',
  invoke: (ctx) => {
    ctx.sendMessage({ method: 'action', action: 'blink' });
  }
}
```

**invoke 内 ctx 提供的入口：**

| 入口 | 作用 |
|---|---|
| `ctx.cap(capability, action, params)` | 调用本设备能力方法（立即下发，复用校验） |
| `ctx.writeProps(props)` | 直接写属性（立即下发） |
| `ctx.sendMessage(msg)` | 直接发消息（立即下发） |

> **参数统一为 params**（plain object 字典）。每次 ctx.cap() / ctx.writeProps() / ctx.sendMessage() 都立即下发，不做收集合并。方法尽量一次性，复杂场景可多次调用。

## 6. 两端宿主实现

**PC 端 (Node.js 后端)**
- 客户端：Electron 内嵌 / 普通浏览器，统一走 WebSocket Bridge
- 后端：Express（游戏静态服务）+ WebSocket Server
- MqttTransport 对接设备

**Android 端 (Flutter)**
- 游戏页面跑在 WebView 中，前台运行
- Bridge 通信: JavaScriptChannel + evaluateJS
- BleTransport 对接设备
- 游戏文件从 assets 或远程加载

### PC 架构：服务器 + 客户端

```
┌─────────────────────┐      ┌─────────────────────┐
│ 客户端 (Electron/浏览器) │      │ 客户端 (浏览器)        │
│ 游戏网页 + DeviceAPI │      │ 游戏网页 + DeviceAPI │
└──────────┬──────────┘      └──────────┬──────────┘
           │ WebSocket                   │ WebSocket
           └──────────────┬──────────────┘
                          ▼
            ┌───────────────────────────┐
            │ Node.js 后端               │
            │ WebSocket Server          │
            │ Bridge 路由 → 设备抽象层  │
            │ MqttTransport → 设备      │
            └───────────────────────────┘
```

> PC 端本质是 C/S 架构。后端管设备通信，前端只负责 UI + 通过 WebSocket 调用 DeviceAPI。Electron 和浏览器共用同一套 WebSocket Bridge。

### Bridge 通信协议 (两端统一)

```js
// 网页 → 宿主 (请求)
{ id: "uuid", action: "invoke", deviceId: "motor", capability: "strength", actionName: "set", params: { value: 128 } }
{ id: "uuid", action: "writeProps", deviceId: "motor", props: { power: 128 } }
{ id: "uuid", action: "sendMessage", deviceId: "motor", msg: { method: "action", action: "blink" } }
{ id: "uuid", action: "read", deviceId: "sensor", property: "pressure" }
{ id: "uuid", action: "readValue", deviceId: "sensor", capability: "sphincterPressure" }
{ id: "uuid", action: "subscribe", deviceId: "sensor", capability: "sphincterPressure", event: "pressureChange" }
{ id: "uuid", action: "unsubscribe", deviceId: "sensor", capability: "sphincterPressure", event: "pressureChange" }
{ id: "uuid", action: "subscribeProperty", deviceId: "sensor", property: "pressure" }
{ id: "uuid", action: "unsubscribeProperty", deviceId: "sensor", property: "pressure" }
{ id: "uuid", action: "subscribeValue", deviceId: "sensor", capability: "sphincterPressure" }
{ id: "uuid", action: "unsubscribeValue", deviceId: "sensor", capability: "sphincterPressure" }
{ id: "uuid", action: "subscribeMessages", deviceId: "qtz" }
{ id: "uuid", action: "unsubscribeMessages", deviceId: "qtz" }
{ id: "uuid", action: "getDevices" }
{ id: "uuid", action: "getDeviceMap" }
{ id: "uuid", action: "log", level: "info", message: "...", meta: {} }   // 无需响应

// 宿主 → 网页 (响应 + 推送)
{ id: "uuid", result: ... }                            // 请求响应
{ id: "uuid", error: "device not found" }                // 错误
{ event: "capabilityEvent", deviceId: "sensor", capability: "sphincterPressure", eventName: "pressureChange", data: { props: {...}, changed: "pressure" } }  // 能力事件推送
{ event: "capabilityValueChange", deviceId: "sensor", capability: "sphincterPressure", value: 72, oldValue: 68, physicalId: "sensor-1" } // 能力标量值推送
{ event: "propertyChange", deviceId: "sensor", property: "pressure", value: 72, oldValue: 68 }  // 属性变化推送（低层）
{ event: "deviceMessage", deviceId: "qtz", payload: { method: "low" } }  // 原始消息推送（低层）
{ event: "systemLog", level: "warn", message: "设备 motor 可能离线", meta: { deviceId: "motor" } }  // 宿主系统日志推送
```

> **上行数据来源（两端等价）：** PC 端 MqttTransport 订阅 `/dpub/{id}` 接收属性变化和消息；Android 端 BleTransport 订阅属性特征通知和 `0xFF01` 消息通知。宿主按能力的 events 定义匹配 watch/trigger，满足条件时推送 `capabilityEvent` 给网页。

## 6.5 运行模型：游戏自驱动，无宿主 loop

游戏逻辑**完全在页面 JS 内自驱动**。计时、阶段切换、强度递增、惩罚检测等节奏由页面自己的 `setInterval` / `requestAnimationFrame` 维护。**宿主不提供 `loop()` 回调**——游戏即网页，逻辑与 UI 同处一份 HTML/JS，状态也由页面自身持有，不再经宿主 `emitState`/`emitUi` 往返。

**宿主只负责**
设备调用路由、能力事件推送（`capabilityEvent`）、属性变化推送（`propertyChange`）、原始消息推送（`deviceMessage`）、日志聚合（`DeviceAPI.log`）、会话结束安全停机（见 §10）。

**页面负责**
全部玩法逻辑、计时与状态机、UI 渲染、按用户操作直接调用 `DeviceAPI`。无需把动作回传宿主再下发。

> ⚠️ 页面定时器在后台标签/息屏时可能被节流，因此**设备安全不能依赖页面逻辑**。关键安全（停止电击/强度归零）由宿主的 `close` 兜底强制保证，见 §10。

## 7. 能力体系

完整设备清单与能力总表详见 `device/device-registry.md`。以下为能力概览：

| Capability | Actions | Events | 设备 |
|---|---|---|---|
| strength | set(value:0-255) | — | PJ01, TD01, OSR6, CUNZHI01 |
| shock | start(voltage), stop() | — | DIANJI, CUNZHI01 |
| lock | setOpen(open:bool) | — | ZIDONGSUO |
| sphincterPressure | — | pressureChange | QIYA, CUNZHI01 |
| tiptoePressure | — | pressureChange | CUNZHI01 |
| distance | configure(lowBand, highBand, reportDelayMs) | enterLow, enterHigh | QTZ |
| buttonInput | — | pressed, pushDown, pushUp | QTZ, ZIDONGSUO |
| weight | — | weightChange | DZC01 |
| reporting | setReportDelay(ms) | — | QIYA, QTZ, DZC01, CUNZHI01 |

## 8. 游戏开发流程

```js
// 1. 创建游戏目录
games/my-game/
└── index.html

// 2. index.html 的 <head> 内联元数据，声明设备需求和参数
<script type="application/json" id="game-manifest">
{ "id": "my-game", "title": "我的游戏", "devices": [...], "params": [...] }
</script>

// 3. index.html 中使用 DeviceAPI
<script>
  DeviceAPI.device('sensor').on('sphincterPressure', 'pressureChange', (data) => {
    const val = data.props.pressure;
    document.getElementById('gauge').style.width = val + '%';
    DeviceAPI.device('motor').invoke('strength', 'set', { value: val * 2 });
  });
</script>
```

> 浏览器直接打开即可调试（连 WebSocket 到后端）；部署即放入 app assets 或远程 URL。

## 9. 共享代码

**两端共享**
- 游戏页面 (HTML/JS)
- 内联元数据 (game-manifest)
- 能力定义 (JSON)
- 设备类型声明
- DeviceAPI Bridge 注入脚本

**各端独立**
- PC: Express 静态服务
- PC: WebSocket Bridge 后端
- PC: MqttTransport
- Android: WebView 容器
- Android: Dart Bridge 处理
- Android: BleTransport

## 10. 前台运行保障

| 措施 | 说明 |
|---|---|
| 屏幕常亮 | 游戏运行时 WakeLock，防止息屏 |
| 前台通知 | 显示"游戏运行中"持久通知，防止系统回收 |
| 切换提醒 | 用户切出时 toast 提示"游戏可能中断" |
| **会话结束安全停机** | 以下情况触发宿主对该会话所有映射设备调用 `close` 操作：**(1)** 游戏主动调用结束；**(2)** 连接断开超过 180 秒未重连；**(3)** 下一个游戏启动时（前一个会话的设备自动 close）。不依赖游戏页面执行收尾逻辑——页面崩溃也能保证设备停止。 |
| BLE 连接保活 | Dart 原生层维持 BLE 连接，不依赖 WebView |

> ⚠️ WebView JS 前台执行完全稳定。BLE 连接在 Dart 原生层维护，即使 WebView 偶尔卡顿也不影响连接。

> **close 兜底是强制的、放在宿主层。** 每个设备类型都声明一个 `close` 操作定义其安全停机指令（电机归零、停止电击、传感器恢复空闲上报频率等）。这是设备安全的最后一道防线，独立于游戏逻辑。
