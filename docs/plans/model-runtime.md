# 客户端本地模型运行时方案

> 2026-10-31。决定见 `docs/adr/2026-10-31-model-runtime.md`；实测数据见 `tmp/asr-compare/report.md`；现有云端识别通道见 `docs/plans/reading-game.md` 第 3 节。

## 1. 边界

- **客户端负责一切和模型相关的事**，包括模型目录、下载、加速设备、推理进程和任务路由，代码放在 `backend/model-runtime/`。
- **游戏只按任务调用。** 第一个任务是 `asr.transcribe`。游戏仍然调 `DeviceAPI.speech.transcribe/status`，接口形状不变。
- **以后要加的任务**（如 `kws.detect`、`tts.speak`、`vad`）和新模型，都只需要在目录里加条目、写对应的任务适配，游戏端不用改。
- **第一版范围：**
  - 运行时框架；
  - 语音识别任务；
  - SenseVoiceSmall int8；
  - CPU 推理必须端到端跑通；
  - GPU 推理在本机（GTX 1050 Ti）可行就实现，并给出数据；不可行就保留接口，并写明原因。

## 2. 分层

| 模块 | 职责 |
|---|---|
| `catalog/` | 模型目录。每个模型一个 JSON：`id`、`task`、`title`（中英）、`engine`（如 `sherpa-onnx`）、`engineConfig`（如 `{ type: 'sense_voice', model: 'model.int8.onnx', tokens: 'tokens.txt' }`）、`files[{ name, bytes, sha256, urls[] }]`、`providers`（这个模型支持的设备）、`license`、`recommended`。启动时校验目录格式。 |
| `modelStore` | 下载（`.part` 文件、Range 续传、按 urls 顺序换源）、sha256 校验、取消、删除、状态查询。存放在后端数据目录下的 `models/<id>/`，跟着 `BACKEND_DATA_DIR` 走。 |
| `accelerators` | 探测可用的推理设备，输出 `[{ id: 'cuda'\|'directml'\|'cpu', name, available, reason }]`。判断依据有三条：引擎构建是否支持、硬件是否存在、实际加载一次小测试。探测结果缓存起来，驱动或引擎版本变了再重新探测。CPU 永远可用。 |
| `engines/` | 引擎适配，第一个是 sherpa-onnx。负责在子进程里按 provider 加载模型并推理。同一个引擎的 CPU 版和 GPU 版构建可以不同；GPU 版的大体积运行库也作为可下载组件，由 `modelStore` 管理。 |
| `workerHost` | 每个（引擎、provider、模型）组合一个子进程，用 `process.execPath` 加 `ELECTRON_RUN_AS_NODE=1` 启动，通过 IPC 通信。负责串行排队、单次请求超时、崩溃后下次请求时重启、空闲 10 分钟退出。 |
| `taskRouter` | `run(task, input, opts)` 的处理流程：先选模型，再选设备，最后本地推理，失败时回退云端。 |

### 2.1 选模型

- 优先级：游戏指定的模型 → 用户在该任务上设的首选模型 → 目录里标为推荐的模型。
- 只在已下载并校验通过的模型里选。

### 2.2 选设备

- **自动模式**：模型首次加载时，在所有可用设备上各跑一段 4 秒样例音频，选最快的并缓存结果；之后加载失败或推理失败时，就换下一个最快的设备。
- **手动模式**：用户在设置里指定设备，指定的设备不可用时回退到 CPU，并在设置页提示。
- 某个设备对某个模型加载失败或推理崩溃 2 次，就标记为不可用，直到下次重新探测。

### 2.3 回退云端

- 本地推理失败或超时时，这一次请求立即改走云端，日志里记 `fallback=1`。
  - 云端顺序：`asr` 先用自备 key（`own_key`），再用中转（`relay`）。
- **熔断**：本地连续失败 3 次，暂停走本地 60 秒，60 秒后再试。

### 2.4 状态与预热

- 本地可用时，`speech.status()` 返回 `{ ready: true, mode: 'local', model, provider }`，不需要登录。
- 游戏调用 `status()` 时预热子进程，冷启动约 2 秒。

### 2.5 推理线程

- CPU 推理线程数：`min(4, max(1, floor(核数/2)))`。

## 3. 接口

