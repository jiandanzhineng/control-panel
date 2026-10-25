# 游戏 common JS 运行时计划

## 文档状态

- 日期：2026-07-21
- 状态：待实施
- 依赖：[多游戏配音问题审查与修复计划](2026-07-21-game-voice-review-and-remediation.md)

## 目标

为游戏提供一个类似 `DeviceAPI` 的统一 common JS，使多个游戏共享浏览器侧运行能力，而不在每个 `game.js` 中复制实现。

首个迁移目标是语音播放。common JS 后续可以承载其他经过验证的共性能力，但不能演变成无边界的工具集合。

## 设计结论

采用宿主提供、游戏显式加载的共享脚本：

```html
<script src="/bridge-api/device-api-bridge.js"></script>
<script src="/bridge-api/game-common.js"></script>
```

脚本由 `backend/public/game-common.js` 提供，暴露 `window.GameCommon`。它与 `DeviceAPI` 是并列模块，不并入 `DeviceAPI`：

- `DeviceAPI` 负责设备映射、读取、订阅和动作调用。
- `GameCommon` 负责纯浏览器侧、跨游戏复用的运行能力。
- 两者可以协作，例如 `GameCommon` 在存在 `DeviceAPI.log` 时使用它记录错误，但不能要求 WebSocket 就绪才能播放语音。

不采用 iframe 宿主运行后动态注入。显式 `<script>` 加载顺序可预测，也与当前 `DeviceAPI` 用法一致；动态注入容易与游戏自己的启动脚本竞态，并增加远程、缓存游戏和 CSP 的兼容成本。

## 模块 seam

`window.GameCommon` 是外部 seam。游戏和测试只通过它的 interface 使用共享能力，不依赖内部 `Audio`、事件监听器、队列或缓存结构。

首期 interface：

```js
const voice = GameCommon.voice.create({
  basePath: 'voices',
  enabled: true,
  log(level, message) {},
});

voice.play('edging_start', {
  kind: 'intro',
  isValid: () => game.running,
});
voice.stop();
voice.setEnabled(false);
voice.destroy();
```

`voice` 模块应隐藏：

- 单活动音频约束。
- `critical`、`intro`、`state`、`info` 优先级和抢占规则。
- 最新有效状态排队与过期状态丢弃。
- 自动播放拒绝后的首次手势恢复。
- `ended`、`error`、`pause` 和资源释放。
- 相同 key 正在播放时的防重复行为。

## common 能力准入规则

新增能力必须同时满足：

1. 至少有两个真实游戏调用者；一个调用者只说明存在假设 seam。
2. 删除 common 模块后，复杂逻辑会重新散落到多个游戏，而不是只多一层转发。
3. interface 小于被隐藏的规则集合，并能作为稳定测试面。
4. 不依赖某一款游戏的状态名称、DOM 结构或设备角色。
5. 能在本地游戏、缓存游戏和远程代理游戏中以相同方式运行。

以下内容不能直接因为“常用”就放入 common JS：

- 只有一行的 `clamp`、格式化等简单函数。
- 某个游戏特有的状态机或设备惩罚规则。
- 会掩盖 `DeviceAPI` 能力契约的设备字段适配。
- 未确定生命周期和错误语义的临时工具函数。

## 候选后续能力

候选项需要单独评审，通过准入规则后再进入 interface：

- 游戏生命周期清理：统一登记并释放 timer、DOM listener 和临时资源。
- 轻量绑定渲染：当前多个游戏重复的 `[data-bind]` 文本更新。
- 游戏日志适配：页面日志与 `DeviceAPI.log` 的一致格式和降级行为。

首期只实现 `voice`，不同时抽取上述候选项。

## 加载与兼容

- Electron 前端已经将 `/bridge-api` 代理到后端，并添加内部访问头；新脚本复用该链路。
- 本地 `/games`、缓存 `/games/cache` 和远程 `/games/proxy` 都在控制台同源 iframe 中运行，可以使用绝对路径 `/bridge-api/game-common.js`。
- 游戏若脱离控制台直接在第三方站点打开，`GameCommon` 与 `DeviceAPI` 一样不保证可用；游戏可以选择检测全局并降级。
- 音频文件仍属于各游戏包，`basePath` 相对游戏页面解析；common JS 不集中存放业务台词。
- 首期使用普通浏览器 JavaScript，不要求打包器和 Node 能力。

## 版本与演进

- `GameCommon.version` 暴露 semver 字符串，便于游戏日志和兼容诊断。
- interface 只做向后兼容扩展；删除或改变语义需要主版本升级。
- 脚本由宿主统一更新，游戏不复制 common 源文件。
- 若 registry 未来要求游戏包脱离控制台独立运行，再提供构建期内嵌 adapter；不要现在为假设场景增加第二套实现。

## 实施阶段

### 阶段一：固定语音契约

1. 以当前三款游戏本地播放器的测试作为行为基准。
2. 固定优先级、抢占、排队、自动播放和禁用语义。
3. 明确开场保护规则：普通事件不能中断，critical 可以中断。

### 阶段二：实现 common JS

1. 新增 `backend/public/game-common.js`。
2. 实现 `GameCommon.voice.create()`，每次创建独立的页面内播放器实例。
3. 使用内部 Audio adapter 便于测试，不把 adapter 暴露给游戏调用者。
4. 增加 `/bridge-api/game-common.js` 静态访问测试。

### 阶段三：迁移游戏

按游戏独立迁移和提交：

1. `drink-pee-unlock`
2. `pressure-edging`
3. `pressure-edging-v2`

每次迁移删除游戏内播放器实现，但保留业务层的“在什么状态播放哪个 key”。

### 阶段四：文档与样例

- 更新 `play-registry/docs/device-api.html` 或新增 game common 文档。
- 在游戏开发样例中展示加载顺序、降级检测和销毁方式。
- 记录 common 能力准入规则，防止继续堆积浅层工具。

## 测试计划

### 模块测试

- 同时最多一个活动 Audio。
- critical 抢占 intro/state/info。
- intro 阻止普通状态抢占，并在结束后只播放最新且仍有效的状态。
- info 在忙时跳过。
- 相同 key 播放期间不重复创建，结束后允许再次播放。
- `play()` reject 后只注册一组手势监听，并只恢复最新有效事件。
- `setEnabled(false)` 和 `destroy()` 清理音频、队列和监听器。

### 集成测试

- `/bridge-api/game-common.js` 只允许内部代理来源访问。
- 本地游戏、缓存游戏和远程代理游戏均能加载脚本。
- 没有映射设备或 Bridge 断开时，语音模块仍能工作。
- 三款游戏迁移前后的语音事件序列一致。

## 提交边界

1. common JS 模块和模块测试。
2. 静态路由、代理和访问测试（如现有路由无需修改，只提交测试）。
3. 三款游戏逐个迁移，每款一个 commit。
4. 文档与 registry 样例。

不与 CUNZHI/QTZ 能力值重构、游戏状态机调整或音频文案修改混在同一提交。

## 完成标准

- 三款游戏不再包含重复的播放器实现。
- 游戏只需理解 `create/play/stop/setEnabled/destroy` 和四种事件 kind。
- 自动播放、抢占、排队和清理只在 common 模块维护和测试。
- 本地、缓存、远程代理三种游戏来源加载行为一致。
- `DeviceAPI` interface 不因 common JS 引入而膨胀。

## 非目标

- 本计划不在当前配音修复中实施。
- 不自动重写第三方游戏 HTML 注入脚本。
- 不把游戏业务状态机迁入 common JS。
- 不集中托管各游戏的 MP3 和台词。
- 不一次性抽取所有重复小函数。
