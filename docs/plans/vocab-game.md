# 背单词游戏（原生版）方案

> 2026-11-01 | 决定见 `docs/adr/2026-11-01-vocab-game.md`
> 先做 PC，页面要能直接放进手机 WebView 跑。扇贝插件 `backend/plugins/shanbay-shock` 保留不动。

## 1. 分工

| 仓库 | 分支 / worktree | 做什么 |
|---|---|---|
| control-panel | `feat/vocab-game` @ `E:\smart\project\.worktrees\control-panel-vocab-game` | 游戏页面 `backend/games/vocab-game/`、词库、PC 宿主 `DeviceAPI.cloud` |
| control_panel_mobile | `feat/game-data-sync` @ `.worktree/game-data-sync`（基于 upstream/develop） | 账号后端 `packages/api` 新增游戏云存档接口。本期不做 App 侧 |

## 2. 游戏页面 `backend/games/vocab-game/`

- manifest：id `vocab-game`，标题「背单词」/ "Vocabulary"，版本 1.1.0，**不设** `runtime: host`。写法、bridge/i18n 引入方式照抄 `reading-game`。
- 文件：`index.html`、`vocab-core.js`（纯逻辑，不碰 DOM/网络，Node 可 require 单测）、`voice.js`（麦克风、VAD、切片识别；采集链路从 `reading-game/reading-core.js` 复制 `VoiceDetector`、`PcmRingBuffer`、重采样、WAV 编码）、`game.js`（编排与界面）、`i18n.js`（中文当 key）、`banks/<id>.js`（词库）。
- 设备：`shock`（必需，能力 `shock`），`lock`（可选，`required:false`，label「自动锁」/ "Auto lock"，写法照抄 `pushup-detection`）。电击调用方式与 `reading-game` 一致。

### 2.1 参数与设置（1.1.0 改版：类似扇贝单词）

**宿主配置页（manifest params）只留设备和电击相关**：设备映射、`shockVoltage`（15）、`shockDuration`（2）、`totalTime`（60 分钟，0 = 不限，跟锁相关属安全限制）、`autoStart`「自动进入本日学习」（bool，默认关）。

**自动进入本日学习**：勾选且云存档里已有学习记录（学过任意词）时，加载完同步后跳过首页直接进学习页（照常上锁）；今日任务已完成则停在首页。语音模式下若麦克风/AudioContext 因无用户手势起不来，显示一个全屏「点一下开始」遮罩，不要静默失败。未登录、同步失败需要用户选择时也停在首页。

**学习设置挪进游戏内「设置」页**，存进云存档 `settings`（带 `u`，合并取新的），PC/手机共用：

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `bank` | `gaokao`/`cet4`/`cet6`/`ielts` | `cet4` | 当前词书，在「更换词书」页选 |
| `newPerDay` | 0–200 | 20 | 每日新词数 |
| `reviewCap` | 0–500 | 100 | 每日复习上限；超出顺延，到期最早的先出 |
| `questionTime` | 0–120 | 20 | 每题限时（秒，0 = 不限），超时算答错 |
| `inputMode` | `touch`/`voice` | `voice` | 默认语音，可切换点选；语音模式也能点 |
| `autoSpeak` | bool | true | 出题时朗读单词 |
| `punishUnknown` | bool | true | 点「不认识」也电击 |

**电击强度/时长两边都能改，以最后改的为准**：游戏内改的只存本机（localStorage，不进云存档，因为每台机器接的设备不同），同时记下当时宿主传入的值；下次启动若宿主值没变就用游戏内的值，宿主值变了（用户在配置页改过）就用宿主值并清掉本机覆盖。游戏内的范围同 manifest。

### 2.1.1 页面结构

- **首页**（加载后默认）：
  - 今日任务卡（最醒目）：新词 x/N、复习 y/M 两个进度，大按钮「开始学习」/「继续学习」（今天已答过题时）；完成后显示「今日已完成」和「再学一组」。
  - 当前词书卡：词书名、「已学 a / 总 b」进度条、「更换词书」。
  - 小统计行：今日首答正确率、明日待复习、累计已学词数。
  - 右上角齿轮进「设置」；未登录时首页显示提示，按钮禁用。
- **更换词书页**：4 本词书卡片（名称、词数、自己的已学进度），点选即切换并回首页。
- **设置页**：上表各项 + 电击强度/时长；改完即保存。
- **学习页**：即原答题界面；顶部左侧「返回首页」（中途返回不算失败，进度保留，已上锁的保持上锁）。今日任务完成后回首页。
- 当天中途换词书或改每日新词数：已答过的词不变，今日计划里还没答过的新词按新设置重新补齐/裁掉；复习词不动。

### 2.2 一题的流程

