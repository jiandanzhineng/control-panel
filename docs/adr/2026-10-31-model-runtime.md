---
date: 2026-10-31
summary: 客户端新增本地模型运行时，游戏按任务调用，先接本地 SenseVoice
---

# 客户端本地模型运行时

云端识别偶尔要 4～15 秒，本地 SenseVoice 每段约 0.35 秒（`tmp/asr-compare/report.md`）。用户要求模型都放客户端，便于复用。

- 运行时放在 control-panel 后端，管目录、下载、设备、推理和路由。
- 游戏只按任务调用，`DeviceAPI.speech` 接口不变。
- 推理设备按 GPU → CPU 回退；识别通道按本地 → 自备 key → 中转回退。
- 模型按需下载，不打进安装包；第一个模型是 SenseVoiceSmall int8。
- 2026-11-01 修订：手机端已接本地识别，见 control_panel_mobile `docs/adr/2026-11-01-mobile-local-asr.md`。