- **后端内部**：`modelRuntime.run('asr.transcribe', { audio, format: 'wav' }, { timeoutMs, model? })`，返回 `{ text, mode: 'local'|'own_key'|'relay', model, provider, latencyMs, fallback }`。`sttService` 改成调用它。
- **HTTP 接口：**
  - `GET /api/models`：目录和每个模型的状态（`absent|downloading|verifying|ready|error`，含 `received`/`total`/`error`）。
  - `POST /api/models/:id/download`、`POST /api/models/:id/cancel`、`DELETE /api/models/:id`（删除前先停掉相关子进程）。
  - `GET /api/models/accelerators`：设备探测结果，以及每个模型的基准测试结果。`POST /api/models/accelerators/refresh` 重新探测。
  - `GET/POST /api/models/settings`：按任务保存设置，如 `{ asr: { localEnabled, model, provider: 'auto'|'cuda'|'directml'|'cpu' } }`。模型下载完成后，如果这个任务还没设置过，自动打开 `localEnabled`。
- **游戏 manifest（可选声明）**：`"models": [{ "task": "asr", "id": "sense-voice-small-int8", "optional": true }]`。
  - 配置页看到这个声明时，显示提示：「这个游戏可以使用本地模型 X（未下载 / 已就绪）」，并附带「去下载」链接，跳到设置页。
  - 朗读游戏加上这个声明，游戏版本升到 1.1.2。

## 4. 第一个模型

`sense-voice-small-int8`，即 sherpa-onnx 的 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` int8 版。

| 文件 | 字节 | sha256 |
|---|---|---|
| `model.int8.onnx` | 239233841 | `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` |
| `tokens.txt` | 315894 | `f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc` |

下载源按顺序尝试：
1. `https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/<文件>`
2. `https://huggingface.co/` 下的同一路径

## 5. 引擎和加速：可行性要实测

- **CPU**：原生 `sherpa-onnx-node` 必须验证两件事：在 Electron 自带的 Node 里能加载；`electron-builder` 打包后能加载（`.node` 和 DLL 要 asarUnpack）。走不通时，评估仓库已有的 WASM 版 `sherpa-onnx`，每段 1.5 秒以内可以接受。
- **GPU**：调查 sherpa-onnx 的 CUDA 和 DirectML 构建，包括有没有、Node 能不能用、体积多大、对驱动和 CUDA 版本的要求。
  - 能用的话，在本机 GTX 1050 Ti 上实测速度，和 CPU 对比。
  - GPU 运行库体积大的话，做成可下载的「加速组件」。
  - 如果 GPU 对这个小模型并不更快，自动模式的基准测试会自然选 CPU，这是可以接受的。
- 结论和数据都写进第 8 节。

## 6. 设置页「本地模型」

在设置里新加一个分区，或放在「语音服务」旁边，样式和现有设置卡片一致，中英文齐全。分区包含：
- **推理设备**：列出检测到的设备（名称、是否可用、原因）、当前在用哪一个，带「重新检测」按钮。
- **模型列表**（按任务分组）：每个模型显示名称、大小、语言、许可证，以及当前状态。
  - 状态包括：未下载、下载中（进度条，可取消）、校验中、已就绪（可删除）、出错（可重试）。
- **每个任务的设置**：启用本地识别、首选模型、推理设备（自动 / CUDA / DirectML / CPU）。
- **性能显示**：每个设备的基准耗时，以及最近一次推理的耗时。
- 「语音服务」里的 SiliconFlow key 保持不变，并说明「本地模型不可用时使用」。

## 7. 测试

- **单测**：
  - 目录格式校验；
  - modelStore：用本地假服务器测续传、换源、sha256 失败、取消、删除；
  - accelerators：注入假的探测结果；
  - workerHost：用假引擎测排队、超时、崩溃重启、空闲退出；
  - taskRouter：选模型、自动选设备与设备失败回退、本地失败回退云端、熔断与恢复。
- **集成**：
  - 用真实模型（可以用 `tmp/asr-compare/models/` 里已下载的那份）经 `sttService` 走本地，识别场景音频；
  - 本地回放朗读游戏 a–h 和 h2，要求 9/9 符合预期；
  - GPU 可用时，用 GPU 再回放一遍。
- **端到端（CDP）**：
  - 设置页走一遍下载流程。可以把下载源临时指向本地服务器来省时间，但至少要真实从 hf-mirror 下载几 MB，验证连通和续传；
  - 截图覆盖各个状态和设备列表；
  - 配置页截一张本地模型提示的图；
  - 用 `rgTestAudio` 跑一局朗读游戏，日志里要出现 `mode=local` 和使用的设备。
- **打包**：用 `electron-builder --dir` 打包后启动，确认子进程能加载原生模块并完成识别，记录安装包增加的体积。

## 8. 实现记录

### 8.1 引擎与模型

