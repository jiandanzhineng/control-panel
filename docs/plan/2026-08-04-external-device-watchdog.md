# 外部客户端设备看门狗改造说明

> 状态：已实施，证据等级 `mock-tested`
>
> 目标：让小念、酒馆插件等外部客户端通过心跳刷新倒计时；客户端失联、主动退出或倒计时到期时，由主客户端统一停止全部执行设备。

## 1. 已确认范围

| 编号 | 决定 | 本轮处理 |
| --- | --- | --- |
| M1 | 不修改监听地址 | 不做 |
| M2 | 不新增接口版本或契约体系 | 不做 |
| M3 + M4 | 合并为外部客户端设备看门狗：心跳续租，超时后全设备停止 | 做 |
| M5 | 不协调控制权，所有调用方都可以控制设备 | 不做 |
| M6 | 外部客户端直接复用 `reporting.setReportDelay` | 不新增租约接口 |
| M7 | 不增加版本或功能查询接口 | 不做 |
| M8 | 配网、BLE 和 MQTT 接入迁移 | 不在本轮范围 |
| M9 | 小念、酒馆、AI、HUD 等业务代码不得进入主仓 | 持续遵守 |

## 2. 安全结论

看门狗能解决“外部客户端崩溃、断线或忘记停止”这一类故障，但不能替代设备固件自身的安全保护，也不能证明物理设备已经停止。

`600` 秒可以作为允许的最大租期，但不适合作为默认安全值：客户端失联后，真实输出最多可能继续十分钟。建议：

- 默认租期：`30` 秒。
- 允许范围：`5-600` 秒。
- 外部客户端刷新间隔：不超过租期的三分之一；默认每 `10` 秒刷新。
- 外部客户端每次开始非零输出前必须先成功刷新一次。
- 外部客户端正常退出时必须主动调用全设备停止，不能只删除本地定时器。

如果产品最终坚持默认 `600` 秒，只需调整默认配置；实现和测试仍按可配置租期设计。

## 3. 行为约束

1. 每个外部客户端使用稳定且非空的 `clientId`，例如 `xiaonian-runtime`、`sillytavern-bridge`。
2. 不设置独占控制者，不拒绝其它客户端的设备控制请求。
3. 主客户端按 `clientId` 分别保存租约；任意一个已登记租约过期，立即停止全部具有 `shock` 或 `strength` 能力的设备。
4. 任意租约过期或收到主动停止请求后，清空全部租约。外部客户端必须重新心跳后才能按约定继续输出。
5. 刷新操作必须幂等：同一个 `clientId` 重复请求只更新截止时间，不创建重复计时器。
6. 旧计时器不得停止新租约。实现必须使用租约代次或截止时间校验，忽略已经失效的计时回调。
7. 一台设备停止失败不能阻断其它设备；返回结果必须逐台记录“已发送、已确认或失败”。
8. “全部设备停止”只处理执行能力 `shock` 和 `strength`，不修改传感器上报频率，也不自动开锁/关锁。
9. 看门狗是外部客户端自愿遵守的失联保护，不改造现有设备控制路由，也不要求主客户端内置玩法登记租约。

## 4. HTTP interface

新增挂载点：`/api/device-watchdog`。

### 4.1 创建或刷新租约

```http
POST /api/device-watchdog/heartbeat
Content-Type: application/json

{
  "clientId": "sillytavern-bridge",
  "ttlSeconds": 30
}
```

成功响应：

```json
{
  "ok": true,
  "clientId": "sillytavern-bridge",
  "ttlSeconds": 30,
  "expiresAt": "2026-08-04T12:00:30.000Z"
}
```

约束：

- `clientId`：`1-96` 个字符，只允许字母、数字、点、下划线、冒号和短横线。
- `ttlSeconds`：可省略，默认 `30`；小于 `5` 或大于 `600` 返回 `400`，不静默钳制。
- 请求成功只代表租约已刷新，不代表任何设备已连接或输出。

### 4.2 主动停止全部执行设备

```http
POST /api/device-watchdog/stop-all
Content-Type: application/json

{
  "clientId": "sillytavern-bridge",
  "reason": "client-shutdown"
}
```

该请求立即：

1. 清空全部外部客户端租约。
2. 遍历当前设备。
3. 对具有 `shock` 或 `strength` 能力的设备执行设备类型注册表中的安全关闭逻辑。
4. 对失败设备进行有限次数重试。
5. 返回逐台结果；部分失败时整体 `ok=false`，但不得撤销其它设备已经完成的停止。

响应示意：

```json
{
  "ok": true,
  "trigger": "client-request",
  "clientId": "sillytavern-bridge",
  "stopped": [
    {
      "deviceId": "CUNZHI01-001",
      "commandSent": true,
      "confirmed": true
    }
  ]
}
```

倒计时到期调用同一套内部实现，`trigger` 使用 `lease-expired`。不为超时停止另写一套设备遍历逻辑。

## 5. 主仓文件改动

