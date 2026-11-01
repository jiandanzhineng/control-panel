# 朗读游戏迁移方案（electron-client → control-panel，含手机端）

> 2026-10-30 | 决定见 `docs/adr/2026-10-30-reading-game.md`、`2026-10-30-siliconflow-stt.md`
> 原版：`E:\develop\electron-client` 分支 `feat/reading-game`（提交 0e72af1）
> - 代码：`outter-game/reading-game/reading-game.js`
> - 原方案与实现偏差：`docs/plans/reading-game.md` 第 11 节，这是判定规则的唯一依据

## 1. 原则

- **只改运行方式，不改玩法**（ADR 2026-10-01）：对齐、VAD、T1/T2、结尾确认、警告、冷却、电击限频这些规则逐条照搬原版。
- **真在读的人不被电**。语音识别失败、超时或不可用时，只能少电，不能多电。
- 一个页面同时在 PC（Electron iframe）和手机（Flutter WebView）上跑，两边宿主提供同样形状的 `DeviceAPI`。

## 2. 三个仓库的分工

| 仓库 | 分支 / worktree | 做什么 |
|---|---|---|
| mimo-relay | `feat/siliconflow-stt`（就在主目录） | 新增 `POST /v1/audio/transcriptions`，转发到 SiliconFlow |
| control-panel | `feat/reading-game` @ `E:\smart\project\.worktrees\control-panel-reading-game` | 游戏页面 `backend/games/reading-game/`；后端语音识别服务与 bridge 动作；设置页 SiliconFlow key |
| control_panel_mobile | `feat/reading-game` @ `.worktree/reading-game`（基于 upstream/develop） | bridge 加语音识别动作；App 设置 SiliconFlow key；内置游戏资源；WebView 麦克风 |

## 3. 接口约定（各端必须一致）

### 3.1 中转端点（mimo-relay）

`POST https://mqtt.undersilicon.cn:8790/v1/audio/transcriptions`

- 请求：`Authorization: Bearer <账号 JWT>`；`multipart/form-data`，字段 `file`（WAV）和 `model`（可省略）。格式和 SiliconFlow 官方接口完全一样，所以客户端在中转和直连之间只需要换 base URL 和 Authorization。
- 中转固定转给 `https://api.siliconflow.cn/v1/audio/transcriptions`，`model=FunAudioLLM/SenseVoiceSmall`，只允许这一个模型，其他模型返回 403 `MODEL_NOT_ALLOWED`。key 从环境变量 `SILICONFLOW_API_KEY` 读。
- 限制：
  - 单个文件不超过 1MB，超了返回 413。
  - 每个账号每分钟最多 40 次，超了返回 429 `RATE_LIMITED`（内存计数即可）。
  - 上游超时 20 秒，返回 504。
- 上游返回 401/403 时，中转返回 502 `UPSTREAM_AUTH_FAILED`（这是密钥失效，不是用户没登录）。其他情况把状态码和 JSON 原样转回，成功时是 `{ "text": "..." }`。
- `/health` 增加 `stt: { provider: 'siliconflow', keyConfigured }`。

### 3.2 游戏页可用的 DeviceAPI 语音接口（PC 和手机都要实现）

```js
DeviceAPI.speech            // 宿主不支持时是 undefined（比如旧版手机 App），游戏必须能降级
DeviceAPI.speech.status()   // → Promise<{ ready: boolean, mode: 'local'|'own_key'|'relay'|'none', reason?: string }>
DeviceAPI.speech.transcribe({ audio, format: 'wav', timeoutMs })
                            // audio 是 16kHz 单声道 WAV 的 base64（不带 data: 前缀）
                            // → Promise<{ text: string, mode: 'local'|'own_key'|'relay', latencyMs: number, fallback?: boolean }>
                            // 失败时 reject Error，带 code：NOT_SIGNED_IN | NO_STT | NO_LOCAL | TIMEOUT
                            //   | RATE_LIMITED | UPSTREAM_* | BAD_AUDIO | WORKER_* | LOCAL_INFERENCE_FAILED
```

- 本地优先：游戏声明 `models: [{ task: 'asr', id: 'sense-voice-small-int8' }]` 并下载就绪后，`status()` 返回 `mode: 'local'`，`transcribe()` 先走本机模型；本地不可用、加载失败或推理失败时自动回退云端，回退结果带 `fallback: true` 和云端 `mode`。

