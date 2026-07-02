# 插件发现：扫描多目录（内置 + 用户），为未来 zip 安装留位

**背景**：插件包是含独立 `detector.js`（要当 webview preload 以真实文件路径加载）的目录。打包配置里 `backend/**` 进只读 asar，`extraResources` 把目录复制到 `resources/` 当真实可写文件。未来希望支持类似浏览器插件的 zip 动态安装。

**决定**：
1. **内置插件**放 `backend/plugins/<id>/`，打包时经 `extraResources` 复制到 `resources/plugins/`（真实路径，detector 可作 preload 加载，规避 asar 内 preload 无法加载的问题）。
2. **`pluginService.listPlugins()` 从一开始就扫描一个目录列表**：内置目录（开发态 `backend/plugins/`，打包态 `resources/plugins/`）+ 用户目录 `userData/plugins/`（初期可为空）。合并成一个插件列表。
3. detector 路径一律按"插件所在目录的绝对路径"计算，不硬编码 `backend/plugins`。

**为什么**：现在按"插件可来自多目录"设计几乎零成本；若只扫单目录，未来加 zip 安装要改发现逻辑、路径解析等核心。用户后装插件必须落在可写且升级不丢的 userData，不能进 `resources/`（无写权限、升级被覆盖）。

**后果**：未来 zip 安装只是"解压到 `userData/plugins/<id>/` + 校验 manifest"，detector 走同一套注入逻辑，不碰框架。zip 解压/校验/安装 UI 属未来功能，当前不实现，但目录抽象已为其留位。关联 [[0002-detector-injection-once-and-self-gating]]。
