## 目标

* 将游戏代码里所有以 `type: 'TD01'`（或 `"TD01"`）标识的设备改为以接口形式声明：`interface: 'strength'`。

* 不改动 `logicalId`、`name`、`required` 等其他字段，保持行为一致。

## 受影响文件

* `backend/game/pressureEdgingEmbedded.js:24`

* `backend/game/pushupDetectionEmbedded.js:30`

* `backend/game/maidPunishmentEmbedded.js:25`

## 修改内容

* 将以上位置的对象字段 `type: 'TD01'`（或 `"TD01"`）改为 `interface: 'strength'`。

* 示例：

  * 由 `{ logicalId: 'TD_DEVICE', name: '振动器', type: 'TD01', required: false }`

  * 改为 `{ logicalId: 'TD_DEVICE', name: '振动器', interface: 'strength', required: false }`

## 兼容性说明

* `backend/config/deviceTypes.js:123` 已声明 `TD01: ['strength']`，接口映射成立；按接口匹配不会影响设备的功能路由。

* 项目中已有以接口声明的设备示例（如 `backend/game/demoEmbeddedSse.js:16` 的 `interface: 'strength'`），与现有风格一致。

## 验证

* 静态检查：再次全库搜索 `type: 'TD01'` / `type: "TD01"`，确认游戏代码不再残留。

* 运行态自检（无需启动服务）：

  * 加载相关脚本（仅语法校验）确保无语法错误。

  * 通过设备接口映射检查路径（读取 `backend/config/deviceTypes.js`）确认接口 `strength` 可用。

* 回归点：与 TD01 相关的强度控制、延时启动、强度递增等逻辑在脚本内均围绕设备接口调用，字段替换不影响已有逻辑。

## 执行顺序

1. 依次修改三个 `backend/game` 文件中的字段。
2. 进行一次全库检索确认无残留。
3. 提交前自检并说明变更点。