- 消息层：`sendRequest({ action: 'speechStatus' })`、`sendRequest({ action: 'speechToText', audio, format, timeoutMs })`。
- 宿主把 `timeoutMs` 限制在 3000–20000 之间（默认 10000），超时要真正中止上游请求。
- 单次 `audio` 解码后超过 1MB，返回 `BAD_AUDIO`。
- **选择通道**：
  - 用户填了自己的 SiliconFlow key：直连 `https://api.siliconflow.cn/v1/audio/transcriptions`，`Bearer <key>`，mode 为 `own_key`。
  - 没填：走中转，用账号 JWT，mode 为 `relay`。没登录时返回 `NOT_SIGNED_IN`。
- 不打印、不回传 key 和 JWT；日志里只记 mode、耗时、状态码。

### 3.3 设置项

- **PC**：`voiceSettingsService` 新增 `siliconflow_api_key`。
  - `status()` 增加 `has_sf_key`、`sf_key_masked`、`stt_mode`。
  - `POST /api/voice/settings` 接受 `siliconflow_api_key`，传空字符串表示清除。
  - 「设置 → 语音服务」加一个「SiliconFlow key（语音识别，可选）」输入框，说明：不填就用官方中转，需要先登录。
  - 和 MiMo 的通道设置相互独立。
- **手机**：在 App 已有的设置里（没有就放在游戏相关设置里）加同一个输入框。key 存本机安全存储，说明文案和 PC 一致。

## 4. 游戏页面 `backend/games/reading-game/`

| 文件 | 内容 |
|---|---|
| `index.html` | manifest（id `reading-game`，版本以第 7 节为准（1.1.2），**不设** `runtime: host`）、界面骨架；按其他内置页面游戏的方式引入 bridge、i18n |
| `reading-core.js` | 纯逻辑，不碰 DOM 和网络：`ReadingAligner`、`ReadingTriggerMachine`、`VoiceDetector`、`PcmRingBuffer`、重采样、WAV 编码、模糊音归一。从原版原样搬过来，Node 里可以直接 require 来单测 |
| `pinyin.js` | 页面内把汉字转成拼音并记录字下标，替代原版主进程的 IPC `text-to-pinyin`，下标规则沿用原版 `services/pinyinService.js`（按 origin.length 累加） |
| `vendor/pinyin-pro.min.js` | pinyin-pro 的 UMD 构建（MIT，文件头保留许可证）。手机上不能依赖 npm |
| `texts.js` | 内置文本，用 `window.RG_TEXTS = [...]` 的形式，不用 fetch 读 JSON（手机上 file:// 读取不可靠） |
| `game.js` | 编排：麦克风采集、切片上传识别、状态机驱动、电击、界面。逻辑照搬原版 `ReadingGame` 类，只替换输入输出 |
| `i18n.js` | 界面文案中英（中文当 key，ADR 2026-09-04）；朗读文本本身只有中文 |

替换对照：

| 原版 | 迁移后 |
|---|---|
| `invoke('game-speech-to-text')` | `DeviceAPI.speech.transcribe` |
| IPC `text-to-pinyin` | 页面内 `pinyin.js` |
| `setDeviceProperty({voltage, shock:1})` / `{shock:0}` | `DeviceAPI.device('shock').invoke('shock','start'/'stop', …)`，参数以 `docs/device/capabilities.md` 为准 |
| `gameplayUI.updateUI(html)` | 页面自己的 DOM，首次渲染骨架，之后按 id 局部更新 |
| 主进程看门狗、before-quit 冲刷 | 宿主侧：页面断开/关闭时宿主复位设备（PC bridge 会话、手机 game session 都要确认） |

### 4.1 手机兼容要点

- **开始前必须点一次按钮**：在点击回调里调用 `getUserMedia` 和 `AudioContext.resume()`，iOS 和 Android WebView 都要求用户手势。
- **采样率不能假设**：`AudioContext` 用默认采样率，统一重采样到 16kHz。优先用 AudioWorklet（代码通过 Blob URL 加载），失败时退回 ScriptProcessorNode。
- **页面被打断要暂停**：`visibilitychange` 变成 hidden、`pagehide`、AudioContext 进入 `suspended`/`interrupted`（来电、切后台）、音轨 `ended`/`mute`，都要暂停判定并立即发停止电击。恢复后重新校准，计时重置。
- **防息屏**：有 `navigator.wakeLock` 时申请屏幕常亮；没有就在界面上提示别锁屏。
- **布局**：竖屏 360px 宽能完整操作。提词器字号不小于 20px。状态栏压缩成两行。紧急停止按钮固定在底部，大小不小于 48px，避开安全区。
- **没有语音识别时降级**：`DeviceAPI.speech` 不存在或 `status().ready=false` 时，显示「语音识别不可用，仅检测是否出声」，只保留 T1，结尾按原版"未能确认结尾"的路径处理。
- **测试注入**：URL 带 `rgTestAudio=<同目录相对路径或 http URL>` 时，用该音频文件代替麦克风（解码后按实时节奏喂给同一条采集链路）。只用于自动化测试，界面标「测试音频」。

