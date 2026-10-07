# 远程会话模式端到端验收报告（feat/remote-session-mode）

- 日期：2026-10-07
- 分支：`feat/remote-session-mode`
- 结论摘要：**7 项场景 7 项通过**；过程中发现并修复 **9 处缺陷**，终验又修复 **7 项**，截图重拍复核再修 **2 项**（F9/F10，提交见 §5.1，重拍说明见 §5.3），关键指标：控制延迟 45–53ms（长跑均值 50ms）、分离式游戏触发→电击同一步完成（虚拟设备命令日志 0 延迟）、空闲 10s 的 SSE 帧数 14→2（停止后）、长跑 809s 跨 2 次 600s 凭据刷新全程无断线；报告内 56 张截图逐张核对过，其中 54 张在当前代码上重拍，a-28 / b-28 两张（F7 本机专属按钮置灰）经复核仍与当前行为一致、保持原图

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
| 账号 | 两端各一个 `POST /auth/anonymous` 匿名账号（早期取证 A `01M49PWTZ…KAYAF`、B `01M49PWTQ…P3HBS1`；重拍复核另建一对，房间码/短 id 随会话变化） |
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
| 1 | 一码连接：开启远程 → 输码 → 待授权 → 允许控制 → 自动进投影 + 只显示对方设备 + 两端远程条 + 延迟 | **通过**（修复 #1–#3） | 房间码大小写/连字符原样保留；被控端授权入口恢复；B 自动进投影并跳 `/devices`，设备表只有 A 的 6 台；延迟 48–53ms |
| 2 | 主控端锁定：侧栏置灰 / 路由拦截 / 本机接口 423 | **通过** | 5 项菜单置灰；`/settings` 被拦并提示；5 条本机接口 423 `REMOTE_LOCKED`；本机设备 id 被拒（写 423 / 读 404）；被控端设备可写 |
| 3 | 主控端手动控制：超限钳制 / 操作记录 / 重命名回流 | **通过** | 电压 999→20、强度 999→128；电击 10.0s 看门狗自动停机；未知字段 500 `REMOTE_OUTPUT_REJECTED`；A 操作记录显示「已限制」；改名在 A 与 B 同时生效 |
| 4 | 主控端页面式游戏（device-control）：输出经投影到 A 并钳制；被控端本地玩法顶替 | **通过** | 页面写入 999→20（同一帧）；A 远程条显示「正在运行《设备控制台》」；A 起本地玩法后 B 收到「被控端开始了本地玩法，已停止你的游戏」、写入被拒（`HOST_PLAY_ACTIVE`）、停止放行 |
| 5 | 分离式游戏 maid-punishment 2.2.2 由主控端启动、逻辑在被控端 | **通过** | A `gameHostService.source=remote`；两端画面渲染；QTZ 按下→A 电击器 `shock.start{voltage:20}`（远程钳制 24→20），B 画面同步；SSE 帧数见 §4.3；开局已按住不电击 |
| 6 | 急停（两端）/ 撤权 / 重新加入授权 / 踢出 | **通过**（修复 #5–#8） | 主控端急停 3s 内停投影输出且会话保持；被控端急停 ~31ms 停输出；撤权弹「对方已收回控制权」并回本机模式；重新授权成功；踢出弹「对方已将你移出」并回 `/remote`（终验修复 F5） |
| 7 | 长跑 ≥12 分钟（覆盖 ≥1 次 600s 凭据刷新） | **通过**（修复 #9） | 39 次采样 / 809s 全程 `active`、0 错误；期间 2 次凭据刷新无断线；13 次设备写入全部 200；延迟 45–53ms（均值 50ms） |

---

## 3. 分场景步骤表

### 场景 1：一码连接（`s1-final.js`）

