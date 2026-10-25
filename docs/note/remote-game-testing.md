# 远程游戏（HostRuntime）测试环境与要点

## 双隔离 Electron 回归环境

- 被控端前端/后端/CDP `5303/5301/9224`（2026-10-07 起用 `9234`），主控端 `5304/5302/9225`。
- 测试房间服务 `8787`、本机 MQTT `1883`。
- 虚拟设备 `electron_qiya/electron_td01/electron_dianji/electron_lock` 在被控端 `POST /api/virtual-devices/batch` 创建。
- 隔离后端 `/api/dev-access` 设 `enabled=true` 仅供本机手测；它的状态会持久化到后端数据目录，开着跑后端测试会让 `bridgeAccessGuards`/`browserApiAccess` 两个套件失败，手测完务必 `{"enabled":false}` 关回。

## 虚拟设备下的检查路径

- TD01 `power`、电脉冲 `voltage/shock`、自动锁 `open` 的投影写入会收到 `projection.write-result`。
- 远程游戏房间 `gameId=remote-game`、容量 2，与设备投影房间分开。
- 停止快照应为 `ENDED/remote-stop`，设备均安全复位；结束后 `remote-game.active=false`、`game-runtime.active=false`。
- 撤销授权后主控命令返回 `CONTROL_NOT_AUTHORIZED`。

## 无头验证

- 无头 Chrome 需请求头 `x-control-panel-bridge-internal: 1` 才能加载桥脚本。
- 游戏页面可用 `--headless=new --virtual-time-budget=6000 --dump-dom` 实测渲染；`/api/game-runtime/sensor` 可注入气压触发边缘期。
- 隔离后端可用 `PORT=5391 BACKEND_DATA_DIR=.tmp/...` 启动。
- CDP 调游戏 iframe 时按 iframe 自己的 target（url 含 `5173/games/<id>`）连。

## 已知边界

- 所有上述验证都只用虚拟设备，不代表真实硬件输出。
- 手机锁屏后台能力未验证；PC HostRuntime 的时钟与生命周期接口可被移动端复用，但移动端前台服务另行实现。
