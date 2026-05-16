# 构建打包指南

本文按当前根目录 `package.json` 的脚本和 `electron-builder` 配置整理。

## 常用命令

```powershell
npm run build:frontend
npm run build
npm run build:win
npm run build:installer
```

含义：

- `build:frontend`：执行 `npm --prefix frontend run build`。
- `build`：先构建前端，再执行 `electron-builder --dir`。
- `build:win`：先构建前端，再执行 `electron-builder --win --dir`。
- `build:installer`：先构建前端，再执行 `electron-builder --win nsis --x64 --publish=never`。

## 前端构建

`frontend/package.json` 的构建命令：

```powershell
vue-tsc --noEmit && vite build
```

Vite 生产构建使用相对资源路径：

```ts
base: command === 'build' ? './' : '/'
```

产物目录为 `frontend/dist`。

## Electron Builder 配置

当前产品信息：

- `appId`: `com.controlpanel.app`
- `productName`: `UnderSilicon`
- `artifactName`: `${productName}-Setup-${version}.${ext}`
- 输出目录：`dist`

Windows 目标：

- NSIS
- x64
- 图标：`assets/icon.ico`

NSIS 配置：

- `oneClick: false`
- `allowToChangeInstallationDirectory: true`
- `allowElevation: true`
- `createDesktopShortcut: true`
- `createStartMenuShortcut: true`
- `shortcutName: UnderSilicon`

## 打包包含内容

`files` 包含：

- `electron/**/*`
- `backend/**/*`
- `frontend/dist/**/*`
- `backend/node_modules/**/*`
- `node_modules/**/*`

排除：

- `backend/logs`
- `backend/data`
- `backend/tests`
- `backend/test_*.js`
- `backend/.gitignore`

`extraResources` 包含：

- `backend/inner-tools` -> `resources/inner-tools`
- `backend/game` -> `resources/game`

## 发布配置

`publish` 配置为 GitHub：

- owner: `jiandanzhineng`
- repo: `control-panel`

`build:installer` 显式带 `--publish=never`，不会自动发布。

GitHub Actions 按 tag 区分发布渠道：

- 正式版 tag：`v1.0.28`，发布到 GitHub Release，并上传更新文件到 OSS `stable/` 目录。
- 测试版 tag：`v1.0.28-beta.1`，发布为 GitHub prerelease，并上传更新文件到 OSS `test/` 目录。

上传到 OSS 的自动更新文件包括：

- `dist/*.exe`
- `dist/*.blockmap`
- `dist/latest.yml`
- `dist/UnderSilicon.zip`
- `dist/control-panel-*.zip`

固定名称安装包压缩包：

- `UnderSilicon.zip` 内只包含当前版本安装包，例如 `UnderSilicon-Setup-1.0.28.exe`。
- 正式版固定下载地址：`https://ezs-firmware.oss-cn-shanghai.aliyuncs.com/control-panel/stable/UnderSilicon.zip`。
- 测试版固定下载地址：`https://ezs-firmware.oss-cn-shanghai.aliyuncs.com/control-panel/test/UnderSilicon.zip`。
- `latest.yml` 仍指向版本化 exe，固定 zip 只作为人工下载入口，不替代自动更新文件。

源码压缩包随每次 tag 发布生成：

- 正式版：`control-panel-stable.zip`，上传到 `control-panel/stable/`。
- 测试版：`control-panel-test.zip`，上传到 `control-panel/test/`。
- 压缩包顶层目录固定为 `control-panel-main/`，用于兼容 `sh/run_control_panel.sh` 的命令行部署流程。

OSS 上传依赖仓库 secrets：`OSS_ENDPOINT`、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_PREFIX`。当前控制面板更新目录建议将 `OSS_PREFIX` 配置为 `control-panel`。

## 打包后运行模型

打包应用启动后：

- 后端监听 `127.0.0.1:5278`。
- 前端静态服务监听 `127.0.0.1:5277`。
- API 调用通过静态服务代理或 preload 改写到后端。
- 数据目录使用 Electron `userData/data`。
- 日志目录使用 Electron `userData/logs`。

更多启动细节见 [Windows Electron 启动指南](Windows_通过_Electron_启动指南.md)。
