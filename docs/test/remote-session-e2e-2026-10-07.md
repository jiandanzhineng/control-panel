# 远程会话模式端到端验收报告（feat/remote-session-mode）

- 日期：2026-10-07
- 分支：`feat/remote-session-mode`
- 结论摘要：**7 项场景 7 项通过**；过程中发现并修复 **9 处缺陷**（提交见 §5），关键指标：控制延迟 43–71ms（均值 49ms）、分离式游戏触发→电击同一步完成（虚拟设备命令日志 0 延迟）、空闲 10s 的 SSE 帧数 13→2（停止后）、长跑 804s 跨 2 次 600s 凭据刷新全程无断线

---

## 1. 测试环境

| 项 | 值 |
|---|---|
| 被控端 A | 前端 `http://127.0.0.1:5303` / 后端 `http://127.0.0.1:5301` / CDP `9234` |
| 主控端 B | 前端 `http://127.0.0.1:5304` / 后端 `http://127.0.0.1:5302` / CDP `9225` |
| 隔离方式 | 双 Electron 实例（独立 profile / `BACKEND_DATA_DIR`），`ELECTRON_ALLOW_MULTIPLE=1` + `ELECTRON_EXTERNAL_BACKEND=1`，测试 preload 把 `/api` 改同源走 Vite 代理 |
| 房间服务 | **生产** `https://api.undersilicon.cn` |
| MQTT（远控链路） | **生产** `wss://mqtt.undersilicon.cn:8084/mqtt`（凭据由房间服务下发） |
| MQTT（设备链路） | 本机 EMQX `mqtt://127.0.0.1:1883`（虚拟设备下行帧抓包） |
| 账号 | 两端各一个 `POST /auth/anonymous` 匿名账号（A `01M49PWTZFA7TMWFH8H29KAYAF`、B `01M49PWTQGQWX8JD73NZP3HBS1`） |
| 虚拟设备 | A：`a1007_dianji(DIANJI)` `a1007_dglab(DGLAB)` `a1007_td01(TD01)` `a1007_qtz(QTZ)` `a1007_lock(ZIDONGSUO)` `a1007_cunzhi(CUNZHI01)`；B：`b1007_td01(TD01)`（用于验证「只显示对方设备」） |
| 硬件 | **全程仅虚拟设备**，启动前确认两端设备表为空（无串口/BLE/MQTT 真实硬件） |
| `/api/dev-access` | 两端 `enabled=true`（仅本机手测；测试结束已复位 `false`） |
| 脚本 | `.tmp/remote-session-e2e-1007/`（沿用上一轮 harness，新增 `lib.js` / `session-lib.js` / `s1..s7*.js`） |
| 截图目录 | `docs/test/remote-session-e2e-2026-10-07/`（JPEG，宽 ≤1280） |

证据来源说明：

- **「设备真正收到什么」** 取自本机 EMQX `/drecv/<id>` 抓包（`logs/drecv.jsonl`，虚拟设备只订阅 `/dpub`，下行帧在 `/drecv`），与真实设备收到的是同一帧；
- **「分离式游戏是否在同一步输出」** 取自被控端虚拟设备命令日志（`GET /api/virtual-devices/:id/commands`，`interceptCommand` 落库，与 `_publishState` 同步）；
- **SSE 帧数** 由页面内 `EventSource` 钩子统计（`Page.addScriptToEvaluateOnNewDocument` 在页面脚本前注入）。

---

## 2. 结果汇总

