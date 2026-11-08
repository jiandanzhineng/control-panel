# 速查索引

agent 查到的事实、配置位置、命令、踩坑。按主题，详情在 `docs/note/`。

## 环境与工具

- 源码版本以根 package.json 为准；版本更新流程 `docs/agent/update.md`；未打包安装版路径与测试端口见 [local-env](note/local-env.md)。
- 一键检查 `npm run check`；各套件命令、worktree 的 node_modules 处理见 [dev-testing](note/dev-testing.md)。
- 本机 MQTT 客户端查询、面板在线设备接口在 [local-env](note/local-env.md)。

## 游戏运行时

- HostRuntime 模块、JS Core 契约、`/api/game-runtime` 与原始 UI 托管渲染见 [host-runtime](note/host-runtime.md)。
- 远程游戏测试环境、虚拟设备检查路径、无头验证方法见 [remote-game-testing](note/remote-game-testing.md)。
- 背单词词库由 ECDICT 生成，脚本用法、字段、统计与许可证见 [vocab-bank](note/vocab-bank.md)。

## 远程会话

- 设备投影会话：房间码、`/drecv` 抓包、急停链路、SSE 统计等复用要点见 [remote-session](note/remote-session.md)。
- 2026-10-06 加固内容与 5 个已知缺陷见 [remote-session-hardening](note/remote-session-hardening.md)。

## 语音

- 语音开始的入口、模型文件、WS 路由见 [voice-start](note/voice-start.md)。
- 口令 tokens 生成、选型数据、识别参数见 [voice-start-phrase-model](note/voice-start-phrase-model.md)。
- 测试音频、假麦克风、CDP 截图坑、单测清单见 [voice-start-testing](note/voice-start-testing.md)。
- 语音渠道设置与客户端语音助手见 [voice-hub](note/voice-hub.md)。

## 设备

- 串口连接、握手身份、设备 ID 规则、烧录复位见 [devices-serial-flash](note/devices-serial-flash.md)。
- 品牌 BLE（noble 直连）日志、自动连接设置、能力清单见 [brand-devices](note/brand-devices.md)。
- 役次元、SOSEXY、GXP、郊狼、FJB 的 GATT 与帧格式见 [device-hardware](note/device-hardware.md)。
- ESP32-C3 虚拟心率带部署、命令与坑见 [hrm-c3-mock](note/hrm-c3-mock.md)。

## 游戏平台

- PC 游戏库页（本机+在线合并、游戏站嵌入）的文件位置与数据源见 [game-library](note/game-library.md)。

- 背单词离线固定口令、PC 采集桥和回归入口见 [vocab-commands](note/vocab-commands.md)。
- PC/游戏站的手机号身份、迁移与本地验收：见 [手机号登录](note/phone-login.md)。

- 生产服务器、发版回滚、OSS 与缓存规则见 [game-platform-deploy](note/game-platform-deploy.md)。
- 创作者分成表结构、接口、game_id 归属优先级见 [creator-payout](note/creator-payout.md)。
- 站点页面入口、百度统计、游戏条目约定见 [site-games](note/site-games.md)。

## 客户端与桌面

- 窗口托盘、小雅窗口、更新、设备页行为见 [desktop-client](note/desktop-client.md)。
- Agent 控制接口（全局事件流、客户端窗口/路由/截图/启动游戏、能力参数范围）见 [agent-control-api](note/agent-control-api.md)。
- 数字人安装目录、更新启动、日志与打包见 [digital-human](note/digital-human.md)。
- 面板与游戏 i18n 约定见 [i18n](note/i18n.md)。

## 其他

- 跨项目工具与备份（smart-backup、BLE 扫描工具、AlibabaProtect 守卫、memory-index）在 `E:/smart/tools/`，根层 `docs/note.md` 有索引。

## 统计与诊断

- OpenPanel 事件、导出凭证位置、`tools/op-stats.ps1` 用法见 [analytics](note/analytics.md)。
- 诊断日志上传链路、国内库查询见 [diagnostics](note/diagnostics.md)。

- 登录布局与PC微信扫码：见 [登录布局](note/login-layout.md)。
