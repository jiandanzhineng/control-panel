# PC 客户端远控端到端验收报告（fix/remote-control-hardening）

- 日期：2026-10-06
- 分支：`fix/remote-control-hardening`（未提交改动，仅验收，未改生产代码）
- 结论摘要：**13 项用例 13 项通过**（其中用例 6 通过但发现 1 处状态不一致缺陷、用例 13 有 1 条需留意的 Vue 警告，见 §4）

---

## 1. 测试环境

| 项 | 值 |
|---|---|
| 被控端 A（房主） | 前端 `http://127.0.0.1:5303` / 后端 `http://127.0.0.1:5301` / CDP `9234` |
| 主控端 B（操作方） | 前端 `http://127.0.0.1:5304` / 后端 `http://127.0.0.1:5302` / CDP `9225` |
| 隔离方式 | 双 Electron 实例（独立 profile/数据目录），`ELECTRON_ALLOW_MULTIPLE=1` + `ELECTRON_EXTERNAL_BACKEND=1`，测试 preload 把 `/api` 改同源走 Vite 代理 |
| 房间服务 | **生产** `https://api.undersilicon.cn`（`ROOM_API_URL` 默认值） |
| MQTT | **生产** `wss://mqtt.undersilicon.cn:8084/mqtt`（凭据由房间服务下发；实测 `exp-iat=600s`、ACL 10 条） |
| 本机设备 MQTT | 本机 EMQX `mqtt://127.0.0.1:1883`（虚拟设备回执） |
| 虚拟设备 | 全部走 `POST /api/virtual-devices/batch`：`v1006_qiya(QIYA)` `v1006_td01(TD01)` `v1006_dianji(DIANJI)` `v1006_lock(ZIDONGSUO)` `v1006_dglab(DGLAB)` `v1006_ycy(YCY_EMS)` `v1006_sosexy(SOSEXY_PID0004)` |
| `/api/dev-access` | `enabled=true`（仅本机手测放行；测试结束已复位为 `false`） |
| 硬件 | **仅虚拟设备，全程无任何真实硬件输出** |
| 脚本 | `.tmp/remote-regression-1006/`（沿用上一轮 harness，新增 `rr.js` / `longrun*.js` / `proj*.js` / `snap.ps1`） |

虚拟设备服务**支持品牌类型**：`DGLAB`、`YCY_EMS`、`SOSEXY_PID0004` 均可通过 `POST /api/virtual-devices/batch` 创建并进入设备表（7 台 `connected=true`），因此品牌限幅**走了真实远控链路**，未退化为「直接调 guard 模块」。

截图目录：`docs/test/remote-control-e2e-2026-10-06/`（宽度 ≤1280，JPEG 质量 78 / PNG）。

---

## 2. 步骤表