| # | 步骤 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 1 | A 点「开启远程」 | 显示房间码、`phase=waiting`、两条链路 connected | 房间码 `_ZfbLmRcvL8`（大小写/`-`/`_` 原样）；`links.game.connected=true`、`links.projection.connected=true` | 通过 |
| 2 | B 输码点「加入」 | B 进 `pending-authorization`；A 面板出现「允许控制 / 拒绝」 | A 面板 `{短id} / {userId} / 允许控制 / 拒绝`；B 面板「已加入，等待对方允许…」、远程条「等待 {A} 允许控制…」+ 琥珀点 +「取消」 | 通过（**修复 #3**：原先 A 恒为 `waiting`，看不到授权按钮；重拍复核确认待授权文案不再是「正在控制」） |
| 3 | A 点「允许控制」 | 主房间授权 + 下发投影房间码 + 自动授权投影 | A `phase=active`；B `authorized=true`、`projectionRoomId` 已下发且两端一致 | 通过 |
| 4 | B 自动进入投影并跳 `/devices` | 不需要二次输码；设备表只有 A 的 6 台；两端远程条可见；显示延迟 | B `#/devices`，设备 `a1007_dianji/dglab/td01/qtz/lock/cunzhi`（**无 `b1007_td01`**）；B 条「正在控制：Z88218 的客户端 延迟 48ms」；A 条「⚠ 7ETZNS 正在控制你的客户端」 | 通过 |
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
| 5 | A 操作记录 | 出现「已限制 / 已拒绝」 | 终验后：`控制设备「电脉冲设备-anji」电压 20` + 琥珀标签「已限制」（悬停「请求 999 → 实际 20」）、`控制设备「左-远控改名」强度 128` +「已限制」（「请求 255 → 实际 128」）、`控制设备「电脉冲设备-anji」` + 红色标签「已拒绝」（悬停「远程投影不允许设备字段: bogus」）；12s 内 0 条 `client.ping` | 通过（终验修复 F1/F2） |
| 6 | B 改名 A 的设备 | A 侧名称变化 | A 侧 `a1007_td01.name = 左-远控改名`；B 设备表同名 | 通过 |

### 场景 4：页面式游戏与玩法仲裁（`s4.js`）

| # | 步骤 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 1 | B 游戏库（远程状态） | 游戏卡片带「远程」标签 | 设备控制台「远程时有延迟」、女仆偷懒惩罚「远程无延迟」 | 通过 |
| 2 | B 启动 device-control | 被控端登记占用 | A `occupancy={gameId:'device-control',gameName:'设备控制台'}`，A 条「⚠ {B} 正在控制你的客户端 · {B} 正在运行《设备控制台》」，操作记录「开始玩法《设备控制台》」（F9） | 通过 |
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
| 6 | SSE 帧数（10s 空闲 / 活动 3s） | 记录数值 | 运行中 10s：**14 条 patch**（1.4/s，TD01 每 5s 递增触发）；活动 3s：**6 条 patch**（2.3/s）；停止后 10s：**2 条 patch**（0.4/s） | 通过 |
| 7 | 停止游戏 | 被控端结束 | A `running=false`、`endReason` 由 `stop-current` 收尾 | 通过 |

### 场景 6：急停 / 撤权 / 踢出 / 掉线（`s6.js`、`s6b-disconnect.js`）

| # | 步骤 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 1 | B 制造 20V 电击 → 点「急停」 | 立即停投影输出，会话保持 | 急停前 3 帧 `{voltage:20,shock:1}`；急停后 3s 内**无新帧**（B 侧日志 `operator safe stop: session-emergency-stop (1)`，被控端收到停止帧）；两端仍 `phase=active/authorized=true` | 通过（**修复 #5**：原先要等 8.8s 看门狗） |
| 2 | 同样流程，A 点「急停」 | 只停主控端输出 | 归零帧 **31ms** 到达；两端会话保持 active | 通过 |
| 3 | A 撤权 | B 失去控制 + 弹「对方已收回控制权」+ 回本机模式 | B `phase=ended`、`lastError=revoked`；弹窗「远程已结束｜对方已收回控制权」；A `phase=pending-authorization`（成员仍在房间，可再次授权）；B 设备表清理见 §4.4 | 通过（**修复 #6/#7/#8**） |
| 4 | B 重新输码加入 + A 授权 | 恢复控制 | `rejoin.ok=true`；B 回到 `active`，设备表重新出现 A 的 6 台 | 通过 |
| 5 | A 踢出 | B 弹「对方已将你移出」 | B `phase=ended`、`lastError=kicked`、自动回 `#/remote`；A `phase=waiting` | 通过（终验修复 F5 后弹「对方已将你移出」） |
| 6 | B 掉线（杀 B 后端） | A 停掉 B 触发的输出 | 掉线前 9 帧电击；杀进程后 12s 采样无新帧；A 侧日志 `operator outputs stopped: operator-offline (1)`；A 会话保持 active | 通过 |
| 7 | B 重启 | 恢复干净状态 | B 后端重启后 `phase=idle`（不自动恢复旧房，符合设计）；A 仍 active，B 设备表只剩本机设备 + 上次会话遗留（见 §6.1） | 通过 |

