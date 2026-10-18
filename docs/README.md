# 文档目录

本目录只保留当前实现文档。早期 PRD、接口草案和设计草案中与代码重复或不一致的内容，已经合并到下列权威文档。

## 推荐阅读顺序

1. [项目语境与领域语言](../CONTEXT.md)（根目录）
2. [项目架构说明](architecture/ARCHITECTURE.md)
3. [插件系统设计](architecture/PLUGIN_SYSTEM.md)
4. [内置浏览器 DeviceAPI Origin 授权](architecture/browser-deviceapi-origin-grant.md)
5. [统一游戏运行时方案设计](architecture/game-runtime-unified-design.md)
6. [分离式游戏标准（game-core 契约）](architecture/split-game-contract.md)
6. [产品功能说明](requirements/PRD.md)
7. [后端 API 文档](api/Backend_API.md)
8. [设备能力说明](device/capabilities.md) / [设备注册表](device/device-registry.md)
9. [游戏与玩法运行时说明](requirements/Game_Runtime.md)
10. [MQTT、EMQX、mDNS 集成说明](integration/MQTT_mDNS.md)
11. [后端运行与测试指引](guides/BACKEND_IMPLEMENTATION.md)
12. [游戏 TESTING.md 编写指南](guides/GAME_TESTING.md)
13. [Windows Electron 启动指南](guides/Windows_通过_Electron_启动指南.md) / [Electron 调试速查](guides/ELECTRON_DEBUG.md)
14. [构建打包指南](guides/Build_Package_Guide.md)
15. [创作者月度分成运营指南（管理员）](guides/creator-payout-guide.md)
16. [架构决策记录 (ADR)](adr/)

## 目录说明

- `architecture/`：整体架构、运行模式、前后端/Electron 边界、插件系统、游戏运行时统一方案、分离式游戏标准。
- `adr/`：架构决策记录（Architecture Decision Records），记录不可逆的设计取舍与结论。
- `api/`：后端 REST/SSE 接口权威说明。
- `requirements/`：产品功能范围与游戏运行时说明。
- `integration/`：MQTT Broker、EMQX、MQTT 客户端、mDNS、网络地址枚举。
- `guides/`：运行、测试、Electron 启动与调试、打包操作、运营流程。
- `device/`：设备能力、设备注册表、能力调用约定。
- `plans/`：尚未落地的设计方案（待实现）。
- `agent/`：自动化开发代理使用的流程说明。`agent/update.md` 被根目录 `AGENTS.md` 引用，移动前必须同步更新引用。

根目录另有 `CONTEXT.md`（项目语境与领域语言）、`LOG_SYSTEM.md`（日志系统说明）、`AGENTS.md`（版本更新流程指引）。

## 文档清单

### Architecture

- [项目架构说明](architecture/ARCHITECTURE.md)
- [插件系统设计](architecture/PLUGIN_SYSTEM.md)
- [内置浏览器 DeviceAPI Origin 授权](architecture/browser-deviceapi-origin-grant.md)
- [统一游戏运行时方案设计](architecture/game-runtime-unified-design.md)
- [分离式游戏标准（game-core 契约）](architecture/split-game-contract.md)

### ADR（架构决策记录）