| # | 步骤 | 预期 | 实际 | 结果 | 截图 |
|---|---|---|---|---|---|
| 1 | A 建房 → B 用房间码 UI 加入 → A 看成员身份 → B 默认未授权 | A 成员列表显示 B 的 userId + 在线 + 移出房间；B 只有「未授权 / 等待主机授权后才能控制」，无设备列表 | A 面板 `房间成员 01M48H86972NG7W24Q2KTDSA9R 在线 移出房间`；B 面板 `未授权 … 等待主机授权后才能控制`，`devices.length=0`、无 iframe | 通过 | [a-01](remote-control-e2e-2026-10-06/a-01-join-wait.jpg) / [b-01](remote-control-e2e-2026-10-06/b-01-join-wait.jpg) |
| 2 | A 授权 → B 拿到设备+游戏 → 选 `pressure-edging-v2` → 配置 → 启动 → B iframe 渲染原始 UI（`?runtime=remote`） | 授权后 B 设备 7 台、游戏 2 个；启动后 iframe `src=/games/pressure-edging-v2/index.html?runtime=remote…`，页面自身 UI 渲染 | 授权后 `devices=7, games=[surge-edging, pressure-edging-v2]`；启动后 iframe 渲染「气压寸止3阶段升级版 … 暂停 / +10 强度 / ⚡ 电击 / 中间压力 / 临界压力 / 寸止:1 电击:1」 | 通过 | [a-02](remote-control-e2e-2026-10-06/a-02-authorized.jpg) [b-02](remote-control-e2e-2026-10-06/b-02-authorized.jpg) / [a-03](remote-control-e2e-2026-10-06/a-03-game-running.jpg) [b-03](remote-control-e2e-2026-10-06/b-03-game-running.jpg) |
| 3 | 暂停/继续 → 运行中改参 → shockOnce → +10 → forceEdge → 停止（设备复位） | 两端快照一致；停止后 TD01/电击/锁复位 | `paused true→false`；`criticalPressure 20→20.2`；日志 `已暂停 / 已继续 / 手动 +10 强度 → 10.0 / 触发电击 20V 3s / 过载！边缘寸止中`；`forceEdge` 200 且 `edgingCount 1→2`；`game.stop` 后 `ended=true reason=remote-stop`，`td01.power=0`、`dianji{voltage:0,shock:0}`、`lock.open=0` | 通过 | [a-04](remote-control-e2e-2026-10-06/a-04-paused.jpg) [b-04](remote-control-e2e-2026-10-06/b-04-paused.jpg) / [a-05](remote-control-e2e-2026-10-06/a-05-shock.jpg) [b-05](remote-control-e2e-2026-10-06/b-05-shock.jpg) |
| 4 | F5：删掉 B 本地 `surge-edging` 缓存后**首次**启动注册表游戏 | iframe 渲染且**不刷新页面** | `DELETE /api/game-cache/surge-edging/1.3.6` → `installed=false`；启动后 `POST /api/game-cache/install/surge-edging -> 200 (123ms)`，**1027ms** 后 iframe 出现，`window.__reloadCount=0`；`/api/games/surge-edging` 404 后正确回落到 install（无报错提示） | 通过 | [a-06](remote-control-e2e-2026-10-06/a-06-surge-first.jpg) / [b-06](remote-control-e2e-2026-10-06/b-06-surge-first.jpg) |
| 5 | 手动输出：DIANJI 999V 钳到 20 + 10s 看门狗；TD01 999 钳到 128 + 60s 看门狗；未知字段拒绝；stop 永远放行 | 钳制生效、到点自动停机、未知字段 400、stop 带脏字段也通过 | DIANJI：`{"voltage":20,"shock":1}`，第 10.0s 自动 `{"shock":0,"voltage":0}`；TD01：`{"power":128}`，~60s 后自动 `{"power":0}`（实测 66.8s 采样窗口内已归零）；`bogus` → `400 REMOTE_OUTPUT_REJECTED 远程控制不允许设置字段: bogus`；`stop + bogus` → 200 且 `power=0` | 通过 | [b-07](remote-control-e2e-2026-10-06/b-07-manual-clamped.jpg) [b-08](remote-control-e2e-2026-10-06/b-08-shock-watchdog.jpg) |
| 6 | B 有手动输出时 A 撤权 | 输出立即停；B 命令返回 `CONTROL_NOT_AUTHORIZED`；**运行中的游戏继续跑** | SOSEXY 写 200 → 实发 `value=128`；撤权后实发 `stopAll`（输出停）；B 再发命令 `403 CONTROL_NOT_AUTHORIZED 未授权远控`；`A.snapshot.running=true`、`B.snapshot.running=true` 游戏未中断 | 通过（发现 1 处状态不一致，见 §4.1） | [a-09](remote-control-e2e-2026-10-06/a-09-manual-output-active.jpg) [b-09](remote-control-e2e-2026-10-06/b-09-manual-output-active.jpg) / [a-10](remote-control-e2e-2026-10-06/a-10-revoked.jpg) [b-10](remote-control-e2e-2026-10-06/b-10-revoked.jpg) |
| 7 | F2：B 点「离开房间」→ 迅速返回且按钮不卡 → 同码重入 | 按钮不卡死；重入成功（需重新授权） | 点击后 **1541ms** 回到未连接视图，`stuckLoading=false`（轮询期间从未出现 loading）；同码重入 **533ms** 成功，`active=true auth=true devices=7` | 通过 | [b-11](remote-control-e2e-2026-10-06/b-11-rejoined.jpg) |
| 8 | 踢人：A 点「移出房间」 | B 的命令本地被拒 | `POST /api/remote-game/kick` → A `members[].status=kicked`、`operators=[]`、`authorized=false`；B `devices=0`；B 命令 `403 CONTROL_NOT_AUTHORIZED 已被移出房间`；B 仍 `connected=true`（已知取舍：服务端不断 MQTT，等 JWT 过期） | 通过（发现 1 处状态不一致，见 §4.1） | [a-12](remote-control-e2e-2026-10-06/a-12-kicked.jpg) [b-12](remote-control-e2e-2026-10-06/b-12-kicked.jpg) |
| 9 | F3：硬杀 A 后端（房主 retained offline），B 在房间内 | 不挂死；显示等待房主；A 重启后 60s 宽限内恢复或干净报错 | 杀进程后 B：6s/15s/30s 采样均 `active=true connected=true waitingForHost=true`，**HTTP 响应 ~2ms 无挂死**；第 60s `host offline grace expired: tearing down operator session`，B 干净回到未连接视图；A 重启后 `GET /api/remote-game/status` 200（不自动恢复旧房，属预期） | 通过 | [b-14](remote-control-e2e-2026-10-06/b-14-after-host-crash.jpg) |
| 10 | F1 长跑：已授权 + 游戏运行 ≥13 分钟；投影房并发 ≥9 分钟 | ~10 分钟凭据刷新不断线；B 快照持续；刷新不触发安全停机/设备复位；锁**不得**打开 | **远程游戏**：46 次采样 / 901s 全程 `connected=true`、45/45 `running=true`、**0 次错误、0 次 ended**；三次 `credential refreshed and reconnected`（12:57:11 / 13:05:12，另 12:49:10 一次）期间 `gameSessionId` 始终为 `793b671c-…` 未变；`lock.open` 全程 `0`，锁设备**零命令**（刷新未触发安全停机/复位）。**投影房**：31 次采样 / 601s 全程 `active=true authorized=true expired=false devices=7` | 通过 | [a-16](remote-control-e2e-2026-10-06/a-16-longrun-10min.jpg) [b-16](remote-control-e2e-2026-10-06/b-16-longrun-10min.jpg) [a-18](remote-control-e2e-2026-10-06/a-18-longrun2.jpg) [b-18](remote-control-e2e-2026-10-06/b-18-longrun2.jpg) |
| 11 | 投影：未授权操作方无设备清单 → 授权后有 → 写限幅 → 锁存看门狗 | 未授权看不到设备、写入被拒；授权后 7 台；超限钳制；10s 后自动停 | 未授权：B `devices=0`，写 5 条全部 `CONTROL_NOT_AUTHORIZED`；授权后 B `devices=7`、`authorizedFor=<B userId>`；写入实测 `voltage 999→20`、`power 999→128`、`dglab intensity 999→50`、`ticks -1→100`、未知字段/未知品牌 `REMOTE_OUTPUT_REJECTED`；电击帧 6065ms 发出、**16079ms 收到自动停机帧**（10s 锁存） | 通过 | [a-17](remote-control-e2e-2026-10-06/a-17-projection.jpg) [b-17](remote-control-e2e-2026-10-06/b-17-projection.jpg) |
| 12 | 暴露面：LAN IP 访问隔离后端端口 / 打包等价端口；非白名单代理 host | LAN → 拒绝；127.0.0.1 → 可用；第三方 host → 403 | `netstat`：5301-5304 全部 `127.0.0.1` LISTENING（无 `0.0.0.0`）；`192.168.5.38` / `100.64.0.1`(Tailscale) / `172.31.240.1` 访问 5301-5304 全部拒绝（curl `000`）；`127.0.0.1` 200。另起 `BACKEND_HOST=0.0.0.0 PORT=5399` 复测：LAN 访问远控路由 `403 REMOTE_LOCAL_ONLY`，回环 200。代理 `/games/proxy/https/evil.example.com/x.js` → `403 Proxy host not allowed`；白名单 `game.undersilicon.cn` → 200 且 `x-frame-options`/`csp` 被剥；回环 host → 200 | 通过 | 见 §3.4（无 UI，网络证据） |
| 13 | 两端窗口控制台错误 | 无新增错误 | 见 §3.5 | 通过（有 1 条需留意） | — |

