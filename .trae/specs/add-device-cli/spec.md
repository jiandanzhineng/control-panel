# 设备管理 CLI 规范

## Why
当前项目主要通过后端 API 与页面操作设备，缺少适合脚本化和终端运维的命令行入口。需要一个与现有项目隔离、可直接运行的无状态 CLI，提升设备查询与控制效率。

## What Changes
- 在仓库根目录新增独立文件夹，承载设备管理 CLI 程序，与现有前后端代码隔离
- CLI 基于 `docs/Backend_API.md` 中现有接口实现设备相关能力，不新增后端接口
- 提供四类命令：在线设备列表、设备属性读取、设备属性更新、向设备发送 MQTT 指令
- CLI 采用无状态设计：不持久化会话和缓存，每次命令独立执行并立即退出
- 统一参数输入与输出格式，便于脚本调用与人工阅读

## Impact
- Affected specs: 设备管理命令行能力、设备属性读写能力、设备 MQTT 指令能力
- Affected code: 新增根目录 CLI 子项目（入口、命令解析、API 客户端、输出适配）

## ADDED Requirements
### Requirement: 独立无状态 CLI
系统 SHALL 提供一个位于仓库根目录新文件夹内的独立 CLI 程序，用于设备管理操作且不依赖前端运行态。

#### Scenario: 命令独立执行
- **WHEN** 用户执行任意 CLI 命令
- **THEN** CLI 独立完成一次请求并退出，不保留运行状态

### Requirement: 获取在线设备列表
系统 SHALL 提供命令获取当前在线设备列表，并输出设备标识与核心展示字段。

#### Scenario: 获取成功
- **WHEN** 用户执行设备列表命令
- **THEN** CLI 调用设备列表 API 并输出结构化结果

### Requirement: 获取设备属性值
系统 SHALL 提供命令按设备 ID 与属性键读取设备属性值。

#### Scenario: 属性读取成功
- **WHEN** 用户提供设备 ID 与属性键执行读取命令
- **THEN** CLI 返回该属性当前值

### Requirement: 更新设备属性值
系统 SHALL 提供命令按设备 ID 更新单个属性值并回显更新结果。

#### Scenario: 属性更新成功
- **WHEN** 用户提供设备 ID、属性键与新值执行更新命令
- **THEN** CLI 调用设备更新 API 并输出更新后的关键结果

### Requirement: 发送设备 MQTT 指令
系统 SHALL 提供命令向指定设备发送 MQTT 指令，支持指令主题与消息体输入。

#### Scenario: 指令发送成功
- **WHEN** 用户提供设备 ID、主题与消息执行发送命令
- **THEN** CLI 调用 MQTT 发布接口并返回发送结果

## MODIFIED Requirements
### Requirement: 现有后端设备接口复用
CLI 功能应完全复用现有 `/api/devices` 与 `/api/mqtt-client/publish` 能力，不修改接口语义。

## REMOVED Requirements
### Requirement: 无
**Reason**: 本次仅新增 CLI 能力，不移除既有能力。  
**Migration**: 无迁移要求。
