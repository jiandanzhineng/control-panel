# 遥控车游戏设计

规则来源：`docs/adr/2026-10-26-rc-car-game-rules.md`。

## 形态

- id `rc-car`，内置游戏 `backend/games/rc-car/`，manifest `runtime: host`、`events: v2`、`core: game-core.js`，版本 1.0.0。照 maid-punishment 的结构。
- 设备槽：
  - `imu`：DAN01（`attitude`），必选。
  - `punish`：电击（`shock`），必选，CUNZHI01。
  - `sensor`：提肛压力（`sphincterPressure`），开附加规则时必选；CUNZHI01 可同时填 punish 和 sensor。
- 判定全在 core；页面只渲染快照、发操作、播语音。

## 姿态解算（core 内）

- 移植 `frontend/src/utils/dan01Attitude.ts` 的解码：`quat` 1/32768、`accel` ×0.00478515625、`gyro` ×0.0625。
- 转角：取相邻两帧四元数的相对旋转，投影到重力方向（由 accel 低通得到），累加成「绕竖直轴的累计转角」。与 DAN01 佩戴朝向无关，绑后腰或背上即可，不依赖磁力计。
- 爬行动作：1 秒滑动窗口内 accel 模长的标准差与 gyro 模长均值，任一超阈值算在动。阈值可调，开局校准时采静止基线。
- 朝向偏离：前进/后退开始时记下当前累计转角，之后偏离超过容差（默认 35°）算跑偏。

## 指令判定

- 前进/后退（按住）：按下播报，给反应时间 X（默认 3 秒）起步；之后任意 1 秒窗口内没有爬行动作或跑偏，即判不服从。前进和后退在 IMU 上无法区分，判定相同，只是口令不同。
- 停止：松开播报「停」，给 1.5 秒缓冲，之后仍在爬就判不服从。
- 左/右转（点按）：X 秒内朝指定方向累计转过 20° 算完成，超时判不服从。
- 左/右转（按住）：滑动窗口 X 秒内朝该方向转过 20°，窗口不满足就判一次，判完窗口重新计。
- 不服从后先播「没有照做」，再电击；同一条指令连续不服从时，每隔 X 秒再判一次。

## 惩罚

- 档位 1..N：电压 = 起始电压 + (档位-1) × 每档增量，封顶最高电压；时长单独设置。
- 逐级加强（开关）：每次不服从升一档；连续完成 K 条指令（默认 5）降一档，最低 1 档。
- A 手动电击：按当前档位电一次，带 1 秒冷却。
- 远程时 `remoteOutputGuard` 默认把电压封顶在 20，沿用现有远程限额，不另开口子。

## 附加规则（二选一或不开）

- 提肛：游戏全程（或只在前进/后退时，可选）压力须高于基线 + 增量，掉下来超过宽限时间就判不服从。基线开局采样。
- 寸止：沿用 pressure-edging-v2 的阈值规则（中段/临界），到临界电击。
- 两者都读同一个括约肌压力，同时开会冲突，所以做成单选。

## 按住与断线

- A 端按下发 `drive {dir, seq}`，按住期间每 400ms 重发；松开发 `release`。core 超过 1200ms 没收到就当松开，A 断网时 B 不会被一直要求爬。
- 现在每条 `game.action` 都会触发 B 发一次完整 client.snapshot，按住重发会很重。对 `game.action` 跳过 `_publishClientSnapshot`，只走 `game.patch`。

## 语音

- 只在执行端（B，host 模式）播放；A 端（remote 模式）不出声，只显示文字。
- IndexTTS-2.5 在 2080ti 本地生成，嫌弃少女风格（参考音色 Demo voice_03）。台词与情绪向量见 `tools/indextts/rccar.py`，后处理见 `tools/indextts/postprocess.sh`（MiniMax 中转无语音通道，已放弃）。
- 中英两套：`voices/zh/`、`voices/en/`，按游戏 locale 选。口令：前进、后退、左转、右转、停、没有照做、加强、减弱、校准请保持不动、校准完成、开始、结束，以及附加规则的提示。