---

## 3. 证据

### 3.1 手动输出限幅与看门狗（用例 5）

```
POST /api/remote-game/command {devices.invoke, v1006_dianji, shock.start, {voltage:999, mode:1}}
→ 200 {"ok":true}
虚拟设备 properties: {"voltage":20,"shock":1}                     # 999 → 20（electricCap=min(voltage 20, intensity 50)）
writeProps 记录: {"voltage":20,"shock":1} @t+0s
                 {"shock":0,"voltage":0}  @t+10.0s              # 电击看门狗 ELECTRIC_LATCH_MS=10000

POST {devices.invoke, v1006_td01, strength.set, {value:999}} → 200
虚拟设备 properties: {"power":128}                                # 999 → 128（DEFAULT_REMOTE_LIMITS.power）
writeProps 记录: {"power":128} @t+0s
                 {"power":0}   @t+~60s                            # 电机看门狗 MOTOR_LATCH_MS=60000

POST {devices.invoke, v1006_dianji, shock.start, {voltage:10, bogus:1}}
→ 400 {"error":{"code":"REMOTE_OUTPUT_REJECTED","message":"远程控制不允许设置字段: bogus"}}

POST {devices.invoke, v1006_td01, strength.stop, {bogus:9}}
→ 200 {"ok":true}；虚拟设备 power=0                               # stop 路径丢弃未知字段而非拒绝
```

