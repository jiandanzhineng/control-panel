# 数字人（本机应用）

- 本机应用清单 `LOCAL_APP_FEED` 默认走 OSS 源 `https://ezs-firmware.oss-cn-shanghai.aliyuncs.com/apps`。卡片「更新」和「启动」分开，可直接启动本地旧版本。
- 安装校验/解压走后台线程，避免卡在 90%；启动会显示「等待服务就绪（已 N 秒）」。
- 开发态安装目录 `%APPDATA%\Electron\data\apps\digital-human\current`。
- 输出导入日志管理；stdout 模块名 `DigitalHuman`，文件 `current/tmp_launch.log`。
- 授权验证接口：数字人可通过面板已登录账号走 mimo relay（见 `docs/api/Backend_API.md`）。
- 启动进程提前退出（exit 1）的环境隔离修复只针对用户环境，不做影响正常用户的改动。
- Python 子进程强制 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`；否则中文 Windows 的管道输出可能用 GBK，异常提示中的 emoji 会再次抛错、中断开场白与规划层。
- 语音请求的旧 `mimo-v2.5` 在面板网关映射为 `mimo-v2.6-flash`；ASR/TTS 模型不变。官方 relay 的厂商密钥失效返回 `502 UPSTREAM_AUTH_FAILED`，与用户登录失效的 401 区分。
- 嵌入与一点安装：主客户端内点击即自动安装并启动。
- 打包说明写在更新文档里；改完要重新打包并验证控制面板更新、启动和版本号显示。
- 启动故障排查用 Electron debug 做实际部署测试（见 docs/guides/ELECTRON_DEBUG.md）。