- [2026-07-02-backend-authoritative-play-state](adr/2026-07-02-backend-authoritative-play-state.md)
- [2026-07-02-detector-injection-once-and-self-gating](adr/2026-07-02-detector-injection-once-and-self-gating.md)
- [2026-07-02-local-machine-is-trusted-no-bridge-auth](adr/2026-07-02-local-machine-is-trusted-no-bridge-auth.md)
- [2026-07-02-plugin-discovery-multi-directory](adr/2026-07-02-plugin-discovery-multi-directory.md)
- [2026-07-02-single-active-play-carrier](adr/2026-07-02-single-active-play-carrier.md)
- [2026-08-06-backend-owns-serial-connections](adr/2026-08-06-backend-owns-serial-connections.md)
- [2026-08-06-base-mac-is-the-device-id](adr/2026-08-06-base-mac-is-the-device-id.md)
- [2026-08-06-ble-identity-exposes-mac-and-firmware-version](adr/2026-08-06-ble-identity-exposes-mac-and-firmware-version.md)
- [2026-08-06-legacy-ble-falls-back-to-browser-device-id](adr/2026-08-06-legacy-ble-falls-back-to-browser-device-id.md)
- [2026-08-06-serial-handshake-device-identity](adr/2026-08-06-serial-handshake-device-identity.md)
- [2026-08-06-single-control-connection-per-physical-device](adr/2026-08-06-single-control-connection-per-physical-device.md)
- [2026-08-17-check-update-feedback-and-stable-on-test](adr/2026-08-17-check-update-feedback-and-stable-on-test.md)
- [2026-08-17-digital-human-embedded-one-click](adr/2026-08-17-digital-human-embedded-one-click.md)
- [2026-08-17-local-account-for-digital-human](adr/2026-08-17-local-account-for-digital-human.md)
- [2026-08-18-device-list-always-auto-refresh](adr/2026-08-18-device-list-always-auto-refresh.md)
- [2026-08-18-digital-human-output-in-logs](adr/2026-08-18-digital-human-output-in-logs.md)
- [2026-08-18-digital-human-pack-in-update-doc](adr/2026-08-18-digital-human-pack-in-update-doc.md)
- [2026-08-18-first-close-asks-tray-or-quit](adr/2026-08-18-first-close-asks-tray-or-quit.md)
- [2026-08-18-local-app-env-isolation](adr/2026-08-18-local-app-env-isolation.md)
- [2026-08-18-local-app-progress-and-ui-freeze](adr/2026-08-18-local-app-progress-and-ui-freeze.md)
- [2026-08-18-local-app-update-start-split](adr/2026-08-18-local-app-update-start-split.md)
- [2026-08-18-mqtt-log-merge-topic](adr/2026-08-18-mqtt-log-merge-topic.md)
- [2026-08-18-serial-auto-connect-in-dialog](adr/2026-08-18-serial-auto-connect-in-dialog.md)
- [2026-08-18-upload-diagnostic-logs](adr/2026-08-18-upload-diagnostic-logs.md)
- [2026-08-18-voice-hub-in-panel](adr/2026-08-18-voice-hub-in-panel.md)
- [2026-08-18-xiaoya-separate-window](adr/2026-08-18-xiaoya-separate-window.md)
- [2026-08-18-xiaoya-window-title-and-login](adr/2026-08-18-xiaoya-window-title-and-login.md)
- [2026-08-26-brand-ble-identity-browser-id](adr/2026-08-26-brand-ble-identity-browser-id.md)
- [2026-08-26-brand-capability-inventory](adr/2026-08-26-brand-capability-inventory.md)
- [2026-08-26-brand-page-keeps-test-control](adr/2026-08-26-brand-page-keeps-test-control.md)
- [2026-08-26-brand-strength-align-0-255](adr/2026-08-26-brand-strength-align-0-255.md)
- [2026-08-26-cup-own-type-and-strength](adr/2026-08-26-cup-own-type-and-strength.md)
- [2026-08-26-cup-strength-maps-stroke-and-vibe](adr/2026-08-26-cup-strength-maps-stroke-and-vibe.md)
- [2026-08-26-fjb03-six-byte-motor-frame](adr/2026-08-26-fjb03-six-byte-motor-frame.md)
- [2026-08-27-brand-ble-auto-connect-all](adr/2026-08-27-brand-ble-auto-connect-all.md)
- [2026-08-27-brand-ble-auto-connect-saved](adr/2026-08-27-brand-ble-auto-connect-saved.md)
- [2026-08-27-brand-ble-mac-device-id](adr/2026-08-27-brand-ble-mac-device-id.md)
- [2026-08-27-brand-ble-unified-scan](adr/2026-08-27-brand-ble-unified-scan.md)
- [2026-08-27-brand-tab-unified-connect](adr/2026-08-27-brand-tab-unified-connect.md)
- [2026-08-28-sosexy-is-fanye-bobobei](adr/2026-08-28-sosexy-is-fanye-bobobei.md)
- [2026-08-28-sosexy-pid0004-capability-mapping](adr/2026-08-28-sosexy-pid0004-capability-mapping.md)
- [2026-08-28-support-list-no-webble](adr/2026-08-28-support-list-no-webble.md)
- [2026-08-29-event-start-via-lock-button](adr/2026-08-29-event-start-via-lock-button.md)
- [2026-08-29-i18n-p0-p1-and-game-locale](adr/2026-08-29-i18n-p0-p1-and-game-locale.md)
- [2026-08-30-wired-flash-behavior](adr/2026-08-30-wired-flash-behavior.md)
- [2026-08-31-gxp-ailuo2-third-party-ble](adr/2026-08-31-gxp-ailuo2-third-party-ble.md)
- [2026-08-31-voice-assistant-client-module](adr/2026-08-31-voice-assistant-client-module.md)
- [2026-09-04-baidu-tongji-game-no-admin](adr/2026-09-04-baidu-tongji-game-no-admin.md)
- [2026-09-04-game-i18n-zh-as-key](adr/2026-09-04-game-i18n-zh-as-key.md)
- [2026-09-04-game-platform-first-phase](adr/2026-09-04-game-platform-first-phase.md)
- [2026-09-04-game-platform-mobile-auth](adr/2026-09-04-game-platform-mobile-auth.md)
- [2026-09-04-game-site-home-and-login](adr/2026-09-04-game-site-home-and-login.md)
- [2026-09-05-app-update-auto-closes-running-client](adr/2026-09-05-app-update-auto-closes-running-client.md)
- [2026-09-05-dan01-attitude-monitor](adr/2026-09-05-dan01-attitude-monitor.md)
- [2026-09-05-desktop-performance-and-release-checks](adr/2026-09-05-desktop-performance-and-release-checks.md)
- [2026-09-05-game-platform-shop-cohost-isolated](adr/2026-09-05-game-platform-shop-cohost-isolated.md)
- [2026-09-05-i18n-p2-site-and-game-ui](adr/2026-09-05-i18n-p2-site-and-game-ui.md)
- [2026-09-05-monitor-refresh-on-change](adr/2026-09-05-monitor-refresh-on-change.md)
- [2026-09-09-play-stats-openpanel](adr/2026-09-09-play-stats-openpanel.md)
- [2026-09-12-device-batch-control](adr/2026-09-12-device-batch-control.md)
- [2026-09-14-brand-ble-scan-button](adr/2026-09-14-brand-ble-scan-button.md)
- [2026-09-14-brand-ble-scan-once](adr/2026-09-14-brand-ble-scan-once.md)
- [2026-09-15-ble-auto-scan-quiet-logs](adr/2026-09-15-ble-auto-scan-quiet-logs.md)
- [2026-09-15-dglab-brand-estim](adr/2026-09-15-dglab-brand-estim.md)
- [2026-09-15-dglab-v3-ble](adr/2026-09-15-dglab-v3-ble.md)
- [2026-09-15-fjb01-enema-official-frames](adr/2026-09-15-fjb01-enema-official-frames.md)
- [2026-09-15-game-author-edit-review](adr/2026-09-15-game-author-edit-review.md)
- [2026-09-23-js-game-core-outside-webview](adr/2026-09-23-js-game-core-outside-webview.md)
- [2026-09-23-remote-game-client-control](adr/2026-09-23-remote-game-client-control.md)
- [2026-09-29-game-original-ui](adr/2026-09-29-game-original-ui.md)
- [2026-09-29-pushup-single-motor-output](adr/2026-09-29-pushup-single-motor-output.md)
- [2026-09-30-brand-ble-native-noble](adr/2026-09-30-brand-ble-native-noble.md)
- [2026-10-01-host-runtime-keeps-game-logic](adr/2026-10-01-host-runtime-keeps-game-logic.md)
- [2026-10-06-creator-payout-manual](adr/2026-10-06-creator-payout-manual.md)
- [2026-10-06-game-id-no-duplicate](adr/2026-10-06-game-id-no-duplicate.md)
- [2026-10-06-submission-source-retention](adr/2026-10-06-submission-source-retention.md)
- [2026-10-07-virtual-hrm-c3-mock](adr/2026-10-07-virtual-hrm-c3-mock.md)
- [2026-10-08-heart-rate-capability](adr/2026-10-08-heart-rate-capability.md)
- [2026-10-13-voice-start-trigger](adr/2026-10-13-voice-start-trigger.md)