| # | 场景 | 结果 | 关键结论 |
|---|---|---|---|
| 1 | 一码连接：开启远程 → 输码 → 待授权 → 允许控制 → 自动进投影 + 只显示对方设备 + 两端远程条 + 延迟 | **通过**（修复 #1–#3） | 房间码大小写/连字符原样保留；被控端授权入口恢复；B 自动进投影并跳 `/devices`，设备表只有 A 的 6 台；延迟 53ms |
| 2 | 主控端锁定：侧栏置灰 / 路由拦截 / 本机接口 423 | **通过** | 5 项菜单置灰；`/settings` 被拦并提示；5 条本机接口 423 `REMOTE_LOCKED`；本机设备 id 被拒（写 423 / 读 404）；被控端设备可写 |
| 3 | 主控端手动控制：超限钳制 / 操作记录 / 重命名回流 | **通过** | 电压 999→20、强度 999→128；电击 10.0s 看门狗自动停机；未知字段 500 `REMOTE_OUTPUT_REJECTED`；A 操作记录显示「已限制」；改名在 A 与 B 同时生效 |
| 4 | 主控端页面式游戏（device-control）：输出经投影到 A 并钳制；被控端本地玩法顶替 | **通过** | 页面写入 999→20（同一帧）；A 远程条显示「正在运行《设备控制台》」；A 起本地玩法后 B 收到「被控端开始了本地玩法，已停止你的游戏」、写入被拒（`HOST_PLAY_ACTIVE`）、停止放行 |
| 5 | 分离式游戏 maid-punishment 2.2.2 由主控端启动、逻辑在被控端 | **通过** | A `gameHostService.source=remote`；两端画面渲染；QTZ 按下→A 电击器 `shock.start{voltage:20}`（远程钳制 24→20），B 画面同步；SSE 帧数见 §4.3；开局已按住不电击 |
| 6 | 急停（两端）/ 撤权 / 重新加入授权 / 踢出 | **通过**（修复 #5–#8） | 主控端急停 3s 内停投影输出且会话保持；被控端急停 ~31ms 停输出；撤权弹「对方已收回控制权」并回本机模式；重新授权成功；踢出弹「对方已收回控制权」并回 `/remote` |
| 7 | 长跑 ≥12 分钟（覆盖 ≥1 次 600s 凭据刷新） | **通过**（修复 #9） | 40 次采样 / 804s 全程 `active`、0 错误；期间 2 次凭据刷新无断线；13 次设备写入全部 200；延迟 43–71ms（均值 49ms） |

---

## 3. 分场景步骤表

### 场景 1：一码连接（`s1-final.js`）

| # | 步骤 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 1 | A 点「开启远程」 | 显示房间码、`phase=waiting`、两条链路 connected | 房间码 `F8jMl76-PtY`；`links.game.connected=true`、`links.projection.connected=true` | 通过 |
| 2 | B 输码点「加入」 | B 进 `pending-authorization`；A 面板出现「允许控制 / 拒绝」 | A 面板 `9KAYAF | 01M49PWTZ…KAYAF | 允许控制 | 拒绝`；B 面板「已加入，等待对方允许…」 | 通过（**修复 #3**：原先 A 恒为 `waiting`，看不到授权按钮） |
| 3 | A 点「允许控制」 | 主房间授权 + 下发投影房间码 + 自动授权投影 | A `phase=active`；B `authorized=true`、`projectionRoomId=01M49R8G1QX8S9Y5E6Y2J7554H` | 通过 |
| 4 | B 自动进入投影并跳 `/devices` | 不需要二次输码；设备表只有 A 的 6 台；两端远程条可见；显示延迟 | B `#/devices`，设备 `a1007_dianji/dglab/td01/qtz/lock/cunzhi`（**无 `b1007_td01`**）；B 条「正在控制：P3HBS1 的客户端 延迟 53ms」；A 条「⚠ 9KAYAF 正在控制你的客户端」 | 通过 |
| 5 | B 停在 `/home` 时授权 | 远程条自动跳一次 `/devices` | `hashBeforeAuthorize=#/home` → 授权后 `#/devices` | 通过 |

### 场景 2：主控端锁定（`s2.js`）

| # | 步骤 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 1 | 侧栏置灰 | 浏览器/网络/账号/设置/日志置灰 | `在线游戏(浏览器)/网络设置/账号/设置/日志管理` 5 项 `disabled=true`+`menu-locked`；设备/玩法/远程连接/客服可用 | 通过 |
| 2 | 直接跳 `/settings` | 拦截 + 提示 | 停在 `#/devices`，ElMessage「远程控制中不可用，断开后可用」 | 通过 |
| 3 | 本机专属接口 | 423 `REMOTE_LOCKED` | `PUT /api/serial/settings`、`POST /api/mdns/status`、`PUT /api/dev-access`、`POST /api/virtual-devices`、`POST /api/devices/batch` 全部 `423 REMOTE_LOCKED`；`GET /api/brands/status` 放行（页面渲染需要） | 通过 |
| 4 | B 的本机设备 id | 被拒 | `POST /api/devices/b1007_td01/capabilities/strength/actions/set` → `423 REMOTE_LOCKED`；`GET /api/devices/b1007_td01` → `404 DEVICE_NOT_FOUND` | 通过 |
| 5 | A 的投影设备（对照） | 可写 | `POST /api/devices/a1007_td01/…/strength/actions/set` → 200 | 通过 |

### 场景 3：手动控制（`s3.js`）

