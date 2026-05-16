1. 默认分支和指令语义
   - 日常开发直接提交到 develop，不需要 PR。
   - 收到“发版”指令时，默认发布测试版，在 develop 分支执行。
   - 收到“发布正式版”指令时，发布正式版，先将 develop 合并或 PR 到 main，再在 main 分支执行。
2. 修改 package.json 中的 version 为新的版本号。
   - 发测试版：如果当前版本是普通版本号，例如 1.0.28，则改为 1.0.28-beta.1。
   - 发测试版：如果当前版本已经是 beta，例如 1.0.28-beta.1，则改为 1.0.28-beta.2。
   - 发布正式版：无论当前是否为 beta，都去掉 beta 并将版本号加一，例如 1.0.28-beta.3 或 1.0.28 都改为 1.0.29。
3. 将同一个版本号同步修改到 frontend\package.json 和 backend\package.json 中的 version。
4. 提交修改后的代码。
5. 新增新版本号的 tag。
   - 测试版 tag 例如 version 为 1.0.28-beta.1，tag 为 v1.0.28-beta.1。
   - 正式版 tag 例如 version 为 1.0.29，tag 为 v1.0.29。
6. 推送修改和新版本号 tag。
   - 测试版 tag 必须从 develop 可达。
   - 正式版 tag 必须从 main 可达。
7. GitHub Actions 会自动构建发布文件并上传到 OSS。
   - 测试版更新文件上传到 control-panel/test/。
   - 正式版更新文件上传到 control-panel/stable/。
   - 正式版和测试版都会额外生成固定名称安装包压缩包 UnderSilicon.zip，里面包含当前版本的 UnderSilicon-Setup-<version>.exe。
   - 正式版固定安装包下载地址为 https://ezs-firmware.oss-cn-shanghai.aliyuncs.com/control-panel/stable/UnderSilicon.zip。
   - 测试版固定安装包下载地址为 https://ezs-firmware.oss-cn-shanghai.aliyuncs.com/control-panel/test/UnderSilicon.zip。
   - 每次发布都会额外生成源码压缩包 control-panel-test.zip 或 control-panel-stable.zip。
   - sh/run_control_panel.sh 默认下载 http://firmware.undersilicon.cn/control-panel/stable/control-panel-stable.zip。