### 场景 7：长跑（`s7-longrun.js`，800s）

| # | 步骤 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 1 | 会话建立后每 20s 采样 | 全程不断线 | 39 次采样 / 809s：A/B 均 `phase=active`、`authorized=true`、`lastError=null`，投影房间 id 全程稳定；非 active 采样 0 次 | 通过 |
| 2 | 跨 600s TTL 凭据刷新 | ≥1 次刷新不断线 | 窗口内 2 次 `RemoteGame credential refreshed and reconnected`（B 侧 16:44:26 / 16:57:43，另 A 侧 16:57:37 一次），刷新期间会话未变 `reconnecting` | 通过 |
| 3 | 每 3 次采样写一次设备 | 控制仍可用 | 13 次写入全部 200（`writeOk=13, writeFail=0`） | 通过 |
| 4 | 延迟 | 记录 | 45–53ms（均值 50ms） | 通过 |

> 长跑脚本 `s7-reshoot.js` 输出：`{"samples":39,"errors":0,"writeOk":13,"writeFail":0,"latencyMin":45,"latencyMax":53,"latencyAvg":50,"durationSec":809}`。

---

## 4. 关键测量

### 4.1 延迟

| 场景 | 延迟 |
|---|---|
| 场景 1 授权后 | 48–53ms |
| 场景 6 急停前 | 50–64ms |
| 场景 7 长跑 39 次采样 | 45–53ms（均值 50ms） |

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
| 运行中 10s | 14 条 `patch` | 1.4/s | TD01 每 5s 递增 → 有变化才推 |
| 活动 3s（QTZ 按下 → 电击） | 6 条 `patch` | 2.3/s | 含状态变化 + 日志 |
| 停止后 10s | 2 条 `patch` | 0.4/s | 收尾变化，之后无流量 |

> 说明：本机设备每 30s 心跳重发属性，`gameHostService` 只在值真变化时转发，因此空闲窗口仍有低频 patch（TD01 递增）；**完全静止的窗口（场景 5 停止后 10s）降到 2 条**。50ms 合并窗口上限 ~20 条/秒，实测远低于上限。

### 4.4 会话收尾后的设备表（主控端）

| 时机 | B 设备表 |
|---|---|
| 会话 active | `b1007_td01` + A 的 6 台（`remote` 连接） |
| 撤权后（修复前） | 7 台，A 的 6 台变成「离线设备」长期留存 |
| 撤权后（本轮修复后） | 残留 3 台（`a1007_dglab/qtz/cunzhi`） |
| 撤权后（终验修复 F6 后） | 撤权后 15s 内每秒采样，A 的设备 **0 台**，只剩本机 `b1007_td01` |

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

### 5.1 终验修复（2026-10-07 终验；F9–F10 为当日晚截图重拍复核时补修）

