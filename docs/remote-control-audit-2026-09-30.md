# 远控机制审查报告（2026-09-30）

**范围**：`control-panel` PC 端两条远控链路（远程设备投影、远程游戏/客户端远控），及服务端房间 API + EMQX ACL（`control_panel_mobile` 仓库）。
**方法**：代码走查 + 本机实测（附录 B）。只读审查，未改任何代码，未碰生产服务器。
**总体结论**：功能链路能跑通（相关 26 个单测全绿），但「谁能控制」「能控制到什么程度」「出事怎么停」三方面都有实质缺陷。这是电击类硬件控制系统，P0 项建议在远控被更多人使用前修复。

## 1. 链路速览

- 两条链路共用：房间服务（`api.undersilicon.cn`，joinCode 加入）+ EMQX（WSS 8084；JWT 内嵌 ACL，TTL 10 分钟，`disconnect_after_expire=true`）。
- topic：`rooms/{id}/commands/{userId}`（B→A）、`rooms/{id}/events`（A→B）、`rooms/{id}/presence/{userId}`（retain + 遗嘱）。
- **投影**：A 把本机物理设备经房间授权给操作方；操作方发 `projection.write` **原始设备报文**，A 侧 `_clampMessage` 限幅后下发。
- **远程游戏**：A 跑 HostRuntime 执行游戏逻辑；B 发白名单命令（含 `devices.invoke` 直接能力调用）；授权是会话级布尔值。
- 服务端踢线（EMQX admin）未接线：离开/关闭/踢人都不断开现有 MQTT 连接，旧凭据最长还能用约 10 分钟。

---

## 2. P0 — 安全

### 2.1 投影限值对品牌设备不生效

- `_clampMessage` 只认顶层 `voltage`/`power` 两个字段（`backend/services/remoteProjectionService.js:524-535`）。
- 郊狼 DGLAB 用 `intensity`，YCY 用 `value`/`intensity`（`backend/devices/registry.js:148-197`），全部原样透传。
- 实测（附录 B-1）：`{brand:'dglab',cmd:'setPattern',intensity:100,ticks:-1}` 过钳制后不变；`ticks:-1` 即不限时。
- 能力层各设备类型自有限幅：DGLAB/YCY 0–100，但 DIANJI、SOSEXY 对 `voltage` 完全不限（实测 999 原样出，附录 B-2）。
- 影响：主机界面设置的「电压上限 20V」对相当一部分设备类型是假保障。

### 2.2 远程游戏 `devices.invoke` 无限幅 + 断线不停机

- `devices.invoke` 无任何数值校验（`backend/services/remoteGameService.js:537-549`）；实测 DIANJI `voltage=999` 原样下发。
- 电击是锁存语义：写入 `shock:1` 后必须显式写 `0` 才停。
- B 断线时 A 侧只清 pending、拆远程设备（`remoteGameService.js:298-303`），**不会** `host.stop` —— 组合「B 手动 invoke 开电击 → B 断线」电击持续，无自动兜底。
- `devices.disconnect` 可在输出进行中把 A 面板侧的设备连接断开（仅当设备被运行中游戏占用才先停游戏，手动 invoke 不算），之后 A 发不出停止指令，而设备自身仍连着 broker、输出继续。

### 2.3 授权不绑定人，加入码永不失效

- 服务端：joinCode 不过期、加入无需 A 同意、有人离开后他人可持同码进入、被踢者换账号可再进（`packages/api/src/routes/rooms.ts:155-190`）。
- 远程游戏授权不校验发送者（`remoteGameService.js:238-245,440`）：B 走后 C 进入即继承全部控制权。违反 09-23 方案 §8.4。
- 投影完全没有授权步骤：任何成员上线，A 就主动推设备清单并接受其写命令（`remoteProjectionService.js:339-346,354+`）。
- 撤权/踢人不断线（服务端踢线未接线），旧凭据 ≤10 分钟仍可控制；PC 端没有踢人入口（`backend/services/roomApiService.js`）。
- A 端 UI 只显示在线人数，看不到对方是谁。

### 2.4 本机暴露面被远控放大

- 后端/前端服务器绑 `0.0.0.0`（`electron/main.js:924,960`）；实测局域网 IP 直达 `:5278/api/remote-game/*`，authorize/revoke 无需任何凭据。
- `/games/proxy/<host>/...` 无白名单反向代理，且剥掉 `X-Frame-Options`/CSP（`backend/routes/gameProxy.js:39-41`）。
- 游戏 iframe 无 `sandbox`（`frontend/src/views/GameCurrentView.vue:3-10`）：外部游戏页与面板同源，可读 localStorage 里的账号 token（`frontend/src/api/auth.ts:27`，key 与移动端共享）。
- 组合后果：恶意/被注入的外部游戏页可静默自建房间、自授权、外发房间码。
- `docs/adr/0001`「本机即可信」的前提在接入远控后已不成立——该 ADR 自己写明此时认证是第一优先级。

## 3. P1 — 功能 bug

### 3.1 远程游戏约 10 分钟必断

- 凭据 TTL 10 分钟且 broker 到期强断（`deploy/mqtt-room/emqx.prod.conf:34`）。
- `remoteGameService` 仅在 create/join 取一次凭据（`:123,162`），**没有刷新逻辑**（对比投影的 `_refreshCredential`）。到期被断后，过期凭据重连永远失败；B 见 host presence offline 即拆除会话（`:429-431,613-624`）。
- 读代码+配置确认，未做 10 分钟长跑实测。

### 3.2 投影每约 8 分钟自动急停一次（实测复现）

