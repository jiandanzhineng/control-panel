# play-registry（游戏网站）

UnderSilicon 控制面板仓库内的**游戏网站目录**（`control-panel/play-registry/`），单独部署为静态站。

面板运行时从本站拉取 `registry.json` 列出游戏与版本；点启动时游戏经面板 `gameProxy` 前缀式反代同源加载，连本机 `/bridge` 驱动真实设备。

默认内置游戏维护在 `backend/games/`，安装包本地直接使用；网站额外游戏维护在 `play-registry/games/`，只随在线游戏中心发布。构建时会合并这两个目录。

## 目录结构

```
index.html                          玩法网站首页（游戏列表 / 投稿 / 客服）
docs/                               游戏开发文档（快速开始 / DeviceAPI / 设备能力 / 投稿）
  getting-started.html
  device-api.html
  devices.html
  contribute.html
assets/css/site.css                 网站设计系统（深色霓虹，零依赖零构建）
assets/img/微信客服二维码.png        客服微信二维码
games/<id>/{index.html, game.js}    网站额外游戏（默认内置游戏在 ../backend/games）
registry.json                       构建产物（npm run build 生成，勿手改，已 gitignore）
packages/                           构建产物（npm run build 生成，勿手改，已 gitignore）
scripts/build-registry.js           扫 ../backend/games 和 games 生成 registry.json
test/extract.test.js                锁定 manifest 提取正则，防与面板侧 gameService 漂移
```

网站首页 `index.html` 运行时 fetch `registry.json` 渲染游戏卡片（搜索 / 能力筛选 / 统计），含投稿入口与客服二维码。文档页 `docs/` 从仓库 `docs/` 抽取关键内容整理而成，独立于后端文档站。

## 开发

```bash
cd play-registry
npm run build     # 生成 registry.json
npm test          # 跑 fixture（锁正则）
npm run serve     # 本地起静态站（等效 GH Pages，供面板联调；面板用 GAME_REGISTRY_URL 指向它）
```

`registry.json` 当前为 `schemaVersion: 2`。v1 字段继续保留，新增：

- `files[]`：zip 根目录下每个文件的 `{ path, sha256, size }`，用于解压后逐文件校验和损坏定位。
- `allowedOrigins`：游戏确需外部网络请求时显式声明允许的 origin；缺省为空数组。

校验优先级：离线整包下载用 `packageSha256`，解压后单文件校验用 `files[].sha256`。顶层 `sha256` 只是目录内容指纹，保留给变更检测和旧消费方展示，不作为客户端完整性校验依据。

## 添加 / 更新一个游戏

1. 默认内置游戏放 `backend/games/<id>/`；只给网站发布的扩展游戏放 `play-registry/games/<id>/`。
2. 目录内放 `index.html` + `game.js`。
3. `index.html` 头部必须有内联 `<script id="game-manifest">`，声明 `id` / `title` / `version`(semver) / `devices` / `params`，其中 `id` 必须等于目录名。
4. **资源引用默认只能用相对路径或 `/bridge-api/` 开头的绝对路径**。构建会扫描 HTML 的 `src`/`href`、HTML/CSS 的 `url(...)`、JS 字符串里的绝对 URL；禁止根绝对路径（如 `/games/foo/x.js`）和未声明的外部 URL。
5. 如游戏确实需要访问外部服务，在 manifest 中加 `allowedOrigins: ["https://api.example.com"]`。只写 origin；路径会被忽略。
6. 内容变更必须 bump `version`。CI 会从线上 `registry.json` 对比目录指纹，发现内容变了但 version 未变会拒绝发布。
7. `npm run build && npm test`，提交到 `main`。

zip 包名为 `<id>-<version>-<packageSha256前8位>.zip`，因此可长期缓存；客户端始终从 `registry.json` 读取 `packageUrl`。

## 部署

GitHub Actions：仓库根 `.github/workflows/deploy-play-registry.yml`，当 `play-registry/**`、`backend/games/**` 或 workflow 自身变更时触发，发布网站产物到两个地方：

- GitHub Pages：发布临时 `site/` 产物，包含网站壳、`backend/games` 默认游戏、`play-registry/games` 网站扩展游戏、`packages/` 和 `registry.json`。
- 阿里云 OSS：发布同一份网站产物到 `oss://ezs-games/`，`registry.json` 最后上传。

> 首次需在 GitHub 仓库 **Settings → Pages → Source** 选 **GitHub Actions**。

OSS 复用现有仓库 Secrets：`OSS_ENDPOINT`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`。Bucket 在 workflow 中固定为 `ezs-games`，公网域名为 `https://game.undersilicon.cn/`；如需部署到 bucket 子目录，可配置 Repository Variable：`PLAY_REGISTRY_OSS_PREFIX`。

面板默认从 OSS/CDN 拉取（源 URL 见 `backend/services/gameRegistryService.js` 的 `DEFAULT_SOURCE`，可被 env `GAME_REGISTRY_URL` 或面板设置覆盖）。GitHub Pages 保留为同产物备用发布通道。
