# 游戏平台生产部署

## 服务

- API `https://game-api.undersilicon.cn`，服务器 `47.242.37.88`。
- systemd 服务 `game-platform` 仅监听 `127.0.0.1:8787`；程序 `/opt/game-platform/current/game-platform`；配置 `/etc/game-platform/game-platform.env`；SQLite `/var/lib/game-platform/game-platform.db`；Nginx `/etc/nginx/conf.d/game-api.undersilicon.cn.conf`。日志 `journalctl -u game-platform`。
- 查投稿/待审（只读，不用登录审核后台）：`ssh -i ~/.ssh/id_rsa root@47.242.37.88` 后
  `sqlite3 -header -column /var/lib/game-platform/game-platform.db "SELECT id,author_name,title,status,datetime(created_at,'unixepoch','localtime') FROM submissions ORDER BY created_at DESC LIMIT 20;"`。
  审核后台「投稿审核」只列 `status='pending'`；`POST /api/submissions` 一落库就有行，所以没行=没人开始投稿。真实投稿尝试也可在 `/var/log/nginx/access.log` 里 grep `POST /api/submissions`。

## 发版与回滚

- Linux 构建：`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath`，scp 到 `/opt/game-platform/releases/<时间戳>`，`ln -sfn` 切 current，`systemctl restart game-platform`。
- 2026-10-06 发版：`releases/20261006-155439`；回滚点 `releases/20260917-164315`（新表/新列向后兼容，旧程序不读）；发版前备份 `game-platform.db.bak.20261006-155439-pre-creator-payout`。
- 生产程序不带 `--help`，直接执行会以默认配置在 cwd 建 `data/` 并尝试监听 8787，别在服务器上裸跑。
- 首次投产必须在发布新游戏前调用一次 `/api/admin/registry/import`。生产 `GAME_PLATFORM_EXISTING_REGISTRY_URL` 用 `https://game.undersilicon.com/registry.json`；2026-09-05 已完成导入并在 QA 下架后恢复原 8 个游戏，备份后缀 `.bak.20260905-registry-restore`。
- 重建 registry：`game-platform rebuild-registry`（加载 `/etc/game-platform/game-platform.env`）。

## OSS 与缓存

- 公开 bucket `ezs-games`；待审 bucket `ezs-game-submissions` 为 private，只允许 `https://game.undersilicon.cn` POST，`submissions/` 180 天清理（2026-10-06 由 7 天改为 180 天，曾因此丢掉 2 条待审投稿源包）。
- ESA 站点 `undersilicon.cn` 的既有 API/admin 缓存规则已补 `no_cache`，全局 CORS 规则排除 `game-api.undersilicon.cn`。
- ESA 缓存规则 `506125495674880` 只匹配 `game.undersilicon.cn/registry.json`，浏览器与边缘均 `no_cache`、`bypass_all`；玩法页面和不可变资源用自动缓存。默认 registry 已验证为 `DYNAMIC`。
- 公开 `registry.json` 的社区游戏带 `authorName`（投稿署名）；介绍页读该字段，缺署名且非 builtin 才显示未知作者。
- 待审源包会过期：`sub_98042fefb077036af982bc100cef6284`（Gu，2026-09-21，三阶段寸止自动校准定时版）在库里仍是 `pending`，但 `ezs-game-submissions` 里的 `source.zip` 已被旧 7 天规则清掉（2026-10-25 查为 NoSuchKey），**这条投稿无法审核发布，只能让作者重传**。查源包是否存在：对 `ezs-game-submissions` 做 HEAD `submissions/<id>/source.zip`。

## 工具链

- Go 免安装版：`C:\Users\46907\AppData\Local\GoPortable\go1.27.0-full\go\bin\go.exe`，在 `game-platform/` 下 `go test ./...`；生产构建用 `game-platform/Dockerfile`。
- BrowserOS neo 走系统代理 `127.0.0.1:7990` 时，Windows `ProxyOverride` 需含 `*.undersilicon.cn`，否则 game API 请求可能断连。

## 已知坑

- 审核权限以 `/api/auth/me` 的 role 为准，导航昵称 admin 不表示管理员。
- 2026-10-14 qi 投稿 `sub_1a1b94c341415fc3ece8000ffba712aa` 上线 `pressure-edging-v2-calib` 2.3.9，资源目录 `games/pressure-edging-v2-calib/2.3.9-edf56292/`，正式包 SHA256 `edf562923213d13d481d82e3c1dbafbf1f7dfd4b8a06c024df27dd2124b5969e`（未做真机测试）。
