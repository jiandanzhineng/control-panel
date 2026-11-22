---
date: 2026-11-09
summary: CLI 补齐常用控制，发 npm 包 undersilicon-cli，限幅可选开启
---

# 命令行工具 undersilicon-cli

`device-cli/` 升级为面向用户和 AI agent 的命令行工具，发布到 npm（包名 `undersilicon-cli`，命令 `undersilicon`），不打进客户端安装包。

- 覆盖常用控制：设备与能力、预置操作、急停、游戏启停、窗口/页面/截图、事件监听、状态。默认连正式版端口 5278。
- 限幅可选开启：默认等同用户手动操作、不限幅；加 `--limit`/`--cap-limit` 时走 agent 租约，由后端缩放。客户端不支持租约时直接报错，不降级为不限幅。
- 用户文档在文档站开发文档分类（CLI 与 dsh 插件各一页），直接上线。