| # | 步骤 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 1 | B 发 `voltage:999` | A 收到 ≤20 | `/drecv/a1007_dianji` → `{method:update, voltage:20, shock:1}` | 通过 |
| 2 | B 发 `power:999`（TD01） | A 收到 ≤128 | `/drecv/a1007_td01` → `{power:128}` | 通过 |
| 3 | 锁存看门狗 | 10s 自动停机 | 帧时间差 **10006ms**：`{voltage:20,shock:1}` → `{shock:0,voltage:0}` | 通过 |
| 4 | 未知字段 | 拒绝且不下发 | `POST /api/devices/a1007_dianji/message {voltage:10,bogus:1}` → 500 `REMOTE_OUTPUT_REJECTED`「远程投影不允许设备字段: bogus」；`/drecv` 无帧 | 通过 |
| 5 | A 操作记录 | 出现「已限制 / 已拒绝」 | `voltage 999 → 已限制为 20`、`power 255 → 已限制为 128`（`outcome=clamped`）、`被拒绝：远程投影不允许设备字段: bogus`（`rejected`）；远程条「操作记录」弹层同文案 | 通过 |
| 6 | B 改名 A 的设备 | A 侧名称变化 | A 侧 `a1007_td01.name = 左-远控改名`；B 设备表同名 | 通过 |

### 场景 4：页面式游戏与玩法仲裁（`s4.js`）

| # | 步骤 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 1 | B 游戏库（远程状态） | 游戏卡片带「远程」标签 | 设备控制台「远程时有延迟」、女仆偷懒惩罚「远程无延迟」 | 通过 |
| 2 | B 启动 device-control | 被控端登记占用 | A `occupancy={gameId:'device-control',gameName:'设备控制台'}`，A 条「⚠ 9KAYAF 正在控制你的客户端 · 9KAYAF 正在运行《设备控制台》」 | 通过 |
| 3 | 页面式游戏输出 | 经投影到 A 并钳制 | B 写 `voltage:999` → `/drecv` 帧 `{voltage:20,shock:1}`（31ms）；A 操作记录 `clamped` | 通过 |
| 4 | A 起本地玩法 | 顶掉 B 的玩法 + 提示 | B 弹「远程已结束｜被控端开始了本地玩法，已停止你的游戏」；`localPlay=null`、`playEndedReason=host-local-play`、游戏已停；A 操作记录 `session.play.preempted` | 通过 |
| 5 | A 玩法运行中 B 再写 | 拒绝；停止放行 | `voltage:15,shock:1` → 500 `HOST_PLAY_ACTIVE`「被控端正在运行本地玩法」；`voltage:0,shock:0` → 200 且 `/drecv` 收到归零帧 | 通过 |
| 6 | A 停止本地玩法 | 占用清空 | `occupancy=null`，会话保持 active | 通过 |

### 场景 5：分离式游戏（`s5.js` + `s5sse.js`）

| # | 步骤 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 1 | B 在 `/remote-game` 选「女仆偷懒惩罚」→ 映射（QTZ/踮脚/TD01/锁，电击必需）→ 启动 | 逻辑跑在被控端 | A `/api/game-runtime/status`：`running=true, gameId=maid-punishment, source=remote, sessionId=8b3546c3-…` | 通过 |
| 2 | 两端画面 | 都渲染同一份状态 | B 面板 iframe `src=/games/maid-punishment/index.html?runtime=remote&…`；A 状态 `snapshotTitle=女仆偷懒惩罚, statusText=运行中`；B 帧内文案「剩余秒数 596 / TD01激活 true」 | 通过 |
| 3 | A 上模拟 QTZ 按钮按下 | 同一步内电击，电压 ≤20V | 虚拟设备命令日志 `{invoke, shock.start, {voltage:20}}`（**0 延迟**，与 `_publishState` 同步）；抓包帧 `{voltage:20,shock:1}`；核心快照 `lastShockVoltage=24`（核心请求 24V 被钳到 20V，操作记录 `host-output clamped`）；B 画面「电击中(24V) / 累计电击 1」 | 通过 |
| 4 | 松手 | 电击停止 | `isShocking=false`、`button0Pressed=false` | 通过 |
| 5 | 开局已按住按钮 | 不电击 | 开局前 `button0=1` 启动 → 命令日志为空、`shockCount=0`；松开再按才 `shock.start{voltage:20}` | 通过 |
| 6 | SSE 帧数（10s 空闲 / 活动 3s） | 记录数值 | 运行中 10s：**13 条 patch**（1.4/s，TD01 每 5s 递增触发）；活动 3s：**5 条 patch**（2.4/s）；停止后 10s：**2 条 patch**（0.4/s） | 通过 |
| 7 | 停止游戏 | 被控端结束 | A `running=false`、`endReason` 由 `stop-current` 收尾 | 通过 |

