---
date: 2026-10-30
summary: 朗读游戏从 electron-client 迁入 control-panel，PC 与手机端都要能玩
---

# 朗读游戏迁入 control-panel

用户要求把在 electron-client 做的朗读游戏（不读就电击）直接迁到 control-panel，并且兼容手机端。

- 玩法与防误电规则沿用 electron-client 版（分支 feat/reading-game，方案见该仓库 docs/plans/reading-game.md），只改运行方式。
- 语音识别不走 MiMo，而是走 mimo 中转上的 SiliconFlow 语音识别；用户也可以在设置里填自己的 SiliconFlow key 直连（见 2026-10-30-siliconflow-stt）。
