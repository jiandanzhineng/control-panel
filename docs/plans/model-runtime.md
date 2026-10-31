# PC 端本地语音识别方案

> 2026-10-31。决定见 `docs/adr/2026-10-31-local-stt.md`；实测数据见 `tmp/asr-compare/report.md`。现有识别通道见 `docs/plans/reading-game.md` 第 3 节。

## 1. 目标

- 游戏页面调用 `DeviceAPI.speech.transcribe` 的方式不变，后端 `sttService` 多一个 `local` 通道。
- 通道优先级：本地 → 自备 SiliconFlow key（`own_key`）→ 官方中转（`relay`）。
- 本地可用需要同时满足三个条件：用户已开启、模型已下载并校验通过、子进程健康。
- 本地失败（出错、超时、子进程崩溃）时，这一次请求立即改走云端（如果云端可用），日志里记 `fallback=1`。
- 连续失败 3 次后，本地标记为暂不可用，60 秒后再试。
- `speech.status()`：本地可用时返回 `ready: true, mode: 'local'`，不需要登录。
- 这样背诵玩法在没登录的情况下，也能靠本地识别开始。

## 2. 引擎

- **首选原生绑定 `sherpa-onnx-node`**（实测每段 0.35 秒）。
  - 先确认它在 Electron 自带的 Node 里能加载，也就是 `ELECTRON_RUN_AS_NODE=1` 加 `process.execPath`。
  - 再确认 electron-builder 打包后能加载：`.node` 和 DLL 需要 asarUnpack，Windows x64 平台包也要带上。
- **备选**：仓库已经依赖了 `sherpa-onnx`（WASM 版，语音开始功能在用）。如果原生方案打包走不通，就测 WASM 版跑 SenseVoice 的速度。每段 1.5 秒以内可以接受，并在报告里写明。
- **必须在独立子进程里运行。**
  - 原因：后端跑在 Electron 主进程里，同步推理会卡住界面；原生崩溃也不能带垮主程序。
  - 子进程用 `process.execPath` 加 `ELECTRON_RUN_AS_NODE=1` 启动；开发时后端如果是普通 node，就用 `process.execPath` 直接起。
  - 通信用 IPC 发 JSON，请求串行排队。
- **子进程生命周期：**
  - 懒启动。游戏调用 `speech.status()` 时，如果本地可用就预热（冷启动约 2 秒）。
  - 空闲 10 分钟后退出，释放约 400MB 内存。
  - 崩溃后下次请求时再拉起。
- **推理线程数**：`numThreads = min(4, max(1, floor(cpu核数/2)))`。

## 3. 模型

- `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` 的 int8 版，只需要两个文件：

  | 文件 | 字节 | sha256 |
  |---|---|---|
  | `model.int8.onnx` | 239233841 | `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` |
  | `tokens.txt` | 315894 | `f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc` |

- **存放位置**：后端数据目录下的 `models/sense-voice-int8/`，和 voice settings 同属用户数据，跟着 `BACKEND_DATA_DIR` 走。
- **下载源**（按顺序尝试）：
  1. `https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/<文件>`
  2. `https://huggingface.co/...`（同一路径）
- **下载流程**：
  - 先写入 `.part` 文件，支持 Range 续传。下完校验 sha256，通过后再改成正式文件名；校验失败就删掉并报错。
  - 下载可以取消；删除模型时会先停掉子进程。
- **接口**：
  - `GET /api/voice/local-stt/status` 返回 `{ state: 'absent'|'downloading'|'verifying'|'ready'|'error', received, total, error, enabled, engine: 'native'|'wasm', healthy }`。
  - `POST /api/voice/local-stt/download`、`POST /api/voice/local-stt/cancel`、`DELETE /api/voice/local-stt/model`。
  - 开关字段是 `stt_local_enabled`，通过现有的 `POST /api/voice/settings` 设置；默认关闭，模型下载完成后自动打开。`status()` 里的 `stt_mode` 增加 `local`。
- **许可证**：核对 SenseVoiceSmall 模型许可证（FunASR 模型许可）和 sherpa-onnx（Apache-2.0）是否允许在产品里让用户下载使用，结论写进本文第 6 节。如果不允许，先停下来报告。

## 4. 设置页

在「设置 → 语音服务」的 SiliconFlow key 附近加一个「本地语音识别」卡片：

- 说明文案：「在本机识别，不需要联网和登录，速度更快更稳定；首次需要下载约 230MB 模型」。
- 状态：未下载、下载中（进度条，显示 MB 数，可取消）、校验中、已就绪（显示占用空间，可删除）、出错（显示原因，可重试）。
- 开关：「优先使用本地识别」。
- 文案中英文都要有，样式与现有设置卡片一致。

## 5. 测试

- **单测**：
  - 通道选择和回退：本地 → own_key → relay；本地失败时这一次改走云端；连续失败后熔断，到时间恢复。
  - 下载管理器：用本地假服务器测续传、sha256 校验失败、取消、删除。
  - 子进程通信：用假引擎测排队、超时、崩溃后重启、空闲退出。
- **集成**：
  - 用真实模型（可以直接用 `tmp/asr-compare/models/` 里已下载的）经后端 `sttService` 走本地通道，识别场景音频。
  - 用 `tmp/reading-game/replay.js` 那套方式，以本地通道回放 a–h、h2，要求 9/9 符合预期。
- **端到端（CDP）**：
  - 设置页走完下载流程。可以把下载源临时指向本地静态服务器来省时间，但至少要用真实 hf-mirror 下几 MB 验证连通性和续传。
  - 截图覆盖各个状态。
  - 用 `rgTestAudio` 跑一局朗读游戏，日志确认 `mode=local`。
- **打包验证**：
  - 用 `electron-builder --dir` 出一个未打包目录，从里面启动，确认子进程能加载原生模块并完成识别。
  - 记录安装包增加了多少体积。