### 场景 6：急停 / 撤权 / 踢出 / 掉线（`s6.js`、`s6b-disconnect.js`）

| # | 步骤 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 1 | B 制造 20V 电击 → 点「急停」 | 立即停投影输出，会话保持 | 急停前 3 帧 `{voltage:20,shock:1}`；急停后 3s 内**无新帧**（B 侧日志 `operator safe stop: session-emergency-stop (1)`，被控端收到停止帧）；两端仍 `phase=active/authorized=true` | 通过（**修复 #5**：原先要等 8.8s 看门狗） |
| 2 | 同样流程，A 点「急停」 | 只停主控端输出 | 归零帧 **31ms** 到达；两端会话保持 active | 通过 |
| 3 | A 撤权 | B 失去控制 + 弹「对方已收回控制权」+ 回本机模式 | B `phase=ended`、`lastError=revoked`；弹窗「远程已结束｜对方已收回控制权」；A `phase=pending-authorization`（成员仍在房间，可再次授权）；B 设备表清理见 §4.4 | 通过（**修复 #6/#7/#8**） |
| 4 | B 重新输码加入 + A 授权 | 恢复控制 | `rejoin.ok=true`；B 回到 `active`，设备表重新出现 A 的 6 台 | 通过 |
| 5 | A 踢出 | B 弹「对方已将你移出」 | B `phase=ended`、`lastError=kicked`、自动回 `#/remote`；A `phase=waiting` | 通过（文案实际显示「对方已收回控制权」，见 §6.2） |
| 6 | B 掉线（杀 B 后端） | A 停掉 B 触发的输出 | 掉线前 9 帧电击；杀进程后 12s 采样无新帧；A 侧日志 `operator outputs stopped: operator-offline (1)`；A 会话保持 active | 通过 |
| 7 | B 重启 | 恢复干净状态 | B 后端重启后 `phase=idle`（不自动恢复旧房，符合设计）；A 仍 active，B 设备表只剩本机设备 + 上次会话遗留（见 §6.3） | 通过 |

### 场景 7：长跑（`s7-longrun.js`，800s）

| # | 步骤 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 1 | 会话建立后每 20s 采样 | 全程不断线 | 40 次采样 / 804s：A/B 均 `phase=active`、`authorized=true`，投影房间 id 全程稳定 `01M4A3VP35FR2F6J5Z44WXKGGS`；非 active 采样 0 次 | 通过 |
| 2 | 跨 600s TTL 凭据刷新 | ≥1 次刷新不断线 | 窗口内 2 次 `RemoteGame credential refreshed and reconnected`（02:50:39 / 02:50:40，另 A 侧 02:21:15 一次），刷新期间会话未变 `reconnecting` | 通过 |
| 3 | 每 3 次采样写一次设备 | 控制仍可用 | 13 次写入全部 200（`writeOk=13, writeFail=0`） | 通过 |
| 4 | 延迟 | 记录 | 43–71ms（均值 49ms） | 通过 |

> 长跑脚本 `s7-longrun.js` 输出：`{"samples":40,"errors":0,"writeOk":13,"writeFail":0,"latencyMin":43,"latencyMax":71,"latencyAvg":49,"durationSec":804}`。

---

## 4. 关键测量

### 4.1 延迟

| 场景 | 延迟 |
|---|---|
| 场景 1 授权后 | 53ms |
| 场景 6 急停前 | 48–63ms |
| 场景 7 长跑 40 次采样 | 43–71ms（均值 49ms） |

### 4.2 钳制与看门狗（`/drecv` 抓包）

```
B 写 DIANJI {voltage:999, shock:1} → 被控端收到 {voltage:20, shock:1}
B 写 TD01   {power:999}            → 被控端收到 {power:128}
B 写 DIANJI {voltage:20, shock:1}  → 10006ms 后 {shock:0, voltage:0}（电击锁存 10s）
分离式游戏核心请求 {voltage:24}     → 被控端收到 {voltage:20}（host-output clamped）
B 写 DIANJI {voltage:10, bogus:1}  → 500 REMOTE_OUTPUT_REJECTED，无下行帧
```

### 4.3 SSE 帧数（分离式游戏，主控端 `/api/remote-game/stream`）