## 5. 测试

1. **单元测试**：把原版 `test/reading-game/unit.js` 的 58 项搬过来，接入后端 Jest（或仓库已有的游戏测试方式），对象换成 `reading-core.js` 和 `game.js` 的编排逻辑。全部通过，数量不能少。
2. **真实识别回放**：用原版 `tmp/reading-game/audio/` 下的 a–h、h2 场景音频，分别走①本地起的 mimo-relay 中转、②自备 key 直连两条链路，结果要和原版一致（a/b/c/f 不电并通关；d 警告 2 秒后电 1 次；e 不误电；h 未确认完成、不电；h2 中途停下被电）。
3. **PC 端到端**：用 CDP 驱动 Electron（不用 Computer Use），挂虚拟电击设备，配合 `rgTestAudio` 测试注入，配置页 → 运行 → 通关/被电/紧急停止全流程截图；另用 360×780 视口截竖屏图。
4. **手机端到端**：Android 模拟器 + Mock 设备，从内置游戏进入，用 `rgTestAudio` 跑 a、d 两个场景；验证麦克风权限弹窗、切后台暂停、退出停止电击，并截图。
5. 报告放 `tmp/reading-game/report.md`，截图嵌入文档。

## 6. 已知限制

- 远程会话（被控端在另一台设备）首版不支持，因为麦克风在执行端。
- iOS 只做代码层面的兼容（AudioWorklet 回退、手势、采样率），没有真机验证。

## 7. 反复朗读与背诵玩法（2026-10-31，版本 1.1.0，先只做 PC；1.1.1 起背诵第 1 级不遮字、页面加载后自动开始；1.1.2 起支持声明并优先使用本地模型）

> 决定见 `docs/adr/2026-10-31-reading-game-recite.md`。本节修订第 1 节"不改玩法"。

### 7.1 新参数（manifest + game.js 默认值 + en 文案，都要同步）

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | enum `read`/`recite` | `read` | 玩法：朗读 / 背诵（enumLabels 中英） |
| `passes` | number 1–50 | 1 | 朗读遍数。只对朗读玩法生效；1 遍就是原来的单次朗读 |
| `restSeconds` | number 0–300 | 20 | 两遍之间的休息秒数 |
| `passRate` | number 50–100 | 85 | 背诵过关正确率（%） |
| `maskStart` | number 0–100 | 10 | 背诵第一级遮字比例（%） |
| `maskStep` | number 5–100 | 10 | 背诵每级增加的遮字比例（%），封顶 100 |
| `hintChars` | number 0–30 | 8 | 卡壳被电后，当前位置后面还原成文字的字数 |
| `silenceBonus` | number 0–10 | 2 | 背诵每级多给的停顿秒数（加在 `silenceLimit` 上） |
| `totalTime` | 已有 | 改为 60 | 文案改成「游戏时间上限」（分钟，0 = 不限），到时结束并解锁 |

设备里新增可选的 `lock`（能力 `lock`，`required:false`，label 「自动锁」/ "Auto lock"），写法照抄 `pushup-detection`。

### 7.2 一遍（pass）的生命周期

- 每遍从位置 0 开始：重置 `aligner` 位置、`trigger.reset(now)`、本遍统计、结尾确认状态。
- **不重新申请麦克风，也不重新校准。**
- 每遍有一个 `passId`。识别请求发出时带上 `passId`，结果回来时如果 `passId` 已经变了，就直接丢弃，防止上一遍的结果串到下一遍。
- 现在调用 `finishWin()` / `_finishIncomplete()` 的地方，改成调用 `_onPassDone(kind)`，其中 `kind` 是 `'won'` 或 `'unconfirmed'`。
  - **朗读玩法**：已完成遍数加 1。达到 `passes` 就真正通关，否则进入休息。
  - **背诵玩法**：
    - 正确率 ≥ `passRate`：当前级是 100% 就通关；否则升一级，再进入休息。
    - 正确率不够：留在本级，进入休息后重读。
- **休息**（`phase = 'rest'`）：
  - 调用 `trigger.setPaused`，不切片、不上传、不电击，音频链路保持开着。
  - 界面显示倒计时、上一遍的正确率和结果（过关/未过关/升到第几级），以及下一遍的遮字比例。
  - `restSeconds = 0` 时直接开始下一遍。
  - 休息结束后开始下一遍，开头仍有 `startGrace` 宽限。
- **测试音频（`rgTestAudio`）**：每遍开始时从头重新播放，这样能自动化测试多遍。
- **游戏时间上限**：从开始那一刻起算，休息时间也算在内；到时调用 `end()`。

