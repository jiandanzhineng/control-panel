# 计划文档目录（docs/plan）

本目录存放尚在设计/待实施阶段的方案文档。每份文档描述一项功能或重构的背景、设计与实施计划，供实施时作为执行基准。

| 文档 | 主题 | 状态 |
| --- | --- | --- |
| [2026-07-21-game-common-js-runtime.md](2026-07-21-game-common-js-runtime.md) | 为游戏提供类似 DeviceAPI 的统一 common JS，首期承载语音播放器，后续按准入规则扩展跨游戏能力 | 待实施 |
| [2026-07-21-game-voice-review-and-remediation.md](2026-07-21-game-voice-review-and-remediation.md) | 三款内置游戏的配音内容、播放互斥、触发时机、原玩法回归与资源测试修复计划 | 代码实施完成，待人工实机试听 |
| [2026-07-20-qtz-tiptoe-capability-value-contract.md](2026-07-20-qtz-tiptoe-capability-value-contract.md) | QTZ 踮脚压力接入与**能力可读值契约重构（T2）**：让玩法读「能力的归一化语义值」而非裸设备属性名，QTZ 用 `button0/button1` 派生踮脚压力，跨端（PC/手机）同构 | 待实施 |
| [unified-play-carrier-design.md](unified-play-carrier-design.md) | **玩法载体统一方案**：把「游戏」与「插件」统一为「玩法（Play）」的两种载体，统一侧边栏入口、列表/配置/运行界面 | 待审阅 |
| [2026-08-04-st-iot-bridge-decoupling.md](2026-08-04-st-iot-bridge-decoupling.md) | **st-iot-bridge 解耦**：主仓仅搬入 provision 服务 + inner-tools，插件改走 WS + HTTP 调主仓，删除副仓副本 | 已被 wayfinder 取代 |
| [wayfinder-st-iot-bridge-merge.md](wayfinder-st-iot-bridge-merge.md) | **st-iot-bridge 融入决策 map**：4 张票答案（窗口形态 / 配置归属 / 酒馆安装 / HUD 处理） | 已 resolve，可 handoff |
| [2026-08-04-st-iot-bridge-merge-spec.md](2026-08-04-st-iot-bridge-merge-spec.md) | **st-iot-bridge 融入实施 Spec**：旧方案将小念和酒馆逻辑融入主客户端 | 已废弃，被独立仓库方案取代 |
| [2026-08-04-external-device-watchdog.md](2026-08-04-external-device-watchdog.md) | **外部客户端设备看门狗**：小念、酒馆按客户端刷新倒计时，任一租约过期或主动退出时全设备停止 | 已实施，mock-tested |
| [2026-08-04-provision-migration-deferred.md](2026-08-04-provision-migration-deferred.md) | **provision 服务迁移（暂缓）**：详细方案 + 3 个待拍板风险点 + 验证清单，晚点另行处置 | 暂缓 |
| [analytics-design.md](analytics-design.md) | **OpenPanel 埋点接入设计**：接入产品分析，了解功能使用率、设备数、游戏与固件升级使用情况 | 待审阅 |