### 3.2 投影链路写入（用例 11）

B（已授权）直连生产 MQTT 发 `projection.write`，本地 EMQX 模拟虚拟设备回执 `/dpub/<id>`：

```
写 v1006_dianji {method:update, voltage:999, shock:1}  → ok:true   → /drecv 收到 {"voltage":20,"shock":1}
写 v1006_dianji {method:update, voltage:10, nope:1}    → ok:false  REMOTE_OUTPUT_REJECTED 远程投影不允许设备字段: nope
写 v1006_td01   {method:update, power:999}             → ok:true   → {"power":128}
写 v1006_dglab  {brand:dglab, cmd:setPattern, intensity:999, ticks:-1}
                                                        → ok:true   → {"brand":"dglab","cmd":"setPattern","pattern":"p1","intensity":50,"ticks":100}
写 v1006_dglab  {brand:evil, cmd:x}                     → ok:false  REMOTE_OUTPUT_REJECTED 远程投影不允许品牌协议: evil
写 v1006_lock   {method:update, open:1}                 → ok:true   → {"open":1}
撤权后再写 v1006_td01 {power:50}                        → ok:false  CONTROL_NOT_AUTHORIZED 房主未授权本账号控制设备

锁存看门狗：电击帧 @6065ms，自动停机帧 {"shock":0,"voltage":0} @16079ms（差 10.0s）
授权前（未授权）5 条写入全部 CONTROL_NOT_AUTHORIZED；授权后 device-list 携带 authorizedFor=<B userId>
```