### 7.3 正确率

- 每遍维护一个集合 `matched`，记录被确认读到的原文音节下标（绝对下标）。
  - 每个被采纳的 `reading` 结果里，`sim ≥ 0.65` 的配对都计入，绝对下标 = 窗口起点 + `srcIndex`。为此 `align()` 的结果要多返回一个 `windowStart`。
  - 只计入下标小于采纳后位置的配对。
- 正确率 = `matched.size / 分母`。
  - 分母 = 总音节数 −（总音节数 − 结束时位置），后面这一项最多减 `TAIL_ESTIMATE_SLACK` 个。
  - 这样识别没能确认的结尾不会把正确率拉低，读错和跳过的字照样算错。
- 纯函数放进 `reading-core.js`，便于单测。

### 7.4 遮字（背诵）

- 第 1 级不遮字（通读）；第 k 级（k ≥ 2）的遮字比例 = `min(100, maskStart + (k−2)·maskStep)`（1.1.1 起）。
- 只遮汉字，标点和空白不遮。遮的个数 = round(比例 × 汉字数)；比例大于 0 时至少遮 1 个。
- **每一遍都重新选。** 记录每个字最近一次被遮是第几遍，从没遮过或最久没遮过的字优先，同一档内随机。这样上一遍遮过的字，这一遍尽量不再遮。选字函数是纯函数，可以注入随机数。
- **显示**：
  - 被遮的字显示成同宽的黑方块 `■`，DOM 里不能出现原字。
  - 读过去以后，这个字还原成原字，用淡色显示。
  - 卡壳提示还原出来的字用琥珀色。
- **卡壳提示**：背诵玩法下每次真的电击（`doShock`）后，从当前位置对应的字开始，往后 `hintChars` 个被遮的字在本遍内还原。
- **停顿放宽**：每遍开始时把 trigger 的 `silenceLimit` 设为 `config.silenceLimit + k·silenceBonus`，朗读玩法里 k 取 0。1.1.1 起改为 `(k−1)·silenceBonus`，第 1 级不加。

### 7.4.1 正确率不足电击（1.1.3）

- 参数 `lowAccuracyShock`，默认开启。两种玩法都适用，阈值用 `passRate`。
- 时机：一遍结束、进入休息之前，在 `_onPassDone` 里电一次，原因记为 `ACC`。如果是最后一遍，等电击结束后再结算。
- 以下情况本遍不电：
  - 结尾没能确认（`unconfirmed`）；
  - 本遍出过识别错误或超时；
  - 本遍识别变慢过；
  - 识别降级或不可用。

### 7.5 顺着读（两种玩法都适用）

- **跳得远**：采纳结果时，如果第一个强匹配的位置比当前位置超前 12 个音节以上，先不推进，记为"待定跳转"（`pendingJump`，记录链的起止位置）。
  - 这条结果不计入 T2 的坏段，避免因此误电。
  - 下一条 `reading` 结果如果仍落在这个跳转位置附近或更后面（链起点 ≥ 待定链起点 − 4），就承认跳转。两条结果的匹配都计入 `matched`，被跳过的字不计入。
  - 下一条结果如果回到了当前位置附近，就清掉待定跳转。
- **跳得近**：12 个音节以内的小跳照常推进。被跳过的字不计入 `matched`，只拉低正确率。这样个别字识别不出来不会卡住，乱跳会因为正确率不够而过不了关。
- 窗口大小（后 30、前 60）不变。

### 7.6 自动锁

- 开始游戏、麦克风就绪后调用 `setOpen(false)`。
- 以下情况都调用 `setOpen(true)`：通关、`end()`、紧急停止、超时、`pagehide`/`beforeunload`、开始失败。
- 设备没映射时跳过。发送失败只记日志，不影响游戏。重复解锁没关系。

### 7.7 测试

- **单测**：
  - 选字：比例、只遮汉字、尽量不重复遮、100% 全遮。
  - 正确率：分母扣掉结尾、跳过的字不算。
  - 待定跳转：一次不推进，连续两次推进；回到原位后清除。
  - 多遍流程：朗读 2 遍；背诵升级、留级和通关；旧 `passId` 的结果被丢弃；休息期间不电。
  - 锁：开始上锁，各种结束路径都会解锁。
- **原有单测全部保留并通过**，后端全量 Jest 测试不能有新增失败。
- **端到端（CDP + `rgTestAudio`）**：
  - 朗读 2 遍、休息 3 秒，能通关。
  - 背诵用大步长，比如起始 50%、每级 50%，能升级到通关。
  - 截图：遮字画面、休息倒计时、通关画面，以及 360 宽的竖屏图。