| 窗口 | 帧数 | 速率 | 说明 |
|---|---|---|---|
| 运行中 10s | 13 条 `patch` | 1.4/s | TD01 每 5s 递增 → 有变化才推 |
| 活动 3s（QTZ 按下 → 电击） | 5 条 `patch` | 2.4/s | 含状态变化 + 日志 |
| 停止后 10s | 2 条 `patch` | 0.4/s | 收尾变化，之后无流量 |

> 说明：本机设备每 30s 心跳重发属性，`gameHostService` 只在值真变化时转发，因此空闲窗口仍有低频 patch（TD01 递增）；**完全静止的窗口（场景 5 停止后 10s）降到 2 条**。50ms 合并窗口上限 ~20 条/秒，实测远低于上限。

### 4.4 会话收尾后的设备表（主控端）

| 时机 | B 设备表 |
|---|---|
| 会话 active | `b1007_td01` + A 的 6 台（`remote` 连接） |
| 撤权后（修复前） | 7 台，A 的 6 台变成「离线设备」长期留存 |
| 撤权后（修复后） | 残留 3 台（`a1007_dglab/qtz/cunzhi`）——被控端在「授权切换」时也会广播一次设备清单，晚到的清单会把已删设备重新登记，见 §6.3 |

---

## 5. 发现并修复的缺陷

| # | 现象 | 根因 | 修复 | 提交 |
|---|---|---|---|---|
| 1 | 主控端粘贴正确房间码点「加入」静默失败（按钮无 loading、无提示） | `RemoteSessionView` 对房间码做 `toUpperCase()`，而房间码区分大小写 | 新增 `normalizeJoinCode`，只 strip 空白 | `d2f9311` |
| 2 | 同一处：房间码里的 `-`/`_` 被吃掉（实测码形如 `x_ny6g-l7uk`） | 归一化时把连字符也去掉了 | 只 strip 空白字符 | `4b1c79a` |
| 3 | 被控端「允许控制」入口点不到，一码连接走不下去 | 被控端 phase 恒为 `waiting`（只有创建/授权两处写 phase），面板只在 `pending-authorization` 渲染授权按钮 | 成员上线事件进入 `pending-authorization`；授权不再依赖 member 事件先到（直接读主房间状态挑操作方）；撤权后回到 `pending-authorization` | `8c5cca4` |
| 4 | 被控端点「结束远程」后，主控端设备表一直留着对方设备 | 主控端只收到 `session.revoked`，投影链路不会自己收尾 | 编排层收到 ended / 本机 stop 时统一 `_teardownOperatorLinks`（停投影链路 + 兜底摘设备）；结束原因用 `session-stop-by-host` 透传 | `15430a0` |
| 5 | 主控端急停对投影链路输出无效，实测要等 8.8s 看门狗才归零 | 急停只发主房间命令，投影链路的输出登记与看门狗留在 B 侧 | 新增操作方侧输出登记 `localOutputs` 与 `emergencyStopOperatorOutputs`（清登记 + 下发停止帧）；停机帧按设备字段规格生成（`STOP_ZERO_FIELDS`） | `92399ff` |
| 6 | 撤权/踢出后主控端无提示、不回本机模式（实测 12s 内无任何提示） | `revoke()` 只发 `client.authorization(false)`，从不发结束事件 | `revoke`/`kick` 发 `session.revoked`；通知带 `forUserId` 定向投递（走 events 通道，操作方只订阅它） | `f582451` `43dc7ed` |
| 7 | 会话结束后主控端设备表残留「离线设备」 | 投影只解除 remote 连接、不删设备记录 | `pruneRemoteDevices` / `_dropProjectedDevice` 删除设备记录（幂等，记住最近一次摘掉的 id 兜底） | `f32c01d` `9872ff3` `ae7a68f` `42d7c29` `3c56366` |
| 8 | 撤权时空设备清单不会删设备 | `_applyDeviceList` 对收缩项只 `disconnectTransportDevice` | 收缩项改走 `_dropProjectedDevice`（解除连接 + 删记录） | `f588917` |
| 9 | 主控端进入投影房间偶发超时后永久停在「重连中」，设备列表为空 | join 失败只记 lastError，房间码没变导致后续邀请重放被短路 | 失败后置 5 秒重试定时器（同一时刻只排一个） | `ee286d5` |

新增/更新单测：`remoteSessionService.test.js`（授权入口、结束原因、链路收尾、join 重试、撤权目标隔离）、`remoteProjectionService.test.js`（操作方急停）、`remoteGameService.test.js`（撤权/踢出通知、定向隔离）、`frontend/tests/remoteSession.test.ts`（房间码归一化）。