### 3.3 长跑与凭据刷新（用例 10）

```
controller-backend.out.log:
  [12:49:10.353] [INFO] RemoteGame credential refreshed and reconnected
  [12:57:11.778] [INFO] RemoteGame credential refreshed and reconnected
  [13:05:12.066] [INFO] RemoteGame credential refreshed and reconnected
host-backend2.out.log:
  [12:49:01.372] [INFO] RemoteGame credential refreshed and reconnected
  [12:57:02.304] [INFO] RemoteGame credential refreshed and reconnected
  [13:05:01.427] [INFO] RemoteGame credential refreshed and reconnected

采样（longrun5.log，901s / 46 点）：
  span 881s, errors 0, ended 0, running true 45/45, connected false 0
  gameSessionId 稳定 = 793b671c-5ff0-44ad-a8ec-3633a05b4e17（跨 3 次刷新未变）
  lock.open 全为 0；lock 设备命令共 3 条，时间 12:42:48(false) / 12:52:59(true) / 12:55:52(false)
  —— 13:05 刷新窗口内无任何 lock 命令 → 刷新未触发安全停机/解锁

投影房（soak2.log，601s / 31 点）：
  A: active=true authorized=true expired=false devices=7（全程）
  B: active=true authorized=true devices=7（全程）
```

### 3.4 暴露面（用例 12）

```
netstat -ano | grep LISTEN:
  TCP  127.0.0.1:5301   LISTENING     # 后端只绑回环
  TCP  127.0.0.1:5302   LISTENING
  TCP  127.0.0.1:5303   LISTENING     # 前端只绑回环
  TCP  127.0.0.1:5304   LISTENING

LAN / Tailscale / WSL 网段访问（curl -m 4）：
  192.168.5.38:5301..5304  → 000（连接被拒）
  100.64.0.1:5301..5304    → 000
  172.31.240.1:5301..5304  → 000
  127.0.0.1:5301 / 5302    → 200

纵深防御复测（显式 BACKEND_HOST=0.0.0.0 PORT=5399）：
  127.0.0.1:5399/api/remote-game/status  → 200
  192.168.5.38:5399/api/remote-game/status → 403 {"code":"REMOTE_LOCAL_ONLY","message":"远程控制接口只允许本机访问"}
  192.168.5.38:5399/api/remote-projection/status → 403 同上
  192.168.5.38:5399/api/devices → 200（非远控路由不加门，符合 loopbackOnly 只挂远控路由的设计）

gameProxy 白名单：
  GET /games/proxy/https/evil.example.com/x.js        → 403 "Proxy host not allowed"
  GET /games/proxy/https/game.undersilicon.cn/registry.json → 200，x-frame-options/csp 被剥（可嵌入）
  GET /games/proxy/http/127.0.0.1:5301/...            → 200（开发态回环放行）
```

### 3.5 控制台错误（用例 13）

CDP `Runtime.enable` + `Log.enable` 采集 20 秒：

A 窗口（5 条）：
- `Electron Security Warning (Insecure Content-Security-Policy)`（开发态既有，非本轮引入）
- `401 /api/auth/me`（测试用匿名 token 播种前的既有请求）
- `404 /api/games/surge-edging` ×3（**F5 修复后的预期回落**：注册表游戏先试 `/api/games/:id`，404 后走 `/api/game-cache/install`；控制台会留 404 记录但 UI 不报错）

B 窗口（7 条）：
- 同上 CSP 警告、`401 /api/auth/me`
- `403 /api/remote-game/join`（**首次加入时的 BROWSER_API_FORBIDDEN**，因 B 后端 `/api/dev-access` 未开；开启后加入成功。这是隔离手测环境特有，生产 Electron 走 IPC 不受影响）
- `404 /api/games/surge-edging` ×2（同 A，预期回落）
- `[Vue warn]: Invalid event arguments: event validation failed for event "blur".` ×2 —— **需留意**，见 §4.2