### Requirements

- [产品功能说明](requirements/PRD.md)
- [游戏与玩法运行时说明](requirements/Game_Runtime.md)

### API

- [后端 API 文档（当前实现）](api/Backend_API.md)

### Device

- [设备能力说明](device/capabilities.md)
- [设备注册表](device/device-registry.md)

### Integration

- [MQTT、EMQX、mDNS 集成说明](integration/MQTT_mDNS.md)

### Guides

- [后端运行与测试指引](guides/BACKEND_IMPLEMENTATION.md)
- [游戏 TESTING.md 编写指南](guides/GAME_TESTING.md)
- [构建打包指南](guides/Build_Package_Guide.md)
- [创作者月度分成运营指南（管理员）](guides/creator-payout-guide.md)
- [Windows Electron 启动指南](guides/Windows_通过_Electron_启动指南.md)
- [Electron 调试速查](guides/ELECTRON_DEBUG.md)

### Plan（待实现）

- [OpenPanel 埋点接入设计文档](plans/analytics-design.md)
- [玩法载体统一方案设计文档](plans/unified-play-carrier-design.md)
- [MQTT / 串口 / BLE 统一设备连接实施计划](plans/2026-08-05-unified-mqtt-serial-ble-device-connections.md)
- [st-iot-bridge 融入决策 map](plans/wayfinder-st-iot-bridge-merge.md)
- [provision 服务迁移（暂缓）](plans/2026-08-04-provision-migration-deferred.md)
- [PC 端远程游戏与逻辑分离改动方案](plans/remote-game-host-implementation-plan.md)
- [游戏投稿平台总体架构](plans/game-platform-architecture.md)
- 完整清单见 [plans/README.md](plans/README.md)

