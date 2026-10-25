# 玩法统计（OpenPanel）

- 看板 `https://op.shiroha.tech`，事件 `game_start`/`game_stop`（及插件对应事件）。
- 属性：version、source、device_types、device_macs、roles、duration_ms、end_reason。无 heartbeat，无登录态。上报 `https://op.shiroha.tech/api/track`。
- 项目 slug `undersilicon-electron-pc`。
- 导出要 read client（`openpanel-client-id` + `openpanel-client-secret` 头），凭证在 `E:\smart\.env` 的 `OPENPANEL_CLIENT_ID`/`OPENPANEL_CLIENT_SECRET`（read secret 不进仓库）。
- 工具 `tools/op-stats.ps1`：`pwsh -File tools\op-stats.ps1 [-Days 30]`，输出事件计数、按游戏启动数、时长（duration 只有 1.0.36-beta.5+ 上报）。
- 该实例 `/export/events` 忽略 start/end 且第 1 页只返回少量事件，必须按 `meta.pages` 翻页并本地按时间过滤；`/insights/*`、`/manage/*` 路由不存在。
