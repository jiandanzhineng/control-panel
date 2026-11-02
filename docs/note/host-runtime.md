# HostRuntime 托管运行与原始 UI

## 模块与契约

- 后端 `backend/game-runtime/`：`gameCoreRuntime.js`（事件队列、tick、快照）、`gameHostService.js`（单活跃会话、生命周期、权限、设备 effects）、`cores/*-core.js`。
- 远程 `backend/services/remoteGameService.js`；路由 `backend/routes/gameRuntime.js`、`remoteGame.js`；前端 `frontend/src/api/gameRuntime.ts`、`remoteGame.ts`、`components/GameRuntimeView.vue`。
- Core 只接收输入返回数据：`start/pause/resume/stop(nowMs)`、`setParams`、`action`、`step({nowMs, events})`、`snapshot()`；时间只能由宿主传入，不能 `Date.now()`/`setTimeout()`/`setInterval()`。effects 只声明意图（`device.set-strength`、`device.shock`、`device.stop-all` 等）。
- HostRuntime 以 50–100ms tick 驱动 Core；effects 经安全执行层校验设备/能力/role/边界后调 `deviceService.invokeDeviceCapability`；shock 自动停止计时器由 HostRuntime 管理。

## API

`/api/game-runtime`：`GET /status`、`POST /start|/params|/action|/stop`，`/sensor`、`/tick` 仅 debug/mock。

`/api/games/:id/start` 返回 `runtime.mode = host|iframe`；`/api/games/stop-current` 同时停 HostRuntime 和旧 bridge session；`/api/games/status` 返回 HostRuntime 状态。

## 原始 UI 托管渲染（2026-09-29）

- host 游戏运行页改回各游戏自己的页面。页面带 `?runtime=host|remote` 时进入托管渲染模式，共享桥脚本 `backend/public/game-runtime-bridge.js`：host 轮询 `/api/game-runtime/status`、命令走 `/api/game-runtime/*`；remote 轮询 `/api/remote-game/status`、命令映射为 `/api/remote-game/command` 白名单。
- `GameRuntimeView` 只是 iframe 壳（等待按键/重连提示/结束导航/运行中参数面板）。
- 页面路径解析 `frontend/src/play/gamePagePath.ts`：内置游戏走 `/api/games/:id` 的 gamePath，注册表游戏走 `/api/game-cache/install/:id`。
- `GameRuntimeSurface`/`gameSurfaces/*` 已删除，配置页不再有「配置预览」。

## DeviceAPI.cloud（页面游戏云存档，2026-11-01）

- 页面游戏经 bridge 调用 `DeviceAPI.cloud.status/get/put`，宿主转发到 `GET/PUT {ACCOUNT_API_URL}/me/game-data/:gameId`；契约与错误码见 `docs/plans/vocab-game.md` §4.2。
- `gameId` 只由宿主持有：`/api/games/:id/start` 签发 `gameToken`，前端放进 iframe URL 的 `#` 片段（不进服务器访问日志）、bridge init 回传，页面传来的任何 gameId 都忽略；无令牌 `BAD_GAME`。手机端实现同一接口时也要保持这个来源。
- 错误码 `NOT_SIGNED_IN | VERSION_CONFLICT（err.remote）| NETWORK | TOO_LARGE | BAD_GAME | BAD_DATA | UPSTREAM_<status>`；token 与存档内容不进日志。

## 版本与验证

- surge-edging 以线上 1.3.6 页面为原版拉回仓库并加托管适配（1.4.0 → 1.4.1 对齐原版算法）；pressure-edging-v2 2.2.0 → 2.2.1（恢复临界气压无上限、曲线拖动经 `setThresholds` 提交宿主、+10 只抬本帧目标）。
- 参数只限 min/max 不按步长取整；暂停不顺延结束时间也不打断电击，暂停中可电击；宿主开局读一次传感器当前气压，只在气压变化时推样本。
- 已发布 `packages/surge-edging-1.1.2-*.zip` 未重建，网站包仍是 iframe 版，直到下次 registry 构建。
- 移动端 `E:\develop\smart\control_panel_mobile` 的游戏运行层改动本轮未同步页面过去。
