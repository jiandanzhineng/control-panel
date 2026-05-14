# 文档目录

本目录只保留当前实现文档。早期 PRD、接口草案和设计草案中与代码重复或不一致的内容，已经合并到下列权威文档。

## 推荐阅读顺序

1. [项目架构说明](architecture/ARCHITECTURE.md)
2. [产品功能说明](requirements/PRD.md)
3. [后端 API 文档](api/Backend_API.md)
4. [设备能力说明](device/capabilities.md)
5. [游戏与玩法运行时说明](requirements/Game_Runtime.md)
6. [MQTT、EMQX、mDNS 集成说明](integration/MQTT_mDNS.md)
7. [后端运行与测试指引](guides/BACKEND_IMPLEMENTATION.md)
8. [Windows Electron 启动指南](guides/Windows_通过_Electron_启动指南.md)
9. [构建打包指南](guides/Build_Package_Guide.md)

## 目录说明

- `architecture/`：整体架构、运行模式、前后端/Electron 边界。
- `api/`：后端 REST/SSE 接口权威说明。
- `requirements/`：产品功能范围与游戏运行时说明。
- `integration/`：MQTT Broker、EMQX、MQTT 客户端、mDNS、网络地址枚举。
- `guides/`：运行、测试、Electron 启动和打包操作。
- `device/`：设备能力、设备类型、能力调用约定。
- `agent/`：自动化开发代理使用的流程说明。`agent/update.md` 被根目录 `AGENTS.md` 引用，移动前必须同步更新引用。

## 文档清单

### Architecture

- [项目架构说明](architecture/ARCHITECTURE.md)

### Requirements

- [产品功能说明](requirements/PRD.md)
- [游戏与玩法运行时说明](requirements/Game_Runtime.md)

### API

- [后端 API 文档（当前实现）](api/Backend_API.md)

### Device

- [设备能力说明](device/capabilities.md)

### Integration

- [MQTT、EMQX、mDNS 集成说明](integration/MQTT_mDNS.md)

### Guides

- [后端运行与测试指引](guides/BACKEND_IMPLEMENTATION.md)
- [构建打包指南](guides/Build_Package_Guide.md)
- [Windows Electron 启动指南](guides/Windows_通过_Electron_启动指南.md)

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

## 维护规则

- 新增接口或修改接口行为时，优先更新 [后端 API 文档](api/Backend_API.md)。
- 修改设备能力、设备类型或 MQTT payload 映射时，同步更新 [设备能力说明](device/capabilities.md)。
- 修改玩法模块契约、启动流程、SSE 事件或嵌入式 HTML 逻辑时，同步更新 [游戏与玩法运行时说明](requirements/Game_Runtime.md)。
- 修改 Electron 端口、preload 改写、静态服务或打包资源时，同步更新 `guides/` 下对应文档。
- 文档之间使用相对路径链接，不使用本机绝对路径或 `file:///` 链接。
- 避免为同一接口再新建专题 API 文档；专题文档只记录背景、流程或设计权衡，接口细节链接到权威 API 文档。