| # | 现象 | 根因 | 修复 | 提交 |
|---|---|---|---|---|
| F1 | 被控端操作记录每 5s 刷一条 `client.ping` | 主房间每条已授权命令（含心跳、只读请求）都发 `command` 事件，编排层原样入记录 | 心跳/只读类（`client.ping/hello/snapshot.request`、`game.snapshot.request`、`session.projection-invite.request`、`games.list`、`game.meta`、`game.config.get`、`devices.list` 等）不入记录；投影授权成功这一内部步骤也不再入记录 | `ffc3e13` `f3c106d` |
| F2 | 摘要是原始 id/字段（`控制设备「a1007_td01」power 30`、`被拒绝：远程投影不允许设备字段: bogus`），文字里重复「已限制为」 | 摘要直接拼设备 id 与字段名，结果写进文字 | 设备显示昵称/名称（查不到用 id），字段映射为 电压/强度/电击/…；结果只用标签表达：已限制（琥珀）/已拒绝（红），详情 `detail.hint`（「请求 999 → 实际 20」/拒绝原因）作为标签悬停提示；列表按记录身份做 key、标签关过渡，避免新记录插顶时标签挂错行 | `ffc3e13` `f3c106d` |
| F3 | 被控端远程条显示空的「延迟 ms」 | 被控端 `latencyMs=null`，`Number(null)=0` 判定为有限数 | `latencyValue()` 拿不到就返回 null，远程条不显示 | `ce8f4b7` |
| F4 | b-04 截图：主控端已在新会话「正在控制」，却挂着「远程已结束 / 对方已结束远程」 | **真实缺陷**（不是纯脚本假象）：上一段会话结束的提示没被点掉时用户又加入了新会话，旧弹窗一直挂着，点掉后还会把用户从新会话拉回 `/remote`。脚本复位上一段会话（`stop`）后立即开新会话，而后台窗口的轮询被浏览器节流，提示晚弹，正好落进新会话 | 后端会话带 `sessionId`，ended 状态带上刚结束那段的 id；前端闸门 `stepEndedGate` 只提示刚才在跑的那段（迟到的旧 ended 不弹）；提示开着时进入新的活跃会话 → 自动关闭且不跳页 | `d67ab14` |
| F5 | 踢出后主控端显示「对方已收回控制权」 | 会话层 `kick` 先调 `game.revoke()` 关授权，它发出的定向结束通知固定 `reason=revoked`，主控端先收到它就按撤权收尾，随后的 `kicked` 被忽略 | `revoke({reason})`，踢出路径传 `kicked` | `3f4c4ac` |
| F6 | 撤权后主控端残留 `a1007_dglab/qtz/cunzhi` 三台离线设备（原 §6.2） | **根因不是晚到的清单**：`deviceService.removeDevice` 在 `await` 断开连接之前取下标、之后 `splice`；投影收尾同时删 6 台，后面的删除用过期下标，删错、漏删一半——恰好是隔一台漏删的这 3 台 | `removeDevice` 在 await 之后重新定位；另做时序加固：房主每次授权/撤权/移出递增 `authEpoch` 随清单下发，操作方丢弃代次更旧的清单、`authorizedFor` 不是本账号时不登记设备、授权结束后忽略设备状态；房主无授权对象时不发完整清单 | `63d4bbb` `bb1e1ea` |
| F7 | 主控端远程模式下设备页「蓝牙连接 / 设备工具 / 清空设备」仍可点，点了只得到 423 | 设备页没有接远程锁定 | 三个入口置灰，悬停提示「请在被控端操作」（设备工具含配网/串口/批量/固件，全部打本机锁定接口） | `0dca926` |
| F9 | 被控端操作记录把玩法写成游戏 id（「启动玩法《maid-punishment》」「开始玩法「device-control」」） | 主控端 `game.start` 只带 `gameId`，编排层 `_summarize` 拿不到游戏名；`play.occupy` 走 `_logEvent` 直出摘要，从不拼名字 | 主控端 `game.start` / `game.stop` 带上游戏名；被控端会话级记住玩法 id→名字（登记占用时学到、写记录时兜底），摘要据此写名字 | `412fde0` `7323422` |
| F10 | 被控端房间被挂住：主控端玩法登记/停止全部超时、`HOST_PLAY_ACTIVE` 闸门关着不放开（12 个用例超时复现） | 上一版把 `gameName` 的取值写进了 `_onOwnerCommand` 的 `try` 里，而 `session.gameNames` 在某些会话对象上不存在，取名字时抛错 → 被控端房间收到命令后既不回执也不执行 | 取值挪到 `try` 之外、会话创建时就带 `gameNames`、收尾时清空；`remoteSessionService._gameName` 对缺失的映射表做兜底 | `7323422` |