- `_refreshCredential` 调 `client.reconnect()`（`remoteProjectionService.js:650`）；mqtt.js 5.14.1 已连接态 reconnect = 先 `end()` 再连（`mqtt/lib/client.js:768-793,849-861`），触发 `close` → `_safeStop` 复位所有共享设备（`:221-230`）。
- 本机 broker 实测复现（附录 B-3）。注意 ZIDONGSUO 自动锁的 close 是 `open:1`：**每次刷新都会开锁**。
- 凭据提前 2 分钟刷新 → 长会话约 8 分钟一轮，设备反复复位、玩法掉设备。

### 3.3 掉线兜底太慢

- 操作方掉线靠 presence 遗嘱判定，keepalive 60s + broker 半开检测，A 约 1–2 分钟后才 `_safeStop`；期间锁存输出持续。
- A 侧对 `projection.write` 没有「单次输出最长时长」上限。

## 4. P2 — 设计与一致性

### 4.1 无统一设备占用仲裁

- 投影 `_safeStop` 复位 A **所有**本地设备，含本地游戏正在用的（`remoteProjectionService.js:658-664`）。
- 远程游戏设备清单来自 `listDevicesForApi`，含 `remote` 连接（从 C 投影来的设备）：B 可经 A 控制 C 的设备，而 C 只授权过 A（`remoteGameService.js:682-692`）。
- 四路写入方（投影 / 远程游戏 / 本地游戏 / 手动控制）无互斥。违反 09-23 方案 §7.8。

### 4.2 09-23 跨端方案 PC 侧未完成项

（方案：`control_panel_mobile/docs/plans/2026-09-23-mobile-pc-remote-game-runtime.md` §8、§11）
- 无 `controlProtocolVersion` 协商、grant/epoch、`gameSessionId`/revision 绑定 → B 的旧 `game.stop` 可误停 A 新开的局（`remoteGameService.js:482` 无校验）。
- 无异步停止屏障（宿主方案自己要求，`gameHostService` 未实现）。
- 未授权时 B 已能收到完整设备清单与游戏快照（方案要求最小状态）。
- B 端游戏页面仅按 gameId 解析，无版本/hash 校验（`frontend/src/play/gamePagePath.ts`）。

### 4.3 其他

- 游戏逻辑三份手工同步（core / manifest / 原始页面 game.js），靠人肉一致。
- 投影无人在线也全量推设备状态与原始报文（`remoteProjectionService.js:589-607`）；远程游戏 500ms 全量快照 + 重复日志（`remoteGameService.js:138-140,669-676`）。
- 服务端杂项：`hostEpoch` 恒 0；房间 1h `expiresAt` 从不检查；成员崩溃永久占名额（容量 2 时把别人挡在外面）；主机 clientId 经 `senderConnectionEpoch` 泄露且 broker 不校验 clientid（`emqx.prod.conf` 无 verify_claims），成员可冒用主机 clientId 顶其下线，投影 owner「断线→安全停→重连」循环互踢。

## 5. 修复建议（按顺序）

1. **止血（小改动）**
   - 后端/前端改绑 `127.0.0.1`；
   - 外部游戏 iframe 加 `sandbox`（或独立 origin）；
   - `/games/proxy` 关闭或加域名白名单。
2. **A 侧统一安全层**
   - 限幅按能力定义逐字段执行（覆盖品牌协议字段），不认识的报文拒绝而非透传；
   - 锁存输出（电击等）由 A 加最长时长定时器；
   - 操作者掉线/撤权立即停手动输出，不等 presence 遗嘱。
3. **授权绑定账号**：新成员默认无权限；授权明确对象（userId + 连接代次）并在 UI 显示；服务端补踢线；joinCode 轮换/过期。
4. **修凭据**：远程游戏补 `_refreshCredential`；刷新重连不得触发安全停（把「主动重建」与「异常断线」分开处理）。

## 附录 A：关键文件

| 文件 | 角色 |
| --- | --- |
| `backend/services/remoteProjectionService.js` | 投影（owner/operator、限幅、凭据刷新） |
| `backend/services/remoteGameService.js` | 远程游戏（白名单命令、授权、设备管理） |
| `backend/game-runtime/gameHostService.js` | A 端游戏执行、effects、复位 |
| `backend/routes/gameProxy.js` | 第三方游戏反代 |
| `backend/services/roomApiService.js` | 房间 API 客户端 |
| `frontend/src/views/GameCurrentView.vue` | 游戏 iframe 壳 |
| `control_panel_mobile/packages/api/src/routes/rooms.ts` | 服务端房间路由 |
| `control_panel_mobile/packages/api/src/lib/mqtt-room-token.ts` | MQTT JWT + ACL 生成（TTL 600s） |
| `control_panel_mobile/deploy/mqtt-room/emqx.prod.conf` | broker 认证/授权配置 |

## 附录 B：实测记录（2026-09-30）

1. `_clampMessage` 品牌字段透传：node 直调（本仓库 backend）。
2. 能力层电压：DIANJI `voltage=999`、SOSEXY `setShock voltage=999` 原样出；DGLAB 钳到 100。
3. 刷新→急停：本机 1883 broker + `RemoteProjectionService` 实例，`_refreshCredential` 后 `invokeDeviceClose` 触发（脚本 `control-panel/.tmp/refresh-safestop-check.js`，临时文件不入库）。
4. `:5278` 局域网可达：非回环 IP curl `/api/remote-game/status` 返回 200。
5. `npx jest tests/remoteProjectionService.test.js tests/remoteGameService.test.js tests/gameRuntimeBridge.test.js` → 26 passed。全部用 fake MQTT，覆盖不到 2.1/3.1/3.2 这类问题。

