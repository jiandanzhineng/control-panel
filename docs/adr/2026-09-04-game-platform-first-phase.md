---
date: 2026-09-04
summary: 游戏投稿平台首期无审核 Worker，ZIP 直传 OSS 或 Git 地址，SQLite，无 SSR
supersedes: game-platform-lightweight-submission.md
---

# 游戏投稿平台首期形态

1. 首期不设审核 Worker。
2. 投稿支持两种入口：受限大小的 ZIP 以鉴权方式直传 OSS，或仅保存公开 Git 地址供审核员查看。
3. 业务数据库用 SQLite。
4. 不使用运行时 SSR；公开游戏网站、registry 和游戏包都由 OSS/CDN 提供。

总体架构与流程见 docs/plans/game-platform-architecture.md。