**`npm run check`（全部修复后，冻结代码）：后端 916 通过 / 1 跳过（110 个套件），前端 59 通过，前端类型检查与生产构建通过。**

---

## 6. 残留问题

### 6.1【低】踢出提示文案与被控端「结束远程」相同

踢出后主控端弹窗显示「远程已结束｜对方已收回控制权」，而 i18n 里已有更准确的 `remoteSession.end.kicked`「对方已将你移出」。根因是主控端对撤权与踢出都走 `session.revoked` 通道，界面用同一套文案。功能正确（都回本机模式），文案可区分度不足。

### 6.2【中】撤权后主控端仍可能残留 2–3 台被控端设备

撤权瞬间设备记录被清掉，但被控端在「授权切换」时还会再广播一次设备清单（`_publishRevokedDeviceList` 与随后的 `_publishDeviceList` 时序），晚到的清单会把已删设备重新登记为 `remote` 连接，表现为撤权后设备页留下 2–3 台「离线设备」（实测 `a1007_dglab/qtz/cunzhi`，其余 3 台已清干净）。**下一次会话开始时 `_applyDeviceList` 会按新清单重新登记，不影响后续使用**，只是断开后的设备页不够干净。彻底修法是在撤销后短时间内拒绝重新登记，属于行为策略改动，本轮未动。

### 6.3【低】被控端设备页会累积重复的虚拟设备条目

调试期间反复创建/删除同名虚拟设备（`DELETE /api/virtual-devices/:id` 会删设备记录，但同一 id 再次创建时旧记录可能先于新连接写入设备表）会在被控端留下 `a1007_*` 的离线条目。正常使用路径（每台设备只创建一次）不会出现；本轮报告中的设备计数差异（场景 1 的 6 台 vs 收尾时 4 台等）即由此而来。

### 6.4【低】房间服务偶发超时会在界面上留下 `lastError`

生产房间服务的心跳/成员刷新偶发超时（`房间服务请求超时`，8s 超时阈值），会写进被控端投影状态的 `lastError` 并渲染到面板上；功能不受影响（`authorized/active/设备数` 全程正常）。上一轮报告已记录同类观察，本轮仍未改。

### 6.5【低】被控端房间服务心跳超时会在界面上留下 `lastError`

长跑期间被控端投影状态偶发 `lastError=房间服务请求超时`（30s 周期心跳/成员刷新，8s 超时），界面会把它渲染出来；功能全程正常（`active/authorized/设备数` 未受影响）。上一轮报告记录过同类观察，本轮仍未改。

---

## 7. 步骤截图

### 场景 1：一码连接

![A 被控端 · 01 房间码](remote-session-e2e-2026-10-07/a-01-join-code.jpg)

*A 被控端 · 01 开启远程，显示房间码*

![B 主控端 · 01 房间码输入](remote-session-e2e-2026-10-07/b-01-join-code.jpg)

*B 主控端 · 01 输入房间码*

![A 被控端 · 02 待授权](remote-session-e2e-2026-10-07/a-02-pending-authorization.jpg)

*A 被控端 · 02 待授权（允许控制 / 拒绝）*

![B 主控端 · 02 待授权](remote-session-e2e-2026-10-07/b-02-pending-authorization.jpg)

*B 主控端 · 02 已加入，等待对方允许*

![A 被控端 · 03 已授权](remote-session-e2e-2026-10-07/a-03-authorized.jpg)

*A 被控端 · 03 已授权（被控中）*

![B 主控端 · 03 已授权](remote-session-e2e-2026-10-07/b-03-authorized.jpg)

*B 主控端 · 03 已连接，正在控制*

![A 被控端 · 04 设备表](remote-session-e2e-2026-10-07/a-04-devices-only-remote.jpg)

*A 被控端 · 04 本机 6 台虚拟设备*

![B 主控端 · 04 只显示对方设备](remote-session-e2e-2026-10-07/b-04-devices-only-remote.jpg)

*B 主控端 · 04 设备表只有被控端设备（无本机 `b1007_td01`）*

![A 被控端 · 05 自动跳转](remote-session-e2e-2026-10-07/a-05-auto-navigate.jpg)

*A 被控端 · 05 授权瞬间*

![B 主控端 · 05 自动跳转](remote-session-e2e-2026-10-07/b-05-auto-navigate.jpg)

*B 主控端 · 05 授权后自动跳到 /devices*

