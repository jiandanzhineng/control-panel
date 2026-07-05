# play-registry（游戏网站）

UnderSilicon 控制面板仓库内的**游戏网站目录**（`control-panel/play-registry/`），单独部署为静态站。

面板运行时从本站拉取 `registry.json` 列出游戏与版本；点启动时游戏经面板 `gameProxy` 前缀式反代同源加载，连本机 `/bridge` 驱动真实设备。**改这里即生效，无需重发面板安装包。**

游戏内容只存在于此目录——`backend` 已不含游戏（纯远程架构）。

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
games/<id>/{index.html, game.js}    游戏内容（自包含，头部内联 <script id="game-manifest">）
registry.json                       构建产物（npm run build 生成，勿手改，已 gitignore）
scripts/build-registry.js           扫 games/* 生成 registry.json（semver 校验 / 资源引用 lint / sha256 指纹）
test/extract.test.js                锁定 manifest 提取正则，防与面板侧 gameService 漂移
```

网站首页 `index.html` 运行时 fetch `registry.json` 渲染游戏卡片（搜索 / 能力筛选 / 统计），含投稿奖励档位与客服二维码。文档页 `docs/` 从仓库 `docs/` 抽取关键内容整理而成，独立于后端文档站。

## 开发

```bash
cd play-registry
npm run build     # 生成 registry.json
npm test          # 跑 fixture（锁正则）
npm run serve     # 本地起静态站（等效 GH Pages，供面板联调；面板用 GAME_REGISTRY_URL 指向它）
```

## 添加 / 更新一个游戏

1. 在 `games/<id>/` 放 `index.html` + `game.js`。
2. `index.html` 头部必须有内联 `<script id="game-manifest">`，声明 `id` / `title` / `version`(semver) / `devices` / `params`。
3. **资源引用只能用相对路径或 `/bridge-api/` 开头的绝对路径**——禁止根绝对路径（如 `/games/foo/x.js`），否则会被面板 gameProxy 误判为本地资源（build 会 lint 拦截）。
4. `npm run build && npm test`，提交到 `main`。

## 部署

GitHub Actions：仓库根 `.github/workflows/deploy-play-registry.yml`，仅当 `play-registry/**` 变更时触发，发布网站产物到两个地方：

- GitHub Pages：发布 `play-registry/` 下的静态站内容（如 `*.html` / `docs/` / `assets/` / `games/` / `registry.json`），排除 `scripts/`、`test/`、`node_modules/`、`README.md` 和包元数据。
- 阿里云 OSS：发布同一份网站产物到 `oss://ezs-games/`，`registry.json` 最后上传。

> 首次需在 GitHub 仓库 **Settings → Pages → Source** 选 **GitHub Actions**。

OSS 复用现有仓库 Secrets：`OSS_ENDPOINT`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`。Bucket 在 workflow 中固定为 `ezs-games`，公网域名为 `https://game.undersilicon.cn/`；如需部署到 bucket 子目录，可配置 Repository Variable：`PLAY_REGISTRY_OSS_PREFIX`。

面板默认从 OSS/CDN 拉取（源 URL 见 `backend/services/gameRegistryService.js` 的 `DEFAULT_SOURCE`，可被 env `GAME_REGISTRY_URL` 或面板设置覆盖）。GitHub Pages 保留为同产物备用发布通道。
