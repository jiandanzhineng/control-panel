# 远程游戏与客户端级远控方案

> 状态：宏观方案，客户端级远控范围已确认；JS 运行层待做原型验证

## 1. 目标

- A 是设备所在端，也是唯一游戏逻辑执行端。
- B 加入后使用同一游戏包和同一 UI，查看 A 的游戏状态并发送控制操作。
- A、B 都可以修改全部游戏参数、开始、暂停、继续和停止；停止即结束游戏。
- B 断线不停止 A 的游戏，A 继续运行。
- A 授权客户端级远控后，B 可以浏览游戏、配置并启动新游戏；所有游戏仍在 A 执行。
- 客户端级远控包含设备管理、游戏开始设置页和游戏运行页；普通设置页不纳入。
- 首版只支持一个 B，降低并发和控制冲突复杂度。

## 2. 两层远控

### 游戏级远控

只远控当前游戏。A 持有传感器、状态机和设备连接；B 加载同一游戏的远程渲染模式，发送参数和生命周期命令。

### 客户端级远控

A 在远程连接页明确授权后，B 获得 Control Panel 内部的受限客户端控制权限。B 可以打开设备管理、游戏库、游戏开始设置页和游戏运行页，配置设备映射和全部参数、启动新游戏、暂停/继续/停止当前游戏。B 的操作由 A 的本地客户端执行，A 返回页面状态和结果。

普通设置页、操作系统桌面、文件系统、任意 Electron IPC 和未审计的设备指令不开放。

## 3. 会话与通道

复用现有 `roomApiService`、房间码、MQTT 凭证、心跳和 `rooms/{roomId}` topic。把当前远程设备投影的公共部分抽成远程会话层，保留已有 `projection.*` 消息，同时增加客户端和游戏消息。

角色固定为：A=`owner`，B=`operator`。A 创建会话并授权，B 加入；首版 capacity=2。A 可以撤销授权或结束会话。

建议消息方向：

- A → B：`client.snapshot`、`client.response`、`game.hello`、`game.snapshot`、`game.log`、`session.revoked`。
- B → A：`client.navigate`、`client.request`、`game.setParams`、`game.start`、`game.pause`、`game.resume`、`game.stop`、`game.action`。

所有写操作携带 `messageId`、`sessionEpoch` 和递增 `revision`。A 执行后返回确认和最新快照；旧会话、重复消息和过期 revision 直接丢弃。

## 4. 游戏运行时

现有游戏是页面自驱动的 IIFE，`DeviceAPI`、状态机、设备输出和 UI 在同一页面。新增两种运行时适配：

- `HostRuntime`：只在 A 执行，读取本地 DeviceAPI，运行状态机，调用本地设备，并发布可序列化的 `GameViewModel`。
- `RemoteRuntime`：只在 B 执行，订阅 `GameViewModel` 并渲染同一 UI，按钮只发送命令，不读取或控制设备。

游戏逻辑需要从页面路由生命周期中提升为客户端会话生命周期。A 切换到其它 Control Panel 页面时，游戏不能因为 `GameCurrentView` 卸载而停止；应由持久的 HostGameSession/隐藏运行载体继续运行。

## 5. 移动端运行层与锁屏

移动端的 HostRuntime 不应依赖 WebView 存活。游戏状态机、设备订阅、设备下发、远程房间连接和状态快照由 Flutter/Dart 运行层承载；WebView 只订阅快照、渲染 UI、发送命令。WebView 被锁屏节流、渲染进程重建或页面重新创建时，运行层继续工作，恢复后重新绑定并读取快照。

Android 优先复用现有 `flutter_foreground_task` 的前台服务、wake lock 和 MQTT 通道，将 GameHostRuntime 纳入同一服务；不能只依赖 `WakelockPlus`，因为它主要防止屏幕自动熄灭，不能覆盖用户主动锁屏。当前 `GameRunPage` 的 `onPause` 安全停机逻辑要改为“解绑显示层”，只有用户明确停止、会话结束、超时或异常安全收尾才停止运行层。