1. 显示单词、音标；`autoSpeak` 时用 `speechSynthesis` 读一遍（不可用就静默）。下面 4 个中文释义，外加「不认识」按钮。
2. 干扰项从同一词库里抽，优先和正确答案首个词性相同；释义文本不能和正确答案相同或互相包含；4 个选项位置随机。
3. 倒计时 `questionTime` 秒。
4. **选对**：正确项高亮约 0.6 秒，自动进下一题。
5. **选错 / 超时 / 不认识**：
   - 电击一次（不认识且 `punishUnknown=false` 时不电）；
   - 显示正确答案（高亮正确项、音标、完整释义），选错的那项标红；
   - 停止答题倒计时，正确答案显示 10 秒后自动下一题；期间可以点「继续」（语音模式也可以说「继续」）提前进入；后台暂停期间不计时。
   - 这个词**排到今日队列队尾**，必须在今天答对一次才算过。

### 2.3 每日任务与复习间隔

- 换日时间：本地 04:00。
- 每日计划在当天第一次打开时生成并存进云存档，PC/手机共用：
  - 复习词：到期（`due <= today`）的旧词，按到期日从早到晚，最多 `reviewCap` 个。
  - 新词：当前词库里从没学过的词（不论在哪个词库学过）按词库顺序取 `newPerDay` 个。
  - 复习和新词混在一起打乱出题，新词先不集中扎堆即可。
- 今日任务完成 = 计划里每个词今天都答对过一次。完成后解锁（若有锁），显示完成页，可以点「再学一组」（再加 `newPerDay` 个新词，不再上锁）。
- 每个词记录 `k`（连续首答对次数）。**只看今天第一次作答**：
  - 首答对：`k += 1`，下次到期 = 今天 + 2^(k−1) 天（1、2、4、8、16、32、64……一直翻倍，不设上限）。
  - 首答错：`k = 0`，下次到期 = 明天。
  - 同一天里后续再出现时，对错不再改 `k`。

### 2.4 语音模式

- 开始时（用户手势里）申请麦克风；采集、VAD、切片沿用朗读游戏，识别用 `DeviceAPI.speech.transcribe`（本地 SenseVoice 优先）。
- 识别文本映射（纯函数 `parseVoiceCommand`，放 `vocab-core.js`，带单测）：
  - 选项：「第一个/第一/一个/一号/1/A」等 → 1，二/三/四同理；收录常见同音误识别（如 一：衣、医；二：儿、而；三：山、伞；四：寺、似）。单独一个「是」不当成四。
  - 「不认识/不会/不知道」→ 不认识；「继续/下一个/下一题」→ 继续。
  - 识别出多个选项或认不出：忽略，界面提示「没听清」。
- 朗读单词时，或者朗读刚结束 0.5 秒内录到的音频直接丢掉，防止识别到自己的发音。
- `DeviceAPI.speech` 不可用：提示「语音识别不可用」，退回点选。

### 2.5 自动锁与结束

- 点「开始/继续学习」且今日任务未完成时 `setOpen(false)`；今日已完成或「再学一组」时不上锁。
- 以下情况都 `setOpen(true)`：今日任务完成、`totalTime` 到时、用户结束、紧急停止、`pagehide`/`beforeunload`、开始失败。没映射跳过，失败只记日志。
- `totalTime` 从开始答题起算，到时结束，进度照常保存。
- 页面被打断（`visibilitychange` hidden、`pagehide`）：暂停倒计时，立即停止电击；回来继续。

## 3. 词库

- 来源 ECDICT（https://github.com/skywind3000/ECDICT ，MIT）。按 `tag` 字段取 `gk`（高考）、`cet4`、`cet6`、`ielts`，生成 4 个文件。生成脚本放 `tools/vocab-bank/`，原始 csv 不进仓库。
- 文件格式（不用 fetch，手机 file:// 不可靠）：
  ```js
  window.VG_BANKS = window.VG_BANKS || {};
  window.VG_BANKS.cet4 = { name: '四级', count: N, words: [[word, phonetic, meaning], ...] };
  ```
- `meaning`：从 `translation` 取，去掉 `[网络]`、`[医]` 这类专业标注行，最多保留前 2 个词性、总长不超过 24 字，供选项显示；完整释义另存一个字段供答错时显示（不超过 80 字）。没有中文释义的词丢掉。
- 顺序：按 `frq`/`bnc` 词频从常用到不常用；词频为 0 的放最后。
- 词的唯一 id 用小写原词，跨词库共用一份进度。

## 4. 云存档

### 4.1 账号后端接口（control_panel_mobile `packages/api`）

