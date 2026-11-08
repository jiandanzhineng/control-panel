# 游戏配置参数精简（PC + 手机）

用户反馈「参数有点多」。目标：每个游戏默认展开的参数 ≤ 6 个，且每个参数都有看得懂的说明。

## 一、manifest 新字段（两端都要支持）

| 字段 | 含义 |
|---|---|
| `hidden: true` | 配置页（基础/高级/远程面板）都不显示；启动时该参数一律用 `default`，忽略保存过的旧值。用于纯工程参数。 |
| `visibleWhen: { "key": "<另一参数>", "equals": 值或数组 }` | 只有当另一参数等于该值（数组表示「属于其中之一」）时才显示 |
| `visibleWhen: { "key": "<另一参数>", "gt": 数字 }` | 只有当另一参数 > 该数字时才显示 |

- 被 `visibleWhen` 隐藏的参数照常保留当前值、照常下发（游戏逻辑本来就不用它）。
- 已有规则不变：基础 = `required !== false && group !== 'advanced'`，其余进折叠的「高级设置」；参数绑定的 `device` 是可选设备且未映射时隐藏。
- `recommended` 已存在，两端都显示为「推荐 X」。

## 二、手机端补齐 PC 已有的显示

1. 参数下方灰色小字显示 `description`，再一行「推荐 X · 默认 Y」（有哪个显示哪个）；开关类放 subtitle。
2. 配置页顶部可折叠「玩法说明」卡片，内容为 `howTo`（随 i18n）。
3. 可选设备未映射时隐藏绑定该设备的参数（规则同 PC `PlayConfigView.vue` schemaEntries）。
4. 支持 `hidden`、`visibleWhen`、`recommended`（含 i18n 覆盖时仍正常）。

## 三、各游戏改动（改 PC 源，递增游戏版本，再同步手机）

记法：B=基础，A=高级（`group:"advanced"` 或 `required:false`），H=hidden。未列出的参数不变。

### pressure-edging 气压寸止
- B：duration, criticalPressure, maxMotorIntensity, shockVoltage, voiceEnabled
- 改为 A：lowPressureDelay, sensitivity, shockDuration（rampRate/gradualIncrease/randomPercent 已是 A）

### pressure-edging-v2 寸止升级版
- B：duration, endCalmLock, criticalPressure, midPressure, maxMotorIntensity, shockVoltage, voiceEnabled
- 改为 A：lowPressureDelay, sensitivity, shockDuration
- 文案：sensitivity →「压力变化对强度调节的影响系数，越大反应越灵敏」（删掉「本版默认 15…」开发备注）；maxMotorIntensity →「刺激强度上限（1–255）。男用 TD 超过 50 可能断联，请谨慎」。默认值不改。

### surge-edging 气压突变寸止
- B：duration, endCalmLock, surgeRiseKpa, maxMotorIntensity, shockVoltage, voiceEnabled
- 改为 A：midOffsetKpa, lowPressureDelay, gradualIncrease, midIntensityMin, midIntensityMax, shockDuration
- H：minSurgeMs
- 文案改白话（去掉 τ、dmin、P1+ΔP 等公式）：
  - surgeRiseKpa：气压在短时间内突然升高超过这个值，就判定为接近边缘并立即停止刺激。越小越灵敏
  - surgeWindowSec：在多长时间内比较气压的升高幅度。窗口越长，缓慢的升高也会被当成突变，越灵敏
  - midOffsetKpa：每次边缘后，把「兴奋阶段」门槛设为这次峰值减去该值，越大越早进入兴奋阶段
  - lowPressureDelay：每次边缘后完全停止刺激的时长
  - gradualIncrease：平静阶段强度每秒最多上升多少
  - midIntensityMax：刚进入兴奋阶段时的强度，压力越高逐渐降到下限。须在 10 到 TD01 最大强度之间，否则自动取 20（不超过最大强度）
  - midIntensityMin：兴奋阶段压力越高强度越低，最低降到这个值
  - midDelay：进入兴奋阶段后至少保持多少秒，避免语音来回切换
  - sendIntervalMs：多久给 TD01 发一次强度。设备响应有延迟时可调大；边缘时的停止命令会立即发送
  - maxMotorIntensity：刺激强度上限（1–255）。男用 TD 超过 50 可能断联，请谨慎
- 同步改 `backend/game-runtime/cores/surge-edging-manifest.js` 与 index.html 内联 manifest，保持一致。

### maid-punishment 女仆偷懒惩罚
- maxIntensityIncrease：`visibleWhen {key:progressiveIntensity, equals:true}`
- H：tiptoeDebounceMs
- shockDurationSeconds 文案：每次电击持续的时间（最长 10 秒）

### pushup-detection 俯卧撑
- B：duration, targetCount, downThreshold, upThreshold, idleTimeLimit, shockIntensity, rewardTriggerCount, vibratorIntensity, enableVoice（后三个随可选设备隐藏）
- 改为 A：shockDuration, vibratorDuration

### drink-pee-unlock 喝水/液体收集解锁
- B：mode, durationSec, targetWeight, pressureThreshold, shockIntensity, voiceEnabled
- 改为 A：punishCooldownSec, shockDuration
- H：stableWindowSec, tiptoeDebounceMs

### reading-game 朗读
- B：customText, mode, passes, passRate, silenceLimit, shockIntensity
- 改为 A：restSeconds, lowAccuracyShock
- `visibleWhen {key:mode, equals:"read"}`：passes
- `visibleWhen {key:mode, equals:"recite"}`：maskStart, maskStep, hintChars, silenceBonus
- `visibleWhen {key:shockStep, gt:0}`：shockMax
- H：segmentLen, segmentHop, sttTimeout

### pelvic-training / vocab-game
不改 manifest（设备隐藏后已足够少）。

## 四、i18n

改了中文 description 的参数，manifest `i18n.en.paramDescriptions` 同步改英文。

## 五、预期效果（只映射必需设备时默认展开数）

| 游戏 | 改前（手机） | 改后 |
|---|---|---|
| 俯卧撑 | 11 | 6 |
| 突变寸止 | 12 | 5 |
| 升级版寸止 | 10 | 6 |
| 气压寸止 | 8 | 4 |
| 喝水解锁 | 8 | 4 |
| 朗读 | 8 | 6（背诵 5） |