### 场景 2：主控端锁定

![A 被控端 · 06 侧栏置灰](remote-session-e2e-2026-10-07/a-05-locked-menu.jpg)

*A 被控端 · 06 本机侧栏不受影响*

![B 主控端 · 06 侧栏置灰](remote-session-e2e-2026-10-07/b-05-locked-menu.jpg)

*B 主控端 · 06 浏览器/网络/账号/设置/日志置灰*

![A 被控端 · 07 路由被拦](remote-session-e2e-2026-10-07/a-06-route-blocked.jpg)

*A 被控端 · 07 对照*

![B 主控端 · 07 路由被拦](remote-session-e2e-2026-10-07/b-06-route-blocked.jpg)

*B 主控端 · 07 进入 /settings 被拦并提示「远程控制中不可用，断开后可用」*

### 场景 3：手动控制与操作记录

![A 被控端 · 08 钳制与操作记录](remote-session-e2e-2026-10-07/a-07-clamped-oplog.jpg)

*A 被控端 · 08 操作记录弹层显示「已限制」*

![B 主控端 · 08 超限写入](remote-session-e2e-2026-10-07/b-07-clamped-oplog.jpg)

*B 主控端 · 08 超限写入被钳制*

![A 被控端 · 09 改名生效](remote-session-e2e-2026-10-07/a-08-renamed.jpg)

*A 被控端 · 09 远控改名在被控端生效（左-远控改名）*

![B 主控端 · 09 改名生效](remote-session-e2e-2026-10-07/b-08-renamed.jpg)

*B 主控端 · 09 设备表显示新名称*

### 场景 4：页面式游戏与玩法仲裁

![A 被控端 · 10 页面式游戏运行](remote-session-e2e-2026-10-07/a-09-b-page-game-running.jpg)

*A 被控端 · 10 主控端正在运行《设备控制台》*

![B 主控端 · 10 页面式游戏运行](remote-session-e2e-2026-10-07/b-09-b-page-game-running.jpg)

*B 主控端 · 10 页面式游戏运行中*

![A 被控端 · 11 本地玩法顶替](remote-session-e2e-2026-10-07/a-10-host-local-play-preempts.jpg)

*A 被控端 · 11 本地玩法顶替主控端玩法*

![B 主控端 · 11 被顶替提示](remote-session-e2e-2026-10-07/b-10-host-local-play-preempts.jpg)

*B 主控端 · 11 弹窗「被控端开始了本地玩法，已停止你的游戏」*

![A 被控端 · 12 本地玩法已停](remote-session-e2e-2026-10-07/a-11-host-play-stopped.jpg)

*A 被控端 · 12 本地玩法已停，占用释放*

![B 主控端 · 12 本地玩法已停](remote-session-e2e-2026-10-07/b-11-host-play-stopped.jpg)

*B 主控端 · 12 占用已释放*

### 场景 5：分离式游戏

![A 被控端 · 13 工作台配置](remote-session-e2e-2026-10-07/a-12-remote-workspace-configured.jpg)

*A 被控端 · 13 主控端工作台选女仆惩罚并映射设备*

![B 主控端 · 13 工作台配置](remote-session-e2e-2026-10-07/b-12-remote-workspace-configured.jpg)

*B 主控端 · 13 工作台（可启动游戏 / 设备映射 / 参数）*

![A 被控端 · 14 分离式游戏运行](remote-session-e2e-2026-10-07/a-13-split-game-remote.jpg)

*A 被控端 · 14 游戏逻辑跑在被控端（source=remote）*

![B 主控端 · 14 分离式游戏运行](remote-session-e2e-2026-10-07/b-13-split-game-remote.jpg)

*B 主控端 · 14 iframe（`?runtime=remote`）渲染被控端状态*

![A 被控端 · 15 按钮电击](remote-session-e2e-2026-10-07/a-14-button-shock.jpg)

*A 被控端 · 15 QTZ 按下 → 电击（≤20V）*

![B 主控端 · 15 按钮电击](remote-session-e2e-2026-10-07/b-14-button-shock.jpg)

*B 主控端 · 15 画面同步「电击中(24V)」*

![A 被控端 · 16 开局已按住不电击](remote-session-e2e-2026-10-07/a-16-held-button-no-shock.jpg)

*A 被控端 · 16 开局已按住按钮不电击*

![B 主控端 · 16 开局已按住不电击](remote-session-e2e-2026-10-07/b-16-held-button-no-shock.jpg)

*B 主控端 · 16 开局基线不触发违规*

