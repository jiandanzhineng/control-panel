---
date: 2026-09-04
summary: 投稿平台复用 mobile 账号体系，保留宽松 CORS，昵称只作署名
supersedes: game-platform-mobile-auth.md
---

# 游戏平台复用 mobile 账号

1. 游戏投稿平台使用 mobile 的账号、登录与会话系统，不再维护独立密码。
2. 保留 mobile 现有宽松 CORS 配置，不收紧。
3. 投稿接受邮箱账号及已验证手机号账号，统一以账号中心 users.id 关联投稿、归属与分成；昵称作为单次投稿署名保存，手机号仅脱敏展示。
