# 游戏投稿平台

轻量 Go 服务：账号、ZIP/Git 投稿、人工审核、同步发布和 `registry.json` 生成。公开玩家流量始终由 OSS/CDN 处理，服务只处理低频投稿和审核操作。

## 部署边界

- `OSS_BUCKET`：公开读取的游戏网站、正式游戏文件、离线 ZIP 与 `registry.json`。
- `OSS_SUBMISSION_BUCKET`：**私有**待审核 ZIP。浏览器拿到受限时效与大小的 POST Policy 后直传这里；不得配置匿名读。
- Docker 持久卷：SQLite 数据库。每日至少备份一次数据库文件至受控备份位置。
- API 域名：例如 `game-api.undersilicon.cn`，由现有反向代理转发至 `127.0.0.1:8787`；可和 Shop 同机部署，但保持独立容器、域名和数据卷。

生产环境强制要求公开 bucket 与投稿 bucket 不同，避免未审核源包被公开访问。

## 首次部署

```bash
cd game-platform
cp .env.example .env
# 填入正式密钥、管理员邮箱和 OSS 配置
docker compose up -d --build
curl http://127.0.0.1:8787/healthz
```

首次管理员使用 `.env` 中 `GAME_PLATFORM_ADMIN_EMAILS` 的邮箱在投稿工作台注册。网站为 `https://game.undersilicon.cn`，API 为 `https://game-api.undersilicon.cn` 时，`GAME_PLATFORM_PUBLIC_SITE_ORIGINS` 只填写前者，不能带路径或末尾 `/`。

反向代理需要把 API 域名的 HTTPS 请求原样转发到 `127.0.0.1:8787`；不要把 API 配到 OSS 静态域名。Cookie 由 API 域名签发，静态站通过受限 CORS 携带它调用 API。

## OSS 设置

公开 bucket 对外提供网站和正式资源。私有投稿 bucket 不开匿名读，也不要用 CDN 公网回源。为私有 bucket 配置：

- CORS Origin：`https://game.undersilicon.cn`
- Method：`POST`
- Allowed Header：`Content-Type`
- Max Age：600 秒
- 生命周期：`submissions/` 下未完成投稿在 7 天后删除

`OSS_BUCKET` 的 `registry.json` 使用 `no-cache` 或较短缓存；`games/`、`packages/` 使用长缓存。服务的发布顺序是先写不可变游戏文件与 ZIP，最后写 registry。

## 从旧站切换

1. 暂停旧的 registry 发布工作流，确保之后只有本服务写 `registry.json`。
2. 确认旧游戏文件和 ZIP 已在公开 bucket 可读。
3. 用管理员会话调用一次导入接口：

```bash
curl -X POST https://game-api.undersilicon.cn/api/admin/registry/import \
  -H 'Content-Type: application/json' \
  -b 'game_platform_session=YOUR_ADMIN_SESSION'
```

4. 导入会自动重建公开 `registry.json`；检查导入数量和 OSS 内容后，再发布新的静态站壳。

导入只用于切换，之后不应再调用。下架或重建 registry 仍通过管理员 API 操作。

## 本地开发

```powershell
$env:GAME_PLATFORM_STORAGE_DRIVER = 'filesystem'
$env:GAME_PLATFORM_DATABASE_PATH = '.\data\game-platform.db'
$env:GAME_PLATFORM_LOCAL_STORAGE_DIR = '.\data\objects'
go run .
```

本地文件存储会提供受同一 API 认证保护的上传代理，仅用于开发；生产 ZIP 直传 OSS，不经过应用服务器。