新增/更新单测：`remoteSessionService.test.js`（心跳不入记录、设备名与字段中文、`sessionId` 随 ended 带出、踢出/撤权原因区分）、`deviceTransportRouting.test.js`（并发删除 6 台只剩本机设备，修复前复现残留 3 台）、`remoteProjectionService.test.js`（撤权前算好的清单撤权后才到不重新登记、迟到的设备状态不认、重新授权恢复；无授权时不发完整清单；未授权操作方不登记给别人的设备）、`frontend/tests/remoteSession.test.ts`（结束提示按会话对号入座的完整时序、延迟缺省、悬停详情）。

**`npm run check`（终验修复后）：后端 924 通过 / 1 跳过（111 个套件），前端 61 通过，前端类型检查与生产构建通过。**

### 5.2 终验复核（同一套 harness，`s8-final-fixes.js`）

双隔离 Electron、生产房间服务与 EMQX、仅虚拟设备（启动后核对两端设备表：只有 `a1007_*` / `b1007_td01` 虚拟设备，无串口/BLE/MQTT 真实硬件）。后台窗口里页面计时器被节流，取证前由脚本手动触发一次状态轮询（等同前台窗口 1s 轮询）。

| 项 | 步骤 | 结果 |
|---|---|---|
| F1–F3 | 主控端写 电压 999、强度 999、未知字段 `bogus`、强度 30、归零，等 12s（跨两次心跳）后看被控端记录 | 记录 7 条：开启远程 / 允许控制 / 3 条 ok / 2 条已限制 / 1 条已拒绝，**`client.ping` 0 条**；标签悬停详情「请求 999 → 实际 20」「请求 255 → 实际 128」「远程投影不允许设备字段: bogus」；被控端远程条 `⚠ 7ETZNS 正在控制你的客户端 / 操作记录 / 急停 / 踢出`，无延迟字样 |
| F4 | 会话 1 进行中 → 被控端结束（主控端弹「对方已结束远程」，不点）→ 直接开会话 2 并授权 | 会话 2 活跃后提示自动关闭（`dialogClosedByNewSession=true`），主控端停在 `#/devices`、远程条「正在控制」、设备表为 A 的 6 台 |
| F5 | 建会话 → 被控端踢出 | 主控端 `lastError=kicked`，弹「对方已将你移出」，确定后回 `#/remote` |
| F6 | 建会话 → 被控端撤权，15s 内每秒采样主控端设备表 | A 的设备 15 次采样均为 0 台，只剩 `b1007_td01`；弹「对方已收回控制权」 |
| F7 | 主控端远程模式进入设备页 | 蓝牙连接 / 设备工具 / 清空设备 `disabled=true`，刷新列表可用；悬停提示「请在被控端操作」 |

### 5.3 截图重拍复核（2026-10-07 晚）

报告里的早期截图是在后续修复之前拍的（例如 b-04 还挂着上一段会话的「远程已结束」、a-07 的操作记录还是原始 id/字段）。本次在**当前代码**上重拍全部截图，逐张核对「屏幕内容 ↔ 图注 ↔ 当前行为」，过程中又发现并修复两处缺陷（**F9 / F10**，见 §5.1 表末）：

- **F9** 被控端操作记录把玩法写成游戏 id（「启动玩法《maid-punishment》」「开始玩法「device-control」」）；
- **F10** 为修 F9 引入的回归：被控端房间被挂住（主控端玩法登记/停止全部超时、`HOST_PLAY_ACTIVE` 闸门不放开），12 个后端用例超时复现。

重拍说明（同一套 harness，生产房间服务与生产 EMQX，仅虚拟设备）：

- **重拍步骤**：场景 1（01–05）、场景 2（06–07）、场景 3（08–09）、场景 4（10–12）、场景 5（13–19）、场景 6（20–26）、场景 7 长跑（27），共 54 张；a-28 / b-28 复核后保持原图（F7 置灰行为未变）；
- 重拍脚本在 `.tmp/remote-session-e2e-1007/`（`s1-reshoot.js`、`s2.js`、`s3.js`、`s4b-dialog.js`、`s5b-reshoot.js`、`s5d-pair.js`、`s5e-pair17.js`、`s5b-held.js`、`s5c-opl-reshoot.js`、`s6c-shots.js`、`s6d-rejoin.js`、`s6b-reshoot.js`、`s7-reshoot.js`）；
- 重拍时关掉页面过渡动画、并在取证前手动催一次状态轮询（后台窗口计时器被节流），否则弹层/弹窗会被拍到淡出中的半透明状态；
- 每张图都按「屏幕 ↔ 图注」核对过一遍；重拍后没有一张图依赖早期（修复前）的界面。