---

## 4. 缺陷与风险

### 4.1【中】踢人后重新授权会导致「已授权但命令被拒」的状态不一致

**现象（可复现）**

1. A 点「移出房间」踢掉 B → 双方表现正常（B 命令 `已被移出房间`）。
2. 之后 A 再点「授权控制」（`POST /api/remote-game/authorize`）→ 返回体里 `authorized=true`、`operators[].authorized=true`。
3. 此时 **A 的 `/api/remote-game/status` 仍是** `authorized=true, operators=[], members[.., status:"kicked"]`；**B 的 status 是** `authorized=true, devices=7`，B 面板恢复成「已授权 + 设备列表 · 7 + 游戏运行中」，**看起来完全正常**。
4. 但 B 发任何命令都返回 `403 CONTROL_NOT_AUTHORIZED 已被移出房间`。

**证据**

```
# A 侧 status
{"authorized":true,"operators":[],
 "members":[{"userId":"01M48H82BT…","role":"host","status":"joined"},
            {"userId":"01M48H869…","role":"player","status":"kicked"}]}
# B 侧 status
{"active":true,"authorized":true,"err":"Room membership required"}
# B 侧面板文字
1 · 连接房间 | 2 · 授权控制 | 3 · 运行游戏 | 已授权 | 离开房间 | 设备列表 · 7 | 参数 | 运行中可调整所有游戏参数
# B 侧命令
POST /api/remote-game/command {devices.invoke,…} → 403 {"code":"CONTROL_NOT_AUTHORIZED","message":"已被移出房间"}
```

**疑似位置**

- `backend/services/remoteGameService.js:284` `kick()` 第 294 行 `session.kicked.add(target)` —— 被踢 userId 进入黑名单后**没有任何路径清除**（`_refreshMembers` 只增不减：`if (member.status === 'kicked') session.kicked.add(member.userId)`，见 `:311`）。
- `backend/services/remoteGameService.js:331` `_setAuthorized(true)` —— 绑定授权对象时只按 `operatorsOnline` / `members[].status === 'joined'` 选人，**未检查 `session.kicked`**，于是把已拉黑的人重新设为 `authorizedUserId`。
- `backend/services/remoteGameService.js:818` `_onOwnerCommand()` 第 826 行 —— 先查 `session.kicked.has(senderUserId)` 直接拒绝，早于授权判断，因此授权被黑名单静默覆盖。

**影响**：房主看到的授权状态、操作方看到的面板都与实际权限不符，且没有任何提示；只能靠操作方先「离开房间」再重入（服务端 `status` 会从 `kicked` 变回 `joined`）才能恢复。

**建议方向**（未改动代码）：`kick()` 时不清除黑名单的话，`_setAuthorized(true)` 应拒绝绑定 `kicked` 成员并返回明确错误；或房主重新授权时把该成员从 `session.kicked` 移除（等同「撤销移出」）。

### 4.2【低】B 窗口 2 条 `[Vue warn]: Invalid event arguments: event validation failed for event "blur"`

出现在操作方面板的输入交互路径上（`RemoteDevicePanel.vue` 的 `setInput` 触发 `blur` 事件时）。不影响功能（用例 1-13 均通过），但说明某处 `el-input` / 自定义组件的 `blur` 事件声明与触发参数不匹配。来源为测试脚本合成事件，也可能是真实用户 blur 时会出现的既有告警，建议顺手核查。

### 4.3【低 / 观察项】投影房房主周期性拉成员超时会写脏 `lastError`

投影房运行中 A 侧 `/api/remote-projection/status` 的 `lastError` 在 18/31 次采样里为 `房间服务请求超时`（`roomApiService.js:4` `FETCH_TIMEOUT_MS = 8000`，`:16` `AbortController`），来源是 `remoteProjectionService.js:793` 的 30s 周期 `_refreshMembers` 心跳。该字段会直接渲染到面板上，可能误导用户以为远控出问题。功能未受影响（`authorized/expired/devices` 全程正常）。建议把周期心跳失败降级为 debug 级或不写入用户可见的 `lastError`。

