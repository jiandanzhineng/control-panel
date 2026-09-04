# play-registry（游戏网站）

`play-registry/` 是部署到 OSS/CDN 的纯静态游戏网站。普通玩家与 Control Panel 只读取公开的 `registry.json`、游戏资源和 ZIP；它们不访问投稿后端。

投稿工作台 `submit.html` 和审核后台 `admin.html` 也是静态页面。它们使用 mobile API 的账号登录，并将 Bearer Token 交给 `game-api.undersilicon.cn` 校验低频投稿与审核操作；没有运行时 SSR。

## 目录结构

```text
index.html                         游戏网站首页
submit.html / admin.html           投稿与人工审核静态页面
assets/css/site.css                网站样式
assets/js/platform-config.js       API 域名配置
assets/js/submission.js            mobile 登录、投稿与 OSS 直传逻辑
assets/js/admin.js                 mobile 会话下的审核操作逻辑
docs/                               游戏开发与投稿说明
scripts/build-registry.js          旧本地/测试用 registry 构建工具
test/                               静态构建工具测试
```

正式 `registry.json`、`games/` 和 `packages/` 均由 `../game-platform` 的批准发布操作写入 OSS，不再由 GitHub Actions、PR 或此目录的构建脚本发布。旧构建脚本保留给本地联调和兼容性测试，不能用于生产写入。

## 本地静态站验证

```bash
cd play-registry
npm test
npm run serve
```

本地联调默认调用游戏平台 `http://127.0.0.1:8787` 和 mobile API `http://127.0.0.1:3000`。生产发布前在 `assets/js/platform-config.js` 同时确认这两个 HTTPS API 域名。登录凭证只存于当前浏览器会话的 `sessionStorage`。

## 游戏投稿

开发者可以：

1. 将游戏根目录（含 `index.html` 和内联 `game-manifest`）打成 ZIP，在网站直接上传。
2. 提交一个公开 HTTPS GitHub/GitLab 仓库地址。平台只保存地址，不保存 commit；审核员批准时才读取当时内容。

ZIP 先由浏览器持临时签名直接上传到私有 OSS 隔离区。审核通过后，平台校验压缩包、生成不可变游戏文件与离线 ZIP，最后更新公开 `registry.json`。客户端从 registry 读取 `packageUrl` 和哈希后下载，不会在运行时访问 Git 地址。

## 静态页面部署

根目录 `.github/workflows/deploy-play-registry.yml` 只发布网站壳到 `oss://ezs-games/`，并明确排除 `registry.json`、`games/` 与 `packages/`。它可以继续用于更新首页、文档和投稿界面，但不会覆盖平台服务的发布结果。

平台服务的部署、OSS CORS、私有投稿 bucket 与首次导入旧 registry 的操作见：

`../game-platform/README.md`
