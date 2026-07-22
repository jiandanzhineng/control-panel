# 文档目录

本目录只保留当前实现文档。早期 PRD、接口草案和设计草案中与代码重复或不一致的内容，已经合并到下列权威文档。

## 推荐阅读顺序

1. [项目语境与领域语言](../CONTEXT.md)（根目录）
2. [项目架构说明](architecture/ARCHITECTURE.md)
3. [插件系统设计](architecture/PLUGIN_SYSTEM.md)
4. [内置浏览器 DeviceAPI Origin 授权](architecture/browser-deviceapi-origin-grant.md)
5. [统一游戏运行时方案设计](architecture/game-runtime-unified-design.md)
6. [产品功能说明](requirements/PRD.md)
7. [后端 API 文档](api/Backend_API.md)
8. [设备能力说明](device/capabilities.md) / [设备注册表](device/device-registry.md)
9. [游戏与玩法运行时说明](requirements/Game_Runtime.md)
10. [MQTT、EMQX、mDNS 集成说明](integration/MQTT_mDNS.md)
11. [后端运行与测试指引](guides/BACKEND_IMPLEMENTATION.md)
12. [游戏 TESTING.md 编写指南](guides/GAME_TESTING.md)
13. [Windows Electron 启动指南](guides/Windows_通过_Electron_启动指南.md) / [Electron 调试速查](guides/ELECTRON_DEBUG.md)
14. [构建打包指南](guides/Build_Package_Guide.md)
15. [架构决策记录 (ADR)](adr/)

## 目录说明

- `architecture/`：整体架构、运行模式、前后端/Electron 边界、插件系统、游戏运行时统一方案。
- `adr/`：架构决策记录（Architecture Decision Records），记录不可逆的设计取舍与结论。
- `api/`：后端 REST/SSE 接口权威说明。
- `requirements/`：产品功能范围与游戏运行时说明。
- `integration/`：MQTT Broker、EMQX、MQTT 客户端、mDNS、网络地址枚举。
- `guides/`：运行、测试、Electron 启动与调试、打包操作。
- `device/`：设备能力、设备注册表、能力调用约定。
- `plan/`：尚未落地的设计方案（待实现）。
- `agent/`：自动化开发代理使用的流程说明。`agent/update.md` 被根目录 `AGENTS.md` 引用，移动前必须同步更新引用。

根目录另有 `CONTEXT.md`（项目语境与领域语言）、`LOG_SYSTEM.md`（日志系统说明）、`AGENTS.md`（版本更新流程指引）。

## 文档清单

### Architecture

- [项目架构说明](architecture/ARCHITECTURE.md)
- [插件系统设计](architecture/PLUGIN_SYSTEM.md)
- [内置浏览器 DeviceAPI Origin 授权](architecture/browser-deviceapi-origin-grant.md)
- [统一游戏运行时方案设计](architecture/game-runtime-unified-design.md)

### ADR（架构决策记录）

- [0001 信任边界：本机即可信，bridge 不做连接认证](adr/0001-local-machine-is-trusted-no-bridge-auth.md)
- [0002 detector 注入：一次挂载 + detector 自决](adr/0002-detector-injection-once-and-self-gating.md)
- [0003 插件发现：扫描多目录（内置 + 用户）](adr/0003-plugin-discovery-multi-directory.md)
- [0004 玩法运行唯一性：全局同时只有一个玩法在跑](adr/0004-single-active-play-carrier.md)
- [0005 运行状态权威：bridge 连接即真相](adr/0005-backend-authoritative-play-state.md)

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
- [Windows Electron 启动指南](guides/Windows_通过_Electron_启动指南.md)
- [Electron 调试速查](guides/ELECTRON_DEBUG.md)

### Plan（待实现）

- [OpenPanel 埋点接入设计文档](plan/analytics-design.md)
- [玩法载体统一方案设计文档](plan/unified-play-carrier-design.md)

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
- `analytics-design.md` 迁入 [plan/](plan/)（埋点尚未落地）。
- `device-registry.md` 迁入 [device/](device/device-registry.md)。

## 维护规则

- 新增接口或修改接口行为时，优先更新 [后端 API 文档](api/Backend_API.md)。
- 修改设备能力、设备类型或 MQTT payload 映射时，同步更新 [设备能力说明](device/capabilities.md) 和 [设备注册表](device/device-registry.md)。
- 修改玩法模块契约、启动流程、SSE 事件或嵌入式 HTML 逻辑时，同步更新 [游戏与玩法运行时说明](requirements/Game_Runtime.md)。
- 修改 Electron 端口、preload 改写、静态服务或打包资源时，同步更新 `guides/` 下对应文档。
- 不可逆的架构决策，新增 ADR 到 [adr/](adr/)，并在 `CONTEXT.md` 中以 `[[adr-xxxx]]` 形式链接。
- 文档之间使用相对路径链接，不使用本机绝对路径或 `file:///` 链接。
- 避免为同一接口再新建专题 API 文档；专题文档只记录背景、流程或设计权衡，接口细节链接到权威 API 文档。