- 引擎：`sherpa-onnx-node` 2.0.1（N-API），Windows x64 原生库来自 `sherpa-onnx-win-x64`（内含 CPU 版 onnxruntime）。
- 模型：SenseVoiceSmall int8。`model.int8.onnx` 239,233,841 B（sha256 `c71f0ce0…cd51`），`tokens.txt` 315,894 B（sha256 `f449eb28…a1dc`）；按需下载到 `BACKEND_DATA_DIR/models/sense-voice-small-int8/`。
- 子进程只接受 16kHz 单声道 WAV；CPU 线程数 `min(4, max(1, floor(cores/2)))`（本机 Ryzen 5 2600，12 线程 → 4 线程）。
- 实测：ONNX Runtime CPU 4 线程、4 秒音频 p50 320.9ms；游戏内每段约 3 秒音频，本地识别 328–414ms。CDP 端到端日志（最终一轮）：319 / 334 / 337 / 336 / 344ms。

### 8.2 GPU 与 NPU 结论

- 本机 GTX 1050 Ti 4GB，驱动 581.80 / CUDA 13.0；Pascal（compute 6.1）已被 CUDA 13 放弃，当前也没有安装 CUDA toolkit。
- sherpa-onnx 官方 npm 的 Windows 包只带 CPU 版 onnxruntime，没有官方 CUDA / DirectML 的 Windows Node addon；要用 GPU 需自编（VS2022 + CMake + 对应 EP）。
- DirectML 试过：`onnxruntime-directml` 1.24.4 能跑小模型，但加载 SenseVoice **int8** 会话直接崩溃（exit 139）；fp32 模型 937,617,178 B（约 938MB），远大于 int8 的 239MB，v1 不采用。
- 因此 v1 引擎只声明 `cpu`（可用 `MR_SHERPA_PROVIDERS` 覆盖），设备探测、自动基准、失败回退等接口都已就绪；以后有 GPU 构建时可作为可下载组件接入。
- NPU：`accelerators` 已通过 WMI 识别 NPU，设备 id 预留 `npu`；当前引擎构建没有 NPU / DirectML EP，界面显示「当前引擎不支持」。sherpa-onnx 走 onnxruntime 的 execution provider，理论上可用 DirectML 统一使用 GPU / NPU；厂商 NPU（QNN / OpenVINO / CoreML）需要专门构建，npm 预编译包不包含。

### 8.3 体积

- 新增依赖：`sherpa-onnx-node` 109 KB + `sherpa-onnx-win-x64` 23.1 MB（onnxruntime.dll 17.8MB、sherpa-onnx-c-api.dll 4.3MB、sherpa-onnx.node 0.7MB 等），解压后约 23.2MB；`asarUnpack` 后位于 `app.asar.unpacked/backend/node_modules/`。
- 模型不进安装包，首次使用下载约 239.5MB。
- `electron-builder --dir` 产物 `dist/win-unpacked` 约 472MiB，其中 `app.asar` 约 89.7MiB；新增解包目录 `sherpa-onnx-node` 63,217 B + `sherpa-onnx-win-x64` 23,160,980 B，合计约 23.2MB。
- 打包验证：用打包后的 `UnderSilicon.exe` + `ELECTRON_RUN_AS_NODE=1` 启动 `app.asar` 里的 `worker.js`，原生模块从 `app.asar.unpacked` 加载成功，识别 4 秒音频耗时 345ms，结果「山路。」。

### 8.4 许可证

- SenseVoiceSmall：FunASR Model Open Source License 1.1（Alibaba Group），允许使用、复制、修改和分发，需保留版权与模型名称/归属，未限制商用。目录与设置页展示许可证链接和 attribution。
- `sherpa-onnx` / `sherpa-onnx-node`：Apache-2.0。

### 8.5 与方案不一致或需要说明的地方

- `electron/main.js` 增加了 `CONTROL_PANEL_USER_DATA_DIR`，仅用于隔离测试实例；未设置时行为不变。
- 下载完成自动启用时 `settings.model` 保持 `null`（自动使用推荐模型），`configured=true`。
- 朗读游戏版本升到 1.1.2（manifest 与 `game.js` 内部版本号一致）。
- CDP 下载流程用本地假源加速；另用 hf-mirror 实测断点续传（2,150,280 → 4,055,028 B，+1,904,748 B，Range 生效）。
- 本机 GPU 未能实际跑通，因此没有执行「GPU 可用时再回放一遍」。
- 当前工作区把根 `node_modules` 指到主仓库（符号链接），`electron-builder` 打出的完整 GUI 因 `electron-updater` 依赖的 `graceful-fs` 未被复制而报错；这是工作区/依赖布局问题，与本次改动无关。打包子进程识别验证不受影响（见 8.3）。
