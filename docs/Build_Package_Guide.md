# 构建打包指南

## 概述

本文档说明如何为 Control Panel 项目增加打包安装包的构建方式，生成可分发的 Windows 安装程序。

## 当前构建配置分析

项目已配置基础的 electron-builder 构建环境：

- 已安装 `electron-builder` 依赖
- 配置了基本的构建选项
- 支持 Windows 平台构建

## 新增构建脚本

### 1. 修改 package.json 脚本

在根目录 `package.json` 的 `scripts` 部分添加以下脚本：

```json
{
  "scripts": {
    "build:installer": "npm run build:frontend && electron-builder --win nsis --x64 --publish=never"
  }
}
```

### 2. 更新构建配置

修改 `package.json` 中的 `build` 配置：

```json
{
  "build": {
    "appId": "com.controlpanel.app",
    "productName": "Control Panel",
    "directories": {
      "output": "dist"
    },
    "files": [
      "electron/**/*",
      "backend/**/*",
      "frontend/dist/**/*",
      "node_modules/**/*",
      "backend/node_modules/**/*"
    ],
    "extraResources": [
      {
        "from": "backend/inner-tools",
        "to": "inner-tools",
        "filter": [
          "**/*"
        ]
      },
      {
        "from": "backend/game",
        "to": "game",
        "filter": [
          "**/*"
        ]
      }
    ],
    "win": {
      "target": [
        {
          "target": "nsis",
          "arch": ["x64"]
        }
      ],
      "icon": "assets/icon.ico"
    },
    "nsis": {
      "oneClick": true,
      "allowToChangeInstallationDirectory": true,
      "allowElevation": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "Control Panel"
    }
  }
}
```

## 构建流程说明

### 构建步骤

1. **前端构建**: `npm run build:frontend` - 构建 Vue 前端应用
2. **打包**: `electron-builder --win nsis` - 使用 NSIS 创建 Windows 安装程序
3. **发布控制**: `--publish=never` - 不自动发布到远程仓库

### 输出文件

- 安装程序将生成在 `dist/` 目录
- 文件名格式: `Control Panel Setup 1.0.0.exe`

## 使用方法

### 构建安装包

```bash
npm run build:installer
```

## 配置选项说明

### NSIS 配置

- `oneClick: true` - 启用一键安装模式
- `allowToChangeInstallationDirectory: true` - 允许更改安装目录
- `allowElevation: true` - 允许管理员权限安装
- `createDesktopShortcut: true` - 创建桌面快捷方式
- `createStartMenuShortcut: true` - 创建开始菜单快捷方式

### 目标平台

- `target: "nsis"` - 使用 NSIS 安装程序格式
- `arch: ["x64"]` - 支持 64位架构

## 注意事项

1. **图标文件**: 建议添加应用图标文件 `assets/icon.ico`
2. **文件包含**: 确保所有必要文件都在 `files` 配置中
3. **额外资源**: `extraResources` 配置用于包含特殊工具和游戏文件
   - `backend/inner-tools/mdns_tool.exe` - mDNS 工具可执行文件
   - `backend/game/` - 游戏相关文件
4. **依赖管理**: 后端依赖需要正确包含在构建中
5. **测试**: 构建后应测试安装程序的完整功能

## 扩展配置

### 添加应用图标

1. 创建 `assets/` 目录
2. 添加 `icon.ico` 文件 (256x256 像素)
3. 更新构建配置中的图标路径

##### 构建优化

### 额外资源配置
- `extraResources` 用于包含运行时需要的特殊文件
- 这些文件会被复制到应用安装目录的 `resources` 文件夹
- 包含 mDNS 工具和游戏文件，确保应用功能完整

### 减小包体积

- 排除不必要的文件
- 使用 `extraFiles` 配置额外资源
- 优化依赖包含策略

### 性能优化

- 启用代码压缩
- 配置合适的构建目标
- 优化资源加载