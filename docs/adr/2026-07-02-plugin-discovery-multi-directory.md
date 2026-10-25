---
date: 2026-07-02
summary: 插件发现扫描内置与用户多目录，为未来 zip 安装留位
---

# 插件发现：扫描多目录（内置 + 用户）

1. 内置插件放 `backend/plugins/<id>/`，打包经 `extraResources` 复制到 `resources/plugins/`，保证 detector 能以真实路径作 preload。
2. `pluginService.listPlugins()` 从一开始就扫描目录列表：内置目录 + `userData/plugins/`，合并成列表。
3. detector 路径按插件所在目录的绝对路径计算，不硬编码。

理由：多目录现在几乎零成本；用户后装插件必须落在可写且升级不丢的 userData。

后果：未来 zip 安装只需解压到 `userData/plugins/<id>/` 并校验 manifest；当前不实现安装 UI。