## 界面（同一页面，两端角色不同）

- 深色 HUD 风：中央罗盘环显示 B 的实时朝向和本条指令的目标弧；动作能量条；当前指令和反应倒计时环；惩罚档位条；服从率、电击次数、指令数；远程时显示延迟。
- A 端：大号方向键（前后按住、左右点按/按住）+ 手动电击按钮，支持键盘 WASD/方向键与空格。
- B 端：只显示状态；本地一台机器玩时 A、B 共用这一页，方向键也在。

## 移动端

- 首期：手机可作 A 端（远程控制页渲染同一页面，已有通路）。
- 手机作 B 端执行需要移动端宿主支持 v2 设备事件，未验证，不进首期。

## 测试

- core 单测：注入合成的 quat/accel 序列，覆盖前进、停、转向点按与按住、超时、逐级升降、断线松开、两种附加规则。
- debug 接口 `/api/game-runtime/sensor` 注入 DAN01 数据做页面实测；双 Electron 远程回归（被控 5303/5301、主控 5304/5302）。
- 真实 DAN01/CUNZHI01 硬件需要用户实测。

## 方向标定（真机待测）

- 转角用「绕重力轴的旋转」，与 DAN01 哪个轴朝前无关；左右的正负号可能反，提供参数 `turnInvert`。
- 页面提供「方向测试」面板（未开局时可用）：实时显示累计转角、动作能量、原始 quat/accel/gyro，供真机标定。

## 接口约定（core ↔ 页面，子任务共用）

### 设备槽
`imu`（capabilities `["attitude"]`，必选）、`punish`（`["shock"]`，必选）、`sensor`（`["sphincterPressure"]`，非必选，附加规则开启时 core 开局校验）。

### 参数（key / 默认 / 范围）
- core：`durationMin` 15 / 0–180（0 不限时）；`reactionSec` 3 / 1–10；`turnDeg` 20 / 5–90；`calibSec` 3 / 2–10；`voiceEnabled` true。
- difficulty：`motionAccelStd` 0.8 m/s² / 0.1–5；`motionGyroDps` 20 °/s / 2–200；`headingTolerance` 35° / 10–90；`stopGraceSec` 1.5 / 0.5–5。
- punish：`shockVoltage` 10 / 0–100；`voltageStep` 5 / 0–50；`maxVoltage` 40 / 0–100；`shockDurationMs` 1000 / 100–5000；`escalation` true；`deescalateAfter` 5 / 1–50。
- addon：`addonMode` 0 无 / 1 提肛 / 2 寸止（number 0–2，若参数支持 options 则用下拉）；`pelvicDelta` 3 kPa / 0.5–30；`pelvicGraceSec` 2 / 0.5–10；`pelvicOnlyMoving` false；`edgingMid` 8 / 0–100；`edgingCritical` 15 / 0–150。
- advanced：`turnInvert` false。

### actions
- `press {cmd:'forward'|'backward'|'left'|'right', seq}`：按下及按住期间每 400ms 重发。新 cmd 取代旧 cmd。
- `release {cmd}`：松开。core 超过 1200ms 未收到某 cmd 的 press 视为 release。
- `shock`：手动电击，当前档位，冷却 1000ms。
- `recalibrate`：回到校准阶段（不计违规）。
- 以及通用 `start/pause/resume/stop`。未知 action 返回 `UNKNOWN_ACTION`。