### 4.4 已知取舍（非缺陷）

- 踢人后操作方仍保持 MQTT 连接直到 JWT 过期（用例 8 观察到的 `connected=true`），符合代码注释里的已知取舍。
- 房主进程被硬杀后，操作方在 60s 宽限期内维持「等待房主」，之后干净结束会话；房主重启**不**自动恢复旧房（需重新建房/加入），符合当前设计。

---

## 5. 结论

本轮 `fix/remote-control-hardening` 的 13 项端到端用例全部通过，上一轮回归记录（`docs/note.md` 2026-10-06 首条）中的 5 项失败均未复现：

| 上轮失败项 | 本轮实测 |
|---|---|
| ① 远程游戏 10 分钟凭据到期必断且无刷新（`Bad User Name or Password`） | 三次到期前刷新（12:49 / 12:57 / 13:05），长跑 901s 无断线、无错误、`gameSessionId` 未变 |
| ② 操作方 `stop()` 发 `session.revoked` 被 ACL 拒 → broker 踢线 → `leave`/`join` 永久挂起、按钮无限 loading | `stop()` 只由 owner 发 `session.revoked`（`remoteGameService.js:404` 后）；B 点「离开房间」1541ms 返回、`stuckLoading=false`；同码重入 533ms 成功 |
| ③ 房主 retained offline 的房间 `join` 静默挂死 | 硬杀房主后端后 B 的 status 仍 ~2ms 返回、`waitingForHost=true`；60s 宽限后干净结束；重启房主不挂死 |
| ④ `devices.disconnect` 返回成功但虚拟设备仍在线 | `UNSUPPORTED_DISCONNECT_TYPES` 显式拒绝 mqtt/虚拟设备并提示改用「停止设备」 |
| ⑤ 首次远程启动 surge-edging 请求 `/api/games/surge-edging` 404 不出 iframe | 删缓存后首次启动 1027ms 内 iframe 出现，`reloadCount=0`，`/api/games` 404 后回落 `/api/game-cache/install` 成功 |

新增的安全加固（输出安全层限幅/看门狗/未知字段拒绝、回环绑定 + `loopbackOnly`、gameProxy host 白名单、iframe sandbox）在端到端链路上全部生效。唯一需要跟进的实质问题是 §4.1 的踢人黑名单与重新授权不一致。

后端新增 4 个测试套件（`loopbackOnly` / `gameProxyAllowlist` / `gameProxyRoute` / `remoteOutputGuard`）实测 **34 passed**。

---

## 6. 清理

- 全部由本轮启动的进程（A/B 后端、A/B Vite、A/B Electron、0.0.0.0 复测后端、所有采样脚本）已停止。
- `/api/dev-access` 已复位为 `enabled=false`。
- 未提交、未切换分支、未修改任何生产代码；测试脚本保留在 `.tmp/remote-regression-1006/`。

---

## 7. 实测后修复（2026-10-06，单测验证）

- §4.1 踢人后再授权状态不一致：`_setAuthorized` 选择授权对象时排除被移出成员（被踢者仍连着 MQTT 会重发 presence 被重新记为在线）；无可授权成员时返回 `NO_OPERATOR`「没有可授权的成员」，不再出现「已授权但命令被拒」。新增单测 `re-authorizing after a kick never binds to the kicked member`。
- 投影心跳偶发超时：连续失败 3 次才写入 `lastError`，成功即清零。
- `gameSessionId`：携带且不匹配才拒绝 `STALE_GAME_SESSION`；不携带按旧协议放行，兼容尚未升级的移动端。
- 修复后 `npm run check`：后端 665 通过 / 1 跳过，前端 22 通过，构建通过。以上三项未重跑双端 UI 实测。