**`npm run check`（本次重拍复核后）：后端 924 通过 / 1 跳过（110 个套件），前端 63 通过，前端类型检查与生产构建通过。**

---

## 6. 残留问题

### 6.1【低】被控端设备页会累积重复的虚拟设备条目

调试期间反复创建/删除同名虚拟设备（`DELETE /api/virtual-devices/:id` 会删设备记录，但同一 id 再次创建时旧记录可能先于新连接写入设备表）会在被控端留下 `a1007_*` 的离线条目。正常使用路径（每台设备只创建一次）不会出现；本轮报告中的设备计数差异（场景 1 的 6 台 vs 收尾时 4 台等）即由此而来。

### 6.2【低】房间服务偶发超时会在界面上留下 `lastError`

长跑期间被控端投影状态偶发 `lastError=房间服务请求超时`（30s 周期心跳/成员刷新，8s 超时），会写进投影状态并渲染到面板上；功能全程正常（`active/authorized/设备数` 未受影响）。上一轮报告记录过同类观察，本轮仍未改。（原 §6.4 与 §6.5 是同一问题，已合并。）

### 6.3【已修复】撤权后被控端远程条显示「⚠ 正在控制你的客户端」但没有对方名字

撤权后被控端回到 `pending-authorization`，但 `peer` 已被清空（a-19 截图），远程条文案缺名字；而主控端撤权后会结束会话，这时被控端更合理的状态是等成员离开后回 `waiting`。终验复核时发现，**已修复（F8）**：撤权与授权关闭时被控端直接回到 `waiting` 并清空对方，主控端重新输码加入后由成员上线事件进入「待授权」。单测 `revoke, kick and stop cascade to both links` 已改为断言 `waiting`。

> 原 §6.1（踢出文案）、§6.2（撤权后残留设备）已在终验修复（F5、F6）。

---

## 7. 步骤截图

> 本节 56 张图都已按**当前代码**逐张核对：54 张重拍（步骤见 §5.3），a-28 / b-28 复核后保持原图。图注写的就是屏幕上的实际内容，与「预期」不一致的地方已在图注里说明；早期（修复前）的截图已全部替换，报告里不再引用它们。

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

*A 被控端 · 04 本机 6 台虚拟设备（重拍复核）*

![B 主控端 · 04 只显示对方设备](remote-session-e2e-2026-10-07/b-04-devices-only-remote.jpg)

*B 主控端 · 04 设备表只有被控端 6 台（无本机 `b1007_td01`）；远程条「正在控制」时没有上一段会话的「远程已结束」弹窗（F4：上一段会话结束的提示在新会话活跃后自动关闭）；蓝牙连接 / 设备工具 / 清空设备置灰（F7）*

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

*A 被控端 · 08 操作记录弹层（重拍复核）：设备名 + 字段中文名，「已限制」琥珀标签、「已拒绝」红色标签，无 `client.ping`；远程条无「延迟 ms」*

![B 主控端 · 08 超限写入](remote-session-e2e-2026-10-07/b-07-clamped-oplog.jpg)

*B 主控端 · 08 超限写入被钳制*

![A 被控端 · 09 改名生效](remote-session-e2e-2026-10-07/a-08-renamed.jpg)

*A 被控端 · 09 远控改名在被控端生效（左-远控改名）*

![B 主控端 · 09 改名生效](remote-session-e2e-2026-10-07/b-08-renamed.jpg)

*B 主控端 · 09 设备表显示新名称*

### 场景 4：页面式游戏与玩法仲裁

![A 被控端 · 10 页面式游戏运行](remote-session-e2e-2026-10-07/a-09-b-page-game-running.jpg)

*A 被控端 · 10 远程条显示「{对方} 正在运行《设备控制台》」，操作记录里是「开始玩法《设备控制台》」（F9）*

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

*A 被控端 · 22 撤权后回到「等待对方加入…」，远程条消失（F8）*

