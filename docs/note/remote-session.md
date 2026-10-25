# 远程会话模式（设备投影）

主控端远控被控端设备：被控端创建/加入会话，主控端授权后控制投影设备。与远程游戏（`remote-game`）是独立房间类型。

## 端到端验收环境（2026-10-07）

生产房间服务 api.undersilicon.cn + 生产 EMQX，双隔离 Electron，仅虚拟设备。被控端 A 前端/后端/CDP `5303/5301/9234`，主控端 B `5304/5302/9225`。harness 在 `.tmp/remote-session-e2e-1007/`：`lib.js`（ev/api/pageFetch/shootBoth/waitButton）、`session-lib.js`（用 token 直连建会话）、`sniff.js`（常驻订阅本机 EMQX `/drecv/#` 抓设备下行帧）。报告 `docs/test/remote-session-e2e-2026-10-07.md`（54 张内嵌截图）。

## 复用要点

1. 房间码由房间服务生成、区分大小写且含 `-`/`_`（如 `x_ny6g-l7uk`）。前端不得 `toUpperCase` 或去连字符，只 strip 空白（`frontend/src/remote/remoteSessionFormat.ts` 的 `normalizeJoinCode`）。
2. 虚拟设备只订阅 `/dpub`，设备真正收到的下行帧在 `/drecv/<id>`。验证钳制/看门狗要订阅本机 EMQX `/drecv/#`；`GET /api/virtual-devices/:id/commands` 只记宿主侧调用，不含投影写入。
3. 界面轮询会吞点击：远程会话页状态 1–3s 轮询一次，脚本点「允许控制」前必须 `waitButton` 等按钮出现。授权后主控端「远程条」会自动跳一次 `/devices`（B 停在 `/home` 也会跳）。
4. 急停链路：主控端点急停 = 主房间命令（被控端停它登记的输出）+ 主控端本机 `emergencyStopOperatorOutputs`（停投影链路输出）；只做前者实测要等 ~8.8s 看门狗。
5. 撤权/踢出通过 events 通道的 `session.revoked {reason, forUserId}` 定向通知；投影设备记录在收尾时删除。
6. SSE 帧数统计要在页面脚本前注入钩子（CDP `Page.addScriptToEvaluateOnNewDocument` 包一层 `EventSource`），否则 `RemoteGamePanel` 的流在注入前就建好了。分离式游戏实测：运行中 10s 13 条 patch、活动 3s 5 条、停止后 10s 2 条。
7. 长跑/多脚本并发跑时先 `Stop-Process` 清掉上一轮同名脚本，否则两个采样进程互相 reset 会话（日志里 `elapsedSec` 回跳）。
8. 会话建好后被控端 `GET /api/game-runtime/status` 才有 `source: remote`；主控端 `/api/games/status` 恒为本机状态，别用它判断分离式游戏在哪跑。
