# 远程会话加固（2026-10-06）

分支 `fix/remote-control-hardening`。修复 10 分钟断线、离开卡死、残留房间挂死、断开谎报、首次启动无界面。

- 新增 `backend/services/remoteOutputGuard.js`：逐字段限幅、未知拒绝、电刺激 10s / 电机 60s 看门狗。
- 授权绑定 userId + 踢人；`gameSessionId`（不带则兼容放行）；5277/5278 只绑回环 + 远控路由 `loopbackOnly`；gameProxy 白名单；第三方 iframe sandbox。
- 生产房间服务 + EMQX 双端实测 13/13 通过，报告 `docs/test/remote-control-e2e-2026-10-06.md`（含截图），harness 在 `.tmp/remote-regression-1006/`。
- 未做：服务端 joinCode 过期/踢线接线、四路写入统一仲裁、手机端适配。

## 已知缺陷（2026-10-06 回归发现，9-30 审查项未修）

1. 远程游戏 10 分钟凭据到期必断且无刷新（`Bad User Name or Password`）。
2. 操作方 `stop()` 向 `events` 发 `session.revoked` 被 ACL 拒 → broker 135 踢线 → publish 回调不返回，`leave`/二次 `join` 永久挂起、按钮无限 loading。
3. 房主 presence 为 retained offline 的房间，`join` 静默挂死。
4. `devices.disconnect` 返回成功但虚拟设备仍在线。
5. 首次远程启动 surge-edging 时 B 请求 `/api/games/surge-edging` 404 不出 iframe，刷新恢复。

远程仅支持 surge-edging / pressure-edging-v2；手机端未实现远程游戏协议。
