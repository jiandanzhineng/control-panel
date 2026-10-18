# 语音渠道与语音助手

- 语音渠道在面板「设置 → 语音服务」。没改过时默认走官方渠道。key 存在 `BACKEND_DATA_DIR/voice-settings.json`。
- 本机游戏打 `POST /v1/chat/completions`；状态 `GET /api/voice/status`。
- 客户端「瑰夏大人」语音助手调研见 `docs/research/pc-voice-assistant-2026-08-31.md`；唤醒词引擎拟用 `sherpa-onnx-node`（Windows x64，无需预装 C++/Python），KWS 模型 `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`。
- 语音开始（口令触发）是另一条链路，见 [voice-start](voice-start.md)。
