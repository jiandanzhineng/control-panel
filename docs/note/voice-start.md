# 语音开始（KWS 口令触发）

配置页「设备按键开始」旁有「语音开始」：选麦克风、说一遍测试通过后才能确认，进等待页后识别到口令直接开始。远程会话隐藏入口且后端拒连；只对 game 载体提供。口令两条同时生效（中文「开始游戏」、英文「start the game」），弹窗列出两条说明，不让用户选。

## 模型与代码位置

- 模型 `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`（官方 kws-models release，中英双语，一个模型同时识别中文 ppinyin 与英文 phone）。只保留运行文件在 `backend/voice-kws/`：
  - `encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx`（4.6MB）
  - `decoder-epoch-13-avg-2-chunk-16-left-64.onnx`（760KB，该模型 decoder 无 int8）
  - `joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx`（87KB）
  - `tokens.txt`、`keywords.txt`
- 识别在 `backend/voice/voiceTriggerService.js`（sherpa-onnx 1.13.8 Node/WASM；懒加载，进程内复用同一 KeywordSpotter，每条 WS 连接一条 stream）。
- WS 端点 `backend/services/voiceTriggerWs.js`：`/voice-trigger`，不带参数，目录内口令同时生效；协议 `ready`/`detected`/`error`。
- 口令目录 `backend/voice/voicePhraseCatalog.js` 是唯一事实来源；前端从 `GET /api/voice/phrases` 取。
- 打包：模型走 package.json 的 `extraResources` → `resources/voice-kws`，`sherpa-onnx` 走 `asarUnpack`。

## WS 升级路由

`backend/services/wsUpgradeRouter.js` 是唯一的 `server.on('upgrade')` 入口，`/bridge` 与 `/voice-trigger` 各自 `register(name, match, handle)`。没有路由认领的路径回 400 并销毁 socket，否则 upgrade 会一直挂着。挂载是进程级一次性（`attach()` 幂等），单测里反复 `init()` 不会重复挂监听。
