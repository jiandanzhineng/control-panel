---
date: 2026-10-31
summary: PC 端游戏语音识别加本地 SenseVoice（sherpa-onnx），优先本地，云端回退；模型首次使用时下载
---

# PC 端本地语音识别

用户实测时，云端语音识别（SiliconFlow SenseVoiceSmall）偶尔要 4～15 秒才返回。对比实测见 `tmp/asr-compare/report.md`：
- 本地 SenseVoice int8 每段 4 秒音频约 0.35 秒，错字率 1.4%，回放 9/9；
- 云端 P90 6.1 秒，最长 14.3 秒。

用户同意 PC 端加本地识别。

- **模型和引擎：** 用和云端同一个模型 SenseVoiceSmall 的 int8 版，跑在 sherpa-onnx 上，所以游戏判定逻辑不用改。
- **在哪里跑：** 在 control-panel 的 Node 后端里跑，并放进独立的子进程。游戏页面不变，仍走 `DeviceAPI.speech`。
- **通道顺序：** 本地 → 自备 SiliconFlow key → 官方中转。本地出错或超时时，这一次请求自动改走云端。
- **模型下载：** 模型约 229MB，不打进安装包，在设置页手动下载，可以删除。
- **小型流式模型（Zipformer）先不用：** 它的错字率约 13%，离稿判定的余量太薄。
- **手机端** 继续只用云端。