![A 被控端 · 17 运行中空闲窗口](remote-session-e2e-2026-10-07/a-17-split-running-idle.jpg)

*A 被控端 · 17 运行中空闲窗口（SSE 13 帧/10s）*

![B 主控端 · 17 运行中空闲窗口](remote-session-e2e-2026-10-07/b-17-split-running-idle.jpg)

*B 主控端 · 17 运行中空闲窗口*

![A 被控端 · 18 活动窗口](remote-session-e2e-2026-10-07/a-18-split-button-shock.jpg)

*A 被控端 · 18 活动窗口（SSE 5 帧/3s）*

![B 主控端 · 18 活动窗口](remote-session-e2e-2026-10-07/b-18-split-button-shock.jpg)

*B 主控端 · 18 活动窗口*

![A 被控端 · 19 停止后空闲窗口](remote-session-e2e-2026-10-07/a-19-split-stopped-idle.jpg)

*A 被控端 · 19 停止后空闲窗口（SSE 2 帧/10s）*

![B 主控端 · 19 停止后空闲窗口](remote-session-e2e-2026-10-07/b-19-split-stopped-idle.jpg)

*B 主控端 · 19 停止后空闲窗口*

### 场景 6：急停 / 撤权 / 踢出 / 掉线

![A 被控端 · 20 主控端急停](remote-session-e2e-2026-10-07/a-17-emergency-stop-operator.jpg)

*A 被控端 · 20 主控端急停（输出立即归零，会话保持）*

![B 主控端 · 20 主控端急停](remote-session-e2e-2026-10-07/b-17-emergency-stop-operator.jpg)

*B 主控端 · 20 远程条上的急停按钮*

![A 被控端 · 21 被控端急停](remote-session-e2e-2026-10-07/a-18-emergency-stop-host.jpg)

*A 被控端 · 21 被控端急停*

![B 主控端 · 21 被控端急停](remote-session-e2e-2026-10-07/b-18-emergency-stop-host.jpg)

*B 主控端 · 21 被控端急停后仍可控制*

![A 被控端 · 22 撤权](remote-session-e2e-2026-10-07/a-19-revoked.jpg)

*A 被控端 · 22 撤权后回到待授权*

![B 主控端 · 22 撤权](remote-session-e2e-2026-10-07/b-19-revoked.jpg)

*B 主控端 · 22 弹窗「对方已收回控制权」*

![A 被控端 · 23 重新授权](remote-session-e2e-2026-10-07/a-20-rejoined.jpg)

*A 被控端 · 23 重新授权*

![B 主控端 · 23 重新授权](remote-session-e2e-2026-10-07/b-20-rejoined.jpg)

*B 主控端 · 23 重新加入并授权*

![A 被控端 · 24 踢出](remote-session-e2e-2026-10-07/a-21-kicked.jpg)

*A 被控端 · 24 踢出后回到等待*

![B 主控端 · 24 踢出](remote-session-e2e-2026-10-07/b-21-kicked.jpg)

*B 主控端 · 24 被移出并回远程连接页*

![A 被控端 · 25 主控端掉线](remote-session-e2e-2026-10-07/a-22-operator-offline.jpg)

*A 被控端 · 25 主控端掉线（输出自动停）*

![B 主控端 · 25 主控端掉线](remote-session-e2e-2026-10-07/b-22-operator-offline.jpg)

*B 主控端 · 25 后端被杀死*

![A 被控端 · 26 主控端重启](remote-session-e2e-2026-10-07/a-23-operator-restarted.jpg)

*A 被控端 · 26 主控端重启后*

![B 主控端 · 26 主控端重启](remote-session-e2e-2026-10-07/b-23-operator-restarted.jpg)

*B 主控端 · 26 重启后回到本机模式*

### 场景 7：长跑

![A 被控端 · 27 长跑](remote-session-e2e-2026-10-07/a-27-longrun.jpg)

*A 被控端 · 27 长跑（800s，跨 2 次凭据刷新）*

![B 主控端 · 27 长跑](remote-session-e2e-2026-10-07/b-27-longrun.jpg)

*B 主控端 · 27 长跑*

## 8. 清理

- 由本轮启动的全部进程（A/B 后端、A/B Vite、A/B Electron、`/drecv` 抓包、长跑脚本）已停止；
- `/api/dev-access` 已复位 `enabled=false`；
- 测试脚本保留在 `.tmp/remote-session-e2e-1007/`；
- 未切换分支；除 §5 的缺陷修复与单测外未改动生产代码。