### Agent

- [版本更新流程](agent/update.md)
- [游戏测试流程](agent/游戏测试.md)

## 合并记录

- `DeviceManagement_API.md`、`GameList_Backend_API.md` 已合并到 [后端 API 文档](api/Backend_API.md)。
- `PRD_GameList.md`、`PRD_GameplayService.md`、`PRD_GameStartConfig.md`、`PRD_GameUI_SSE.md`、`PRD_EmbeddedHTML_SSE.md`、`PRD_Backend_API_EmbeddedHTML_SSE.md` 已合并到 [游戏与玩法运行时说明](requirements/Game_Runtime.md) 和 [后端 API 文档](api/Backend_API.md)。
- `CustomGame_Design.md` 已合并到 [游戏与玩法运行时说明](requirements/Game_Runtime.md)。
- `DeviceTypes_Enhancement_Design.md` 已合并到 [设备能力说明](device/capabilities.md) 和 [后端 API 文档](api/Backend_API.md)。
- `LogSystem_Design.md` 已合并到 [后端 API 文档](api/Backend_API.md)。
- `EMQX_Integration.md`、`mDNS_Service_Integration.md` 已合并到 [MQTT、EMQX、mDNS 集成说明](integration/MQTT_mDNS.md)。
- `game-config-runtime-plan.md`、`game-runtime-coverage-review.md`（一次性改造方案，已落地）、`virtual-device-testing.html`（设计稿，已实现）已删除。
- `game-runtime-unified-design.html` 已转换为 [game-runtime-unified-design.md](architecture/game-runtime-unified-design.md)。
- `analytics-design.md` 迁入 [plans/](plans/)（埋点尚未落地）。
- `device-registry.md` 迁入 [device/](device/device-registry.md)。

## 维护规则

- 新增接口或修改接口行为时，优先更新 [后端 API 文档](api/Backend_API.md)。
- 修改设备能力、设备类型或 MQTT payload 映射时，同步更新 [设备能力说明](device/capabilities.md) 和 [设备注册表](device/device-registry.md)。
- 修改玩法模块契约、启动流程、SSE 事件或嵌入式 HTML 逻辑时，同步更新 [游戏与玩法运行时说明](requirements/Game_Runtime.md)。
- 修改 Electron 端口、preload 改写、静态服务或打包资源时，同步更新 `guides/` 下对应文档。
- 不可逆的架构决策，新增 ADR 到 [adr/](adr/)（文件名 `YYYY-MM-DD-<slug>.md`），并在 `CONTEXT.md` 中以 `[[<slug>]]` 形式链接。索引见 [adr/INDEX.md](adr/INDEX.md)。
- 文档之间使用相对路径链接，不使用本机绝对路径或 `file:///` 链接。
- 避免为同一接口再新建专题 API 文档；专题文档只记录背景、流程或设计权衡，接口细节链接到权威 API 文档。