![B 主控端 · 22 撤权](remote-session-e2e-2026-10-07/b-19-revoked.jpg)

*B 主控端 · 22 弹窗「对方已收回控制权」，设备表只剩本机 1 台（F6 复核：A 的 6 台投影设备 0 台残留）*

![A 被控端 · 23 重新授权](remote-session-e2e-2026-10-07/a-20-rejoined.jpg)

*A 被控端 · 23 重新授权*

![B 主控端 · 23 重新授权](remote-session-e2e-2026-10-07/b-20-rejoined.jpg)

*B 主控端 · 23 重新加入并授权*

![A 被控端 · 24 踢出](remote-session-e2e-2026-10-07/a-21-kicked.jpg)

*A 被控端 · 24 踢出后回到「等待对方加入…」，远程条消失*

![B 主控端 · 24 踢出](remote-session-e2e-2026-10-07/b-21-kicked.jpg)

*B 主控端 · 24 弹窗「对方已将你移出」（F5 复核），确定后回远程连接页*

![A 被控端 · 25 主控端掉线](remote-session-e2e-2026-10-07/a-22-operator-offline.jpg)

*A 被控端 · 25 主控端掉线：操作记录里最后一条是「控制设备「电脉冲设备-anji」电压 20」，会话保持 active（被控端不主动结束，等对方回来）*

![B 主控端 · 25 主控端掉线](remote-session-e2e-2026-10-07/b-22-operator-offline.jpg)

*B 主控端 · 25 后端被杀死（页面停在设备管理，远程条还挂着最后一次状态）*

![A 被控端 · 26 主控端重启](remote-session-e2e-2026-10-07/a-23-operator-restarted.jpg)

*A 被控端 · 26 主控端重启后：被控端画面与 25 相同（会话仍 active，等对方重新加入）*

![B 主控端 · 26 主控端重启](remote-session-e2e-2026-10-07/b-23-operator-restarted.jpg)

*B 主控端 · 26 重启后回到本机模式（无远程条，设备表只有本机设备）*

### 终验补充：主控端设备页本机专属按钮

![A 被控端 · 28 本机专属按钮](remote-session-e2e-2026-10-07/a-28-host-only-locked.jpg)

*A 被控端 · 28 对照：被控端设备页按钮照常可用*

![B 主控端 · 28 本机专属按钮置灰](remote-session-e2e-2026-10-07/b-28-host-only-locked.jpg)

*B 主控端 · 28 远程模式下蓝牙连接 / 设备工具 / 清空设备置灰，悬停提示「请在被控端操作」（F7）*

### 场景 7：长跑

![A 被控端 · 27 长跑](remote-session-e2e-2026-10-07/a-27-longrun.jpg)

*A 被控端 · 27 长跑（809s，跨 2 次凭据刷新）：操作记录弹层里是每 5s 一条「远程玩法输出「偏轴电机控制器-td01」数值 128」+「已限制」，以及主控端的「控制设备…强度 30 / 0」*

![B 主控端 · 27 长跑](remote-session-e2e-2026-10-07/b-27-longrun.jpg)

*B 主控端 · 27 长跑（延迟 52ms，设备表 6 台在线）*

## 8. 清理

- 由本轮启动的全部进程（A/B 后端、A/B Vite、A/B Electron、`/drecv` 抓包、长跑脚本）已停止；
- `/api/dev-access` 已复位 `enabled=false`；
- 测试脚本保留在 `.tmp/remote-session-e2e-1007/`；
- 未切换分支；除 §5 的缺陷修复与单测外未改动生产代码。
- 终验复核：重新拉起同一套 harness（两端新建匿名账号），`s8-final-fixes.js` 跑完后结束会话、两端 `/api/dev-access` 复位 `enabled=false`，`stop-all.ps1` 停掉全部进程（含上一轮遗留的 3 个空闲 shell）。
- 截图重拍复核：复用同一套 harness 重拍 54 张图（场景 1–7；a-28 / b-28 复核后保持原图），期间重启过两次隔离后端（`7323422` 落盘后各端各重启一次），跑完长跑（809s）后结束两端会话、清掉两端虚拟设备、`stop-all.ps1` 停掉全部进程，两端 `/api/dev-access` 复位 `enabled=false`。