- 表 `game_data`：`user_id`、`game_id`、`data jsonb`、`version int`、`updated_at`，主键 `(user_id, game_id)`；drizzle 迁移。
- `GET /me/game-data/:gameId` → `200 { data, version, updatedAt }`；没有记录时 `200 { data: null, version: 0 }`。
- `PUT /me/game-data/:gameId`，body `{ data, baseVersion }`：
  - `baseVersion` 等于当前版本才写入，版本 +1，返回 `200 { version, updatedAt }`；
  - 否则 `409 { code: 'VERSION_CONFLICT', data, version }`（带回当前内容，客户端合并后重试）。
- `gameId` 只允许 `^[a-z0-9-]{1,64}$`；`data` 序列化后不超过 1MB，超了 413。需要登录（复用 `authMiddleware`）。
- 用内存 PGlite 写测试，风格照现有 `tests/`。**部署到生产要先问用户。**

### 4.2 PC 宿主 `DeviceAPI.cloud`

```js
DeviceAPI.cloud                       // 宿主不支持时 undefined
DeviceAPI.cloud.status()              // → { signedIn: boolean, user?: { id, nickname } }
DeviceAPI.cloud.get()                 // → { data, version, updatedAt }
DeviceAPI.cloud.put(data, baseVersion)
                                      // → { version, updatedAt }
                                      // 冲突 reject Error code VERSION_CONFLICT，err.remote = { data, version }
                                      // 其他错误 code：NOT_SIGNED_IN | NETWORK | TOO_LARGE | UPSTREAM_<status>
```

- 消息层 `sendRequest({ action: 'cloudStatus' | 'cloudGet' | 'cloudPut', ... })`，照 `speech` 的写法加进 `backend/public/device-api-bridge.js` 和 `bridgeService.js`。
- **`gameId` 由宿主按当前会话的游戏决定，页面传不进来**，防止一个游戏读写别的游戏的存档。
- token 取 `localSessionService.get()`，地址取 `accountService.getBaseUrl()`（`ACCOUNT_API_URL` 可覆盖，方便测试指向本地 API）。上游 401 → `NOT_SIGNED_IN`。不打印 token。

### 4.3 游戏侧同步

- **必须登录**：`cloud` 不存在或 `status().signedIn=false` 时不能开始，提示「请先在客户端登录账号」。
- 存档结构（`vocab-core.js` 里的纯函数负责合并）：
  ```js
  { v: 1,
    words: { "<word>": { k, due, last, wrong, u } },   // due/last 为日期序号；u = 修改时间 ms
    plans: { "<YYYY-MM-DD>": { bank, ids: [...], done: [...], extra: n, u } },  // 只保留最近 7 天
    settings: { bank, newPerDay, reviewCap, questionTime, inputMode, autoSpeak, punishUnknown, u } }
  ```
- 合并规则：`words` 每个词取 `u` 大的；同一天的 `plans` 取 `ids` 并集（保持先到的顺序）、`done` 并集；`settings` 整份取 `u` 大的。旧存档没有 `settings` 时用默认值，1.0.x 的 params 不迁移。
- 时机：开始前 `get` 并和本机缓存（localStorage，按用户 id 分开）合并；每答完 10 题或 30 秒、今日完成、结束、`pagehide` 时 `put`。冲突就用 `err.remote` 合并后重试，最多 3 次。
- 开始时网络失败：可以选「离线继续」，用本机缓存玩，下次联网再合并上传。界面角标显示同步状态。

## 5. 测试

1. **单元测试**（后端 Jest，放 `backend/tests/vocabGame*.test.js`）：干扰项规则、每日计划生成（复习上限、跨词库去重、04:00 换日）、间隔翻倍与答错重置、同一天重复出现不改 `k`、错题回队尾、今日完成判定、存档合并、`parseVoiceCommand`、`DeviceAPI.cloud` 的 bridge 动作（模拟上游，包括 409、401、gameId 不能伪造）。
2. **API 测试**：`packages/api` 下 `bun test` 全过，新增接口覆盖读空、写入、版本冲突、超大、未登录、非法 gameId。
3. **PC 端到端**：CDP 驱动 Electron，虚拟电击设备 + 虚拟锁，`ACCOUNT_API_URL` 指向本地起的 API。截图：配置页、答题、答错显示答案、语音模式（用测试音频注入，参数名 `vgTestAudio`，照 `rgTestAudio`）、今日完成解锁、360×780 竖屏。另验证两个「设备」（两个 localStorage 目录）登录同一账号时进度互通。
4. 报告放 `tmp/vocab-game/report.md`，截图嵌入。

## 6. 本期不做

- 手机 App 侧的 `DeviceAPI.cloud`（页面已兼容，App 接入另开分支）。
- 远程会话。
- 生产部署 API（做完问用户）。