### 阶段
`CALIBRATING`（calibSec 静止采基线：动作基线、压力基线）→ `STOPPED`（须静止；进入后 stopGraceSec 缓冲）↔ `MOVING`（forward/backward 按住）/ `TURNING`（left/right）。
- MOVING：按下后 reactionSec 起步期；之后每 1s 窗口无动作或 |朝向-起始朝向|>headingTolerance 判违规。
- TURNING：每个窗口 reactionSec 内须朝该向累计转过 turnDeg；完成即回 STOPPED（带缓冲）；若窗口结束时仍按住，开新窗口；未完成判违规并开新窗口（仍按住）或回 STOPPED（已松开）。
- STOPPED：缓冲后仍有动作判违规；同一状态违规后间隔 reactionSec 再判。
- IMU 超过 2000ms 无数据：`sensorOnline=false`，暂停全部判定不电。

### 惩罚
档位 1..maxLevel，maxLevel = floor((maxVoltage-shockVoltage)/max(voltageStep,1))+1；电压 = min(maxVoltage, shockVoltage+(level-1)*voltageStep)。违规：先 prompt `violation`，再 `{type:'device.shock', role:'punish', voltage, durationMs:shockDurationMs}`；escalation 开时升一档（prompt `level_up`）。完成指令 compliantStreak+1，达 deescalateAfter 降一档（prompt `level_down`）并清零；违规清零。开局 `device.set-report-delay {role:'imu', ms:50}`、`device.shock-stop`；结束 `device.shock-stop`。

### snapshot
```
{ gameId:'rc-car', running, paused, ended, endReason, phase, startedAtMs, elapsedMs, remainingMs,
  command:{cmd, held, sinceMs, deadlineMs, progressDeg, targetDeg, status:'pending'|'ok'|'violating'} | null,
  heading, headingRef, headingDelta, turnInvert,
  motion:{energy /*0..1*/, moving, accelStd, gyroMean}, sensorOnline,
  raw:{quat, accel, gyro} /*解码后数值，供方向测试*/,
  level, maxLevel, voltage, compliantStreak,
  stats:{commands, completed, violations, shocks, manualShocks, compliance /*0..100*/},
  addon:{mode, pressure, baseline, target, ok, edgingPhase},
  lastViolation:{reason:'no-start'|'no-move'|'off-heading'|'not-stopped'|'turn-timeout'|'pelvic'|'edging', atMs} | null,
  prompt:{key, seq} | null, manualShockReadyAtMs }
```

### 语音 key（`voices/zh/<key>.mp3`、`voices/en/<key>.mp3`，按 locale 选）
`calib_start` `calib_done` `cmd_forward` `cmd_backward` `cmd_left` `cmd_right` `cmd_stop` `violation` `level_up` `level_down` `pelvic_remind` `edging_peak` `sensor_lost` `game_end`。core 只发 prompt，页面按 `prompt.seq` 变化播放，只在 host 模式播。

## 评审后修订（2026-10-27）

- 完成判定：前进/后退须至少通过一次动作判定，且松开后在 stopGraceSec 内停下才算完成；松开时还在爬判 not-stopped，不算完成。首次判定前就松开、被新指令取代或按住超时的指令为中性（不算完成也不算违规，连续完成不变）。转向转够角度才算完成；按住转向中途违规过的不算完成。服从率 = 完成 /（完成 + 违规指令数），降档只看真实完成。
- 校准：校准中方向键被忽略、页面禁用；校准中动作超过阈值（绝对值）就重新校准并重播 `calib_start`，快照带 `calibRetries`；校准中 IMU 断线则恢复后重新采满 calibSec。
- 附加规则：开局对 `sensor` 下发 100ms 上报间隔；校准后才来的压力收约 1 秒样本再定基线；快照 `addon.state` 为 off/waiting/active/no-sensor，no-sensor（校准结束 3 秒仍无压力）时页面显示「附加规则未生效：没有压力数据」。
- 寸止附加规则在压力回到 edgingMid 以下才重新武装（与 pressure-edging-v2 在临界以下即可再触发不同）。
- 暂停中方向键返回 PAUSED，手动电击仍可用。起始电压高于最高电压按最高电压算；每档增量为 0 时只有 1 档。