| 序号 | 文件 | 改动 |
| --- | --- | --- |
| 1 | `backend/services/deviceWatchdogService.js` | 新增租约 Map、刷新、过期调度、全设备停止、清理和逐台结果汇总 |
| 2 | `backend/routes/deviceWatchdog.js` | 新增 `heartbeat` 与 `stop-all` 两个路由，负责入参校验和 HTTP 状态映射 |
| 3 | `backend/services/deviceService.js` | 增加通用的单设备安全关闭实现；复用设备注册表 `closeOp`，只处理带 `shock`/`strength` 的设备 |
| 4 | `backend/index.js` | 挂载 `/api/device-watchdog`；进程正常关闭前清理计时器并尽力停止全部执行设备 |
| 5 | `backend/tests/deviceWatchdogService.test.js` | 覆盖假计时器、刷新、过期、多客户端、旧回调、部分失败和重复停止 |
| 6 | `backend/tests/deviceWatchdogRoutes.test.js` | 覆盖入参、响应、错误码以及路由到模块 interface 的调用 |

不要从 `st-iot-bridge/integrations/control-panel` 整文件覆盖 `deviceService.js` 或 `index.js`。只按上表向主仓当前实现增加必要代码。

## 6. 停止实现要求

`deviceWatchdogService` 对调用方只暴露较小的 interface：

```js
heartbeat({ clientId, ttlSeconds })
stopAll({ clientId, reason, trigger })
shutdown(reason)
resetForTests()
```

复杂性留在模块内部：

- 从 `deviceService.listDevicesForApi()` 获取当前设备。
- 用设备注册表判断 `shock`/`strength` 能力。
- 复用每种设备已有的 `closeOp`，确保 `CUNZHI01` 同时归零 `shock`、`voltage` 和 `power`。
- 对每台设备分别捕获错误，使用 `Promise.allSettled` 或等价实现。
- 停止命令最多重试两次，重试之间使用短延迟；不得无限重试。
- 有可信设备回报时可将 `confirmed=true`；没有回报能力时只能返回 `commandSent=true, confirmed=false`，禁止把 MQTT publish 成功写成物理停止已确认。
- 日志必须包含 `trigger`、`clientId`、`reason`、过期时间和逐台结果，不记录任何密钥。

## 7. 多客户端语义

本方案明确不做控制权协调，因此会接受以下结果：

- 多个客户端可以同时发送设备命令。
- 任意一个已登记客户端失联，都会停止其它客户端当前正在进行的输出。
- 其它仍在线客户端下一次心跳可以重新建立租约，之后可以继续控制。

这是“安全优先、允许误停”的选择。若将来希望“一个客户端失联只停止它启动的输出”，就必须引入输出归属或控制权协调，不属于本轮范围。

## 8. 外部客户端要求

`st-iot-bridge` 及后续小念客户端必须：

1. 启动设备控制前调用 `heartbeat`。
2. 按默认每 `10` 秒刷新。
3. 连续两次刷新失败后立即停止产生新的非零输出，并尝试调用 `stop-all`。
4. 正常退出、酒馆插件卸载、小念运行时关闭时调用 `stop-all`。
5. `report_delay_ms` 直接调用现有 `reporting.setReportDelay`，不依赖主仓新增接口。

## 9. 验收标准

| 序号 | 场景 | 预期 |
| --- | --- | --- |
| 1 | 首次心跳 | 返回确定的 `expiresAt`，只存在一个客户端租约 |
| 2 | 同客户端重复心跳 | 截止时间后移，旧回调不触发停止 |
| 3 | 客户端停止刷新 | 到期后所有 `shock`/`strength` 设备收到关闭命令 |
| 4 | 两个客户端中一个过期 | 全部执行设备停止，全部租约清空 |
| 5 | 主动调用 `stop-all` | 不等待倒计时，立即停止并清空租约 |
| 6 | 一台设备停止失败 | 其它设备继续停止，响应列出失败设备 |
| 7 | 仅传感器或锁设备 | 不改变上报频率和锁状态 |
| 8 | `ttlSeconds=4/601` | 返回 `400`，不创建租约 |
| 9 | 非法 `clientId` | 返回 `400`，不创建租约 |
| 10 | 正常关闭后端 | 清理计时器并尽力执行一次全设备停止 |

本轮只要求自动化测试和模拟设备证据。真实设备是否完成物理归零，仍需后续按设备分别验证。

## 10. 实施证据（2026-08-04）

- `backend/tests/deviceWatchdogService.test.js`：覆盖租约到期、重复刷新旧回调失效、多客户端任一过期、部分失败重试、输入边界。
- `backend/tests/deviceWatchdogRoutes.test.js`：覆盖两个 HTTP interface、默认 TTL 和错误映射。
- `backend/tests/deviceExecutionStop.test.js`：覆盖五类执行设备的归零消息，以及传感器和锁设备不被操作。
- `backend/tests/backendStartup.test.js`：证明 watchdog 全停先于设备清理和 MQTT/mDNS 停止。
- `backend/tests/electronShutdownCoordinator.test.js`：证明 Electron 退出只触发一次关闭、等待完成并具有 5 秒上限。
- 完整后端回归：36 个 suite 通过、1 个跳过；203 个测试通过、1 个跳过。
- 隔离变异：在临时副本把 `report_delay_ms: 5000` 重新加入 CUNZHI01 复位消息后，`deviceExecutionStop.test.js` 准确失败。
- 秘密扫描未发现 API key；本轮未发送真实设备输出。

Jest 完整回归仍报告一个既有 worker open-handle 警告，因此不能据此声明进程资源零泄漏。MQTT publish 只记为 `commandSent=true`，本轮所有 `confirmed` 均保持 `false`，不冒充物理设备归零。