游戏逻辑继续使用 JavaScript，但不再要求它运行在 WebView 页面里。每个游戏包拆成与浏览器无关的 `game-core.js` 和浏览器渲染适配层：核心只处理状态机、输入、计时、随机数和设备意图，页面只渲染 `GameSnapshot` 并发送命令。Android 首选在前台服务承载的 Dart isolate 中嵌入 QuickJS（当前候选为 `flutter_js`），由宿主显式调用 `core.step(monotonicNow, events)`；不能让关键逻辑依赖 JS `setInterval`，也不能让核心直接访问 DOM、Canvas、Audio 或 WebSocket。PC 端由 Electron 主进程/Worker 使用同一份 JS Core，A、B 只更换 HostRuntime/RemoteRuntime。

`flutter_js` 的 Android 实现是 QuickJS，iOS 使用系统 JavaScriptCore，并提供独立 isolate 运行入口；这证明技术路径可行，但还不等于本项目已完成后台/锁屏验收。Android 前台服务仍需通知、必要的 partial wake lock、快照持久化和重启恢复；厂商杀进程、iOS/OHOS 后台限制仍需分别验证。具体引擎比较和 `surge-edging` 拆分边界见移动端调研文档。

## 6. 三阶段寸止落地

A 保留气压采集、突变检测、平静期/中期/边缘期/冷却期/结束前阶段、强度调节、电击和安全收尾。B 接收压力、强度、阶段、计时、边缘次数、日志和曲线采样。

当前页面的暂停、加 10 强度、电击一次、中间压力微调等动作统一改成命令入口；A 和 B 发出的命令都进入同一条 HostRuntime 命令队列。参数修改由 A 校验并广播生效值。

## 7. 客户端级远控实现

B 运行同一套 Vue 客户端，但注入 `RemoteClientApi`：

1. 游戏库和配置页读取 A 返回的游戏、设备能力、设备映射和参数快照。
2. B 的路由、表单和按钮转换成 `client.request`，由 A 调用现有本地服务完成。
3. A 返回操作结果、错误和新的页面快照，B 只负责渲染。
4. B 启动新游戏时，A 按现有启动路径执行：结束旧玩法、按 ADR 复位设备、加载新游戏、建立新的 HostRuntime。
5. B 看到的游戏页使用同一游戏资源和 UI，但通过 `RemoteRuntime` 显示 A 的状态。

这样 B 看起来像在直接操作 A 的 Control Panel，但实际只有白名单内的页面动作能到达 A，不开放任意 HTTP、IPC 或脚本执行。

## 8. 生命周期与安全

- A、B 都可停止游戏；停止后 HostRuntime 结束并执行设备复位。
- B 断线只更新在线状态，A 的游戏继续运行；A 仍可本地停止或撤销授权。
- A 客户端异常退出、会话过期或本地安全收尾触发时，沿用现有玩法退出复位路径。
- A 本地保留急停和最终控制权，远程命令不能绕过本地能力校验、参数范围和设备安全限制。
- A 授权客户端级远控不等于永久授权；房间结束或撤销后，B 立即失去操作能力。

## 9. 交付顺序

1. 抽取远程会话公共层，保留远程设备投影回归。
2. 实现客户端授权、单 B 加入、`client.request/response` 和游戏库/配置页远程镜像。
3. 实现持久 HostGameSession 与 `HostRuntime/RemoteRuntime` 协议。
4. 改造三阶段寸止，验证参数、开始、暂停、继续、停止和状态镜像。
5. 增加断线、重复命令、旧会话、切换新游戏和设备复位测试。
6. 用两个真实客户端联调，再做真实设备安全验证。

## 10. 已确认边界与验证项

- A、B 都可修改全部游戏参数，包括运行中允许修改的参数；A 负责校验并广播最终生效值。
- 设备管理、游戏库、游戏开始设置页和游戏运行页纳入客户端级远控；普通设置页不纳入。
- 首版不传输 A 的音频流，B 先完成视觉 UI 和操作同步；语音/音频同步作为后续独立能力。
- Android 按锁屏后继续运行的目标设计，但前台服务、厂商后台策略、进程重启和真实设备安全收尾必须完成验证后才能发布该能力。
