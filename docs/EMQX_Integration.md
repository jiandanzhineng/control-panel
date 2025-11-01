# EMQX Windows集成说明

## 概述

本项目已集成EMQX MQTT Broker，在Windows平台上自动使用EMQX替代mosquitto，提供更稳定的MQTT服务。

## 主要修改

### 1. emqxService.js 适配修改

**原始问题：**
- 依赖`adm-zip`包（项目中未安装）
- 使用了不兼容的Electron导入方式
- 路径配置不适合当前项目

**修改内容：**
- 移除`adm-zip`依赖，使用PowerShell的`Expand-Archive`命令解压
- 优化Electron集成，移除直接的`app`导入
- 调整工具目录路径为`C:\control-panel\tools`
- 简化错误处理逻辑

### 2. mqttService.js 跨平台支持

**新增功能：**
- 自动检测操作系统类型
- Windows平台优先使用EMQX
- Linux/macOS平台继续使用mosquitto
- EMQX启动失败时自动回退到mosquitto

**API变更：**
- 所有函数改为异步（`async/await`）
- 返回结果增加`broker`字段标识使用的broker类型
- 状态检查支持EMQX特有的状态信息

### 3. 相关文件更新

**路由文件（routes/mqtt.js）：**
- 所有路由处理器改为异步
- 增加错误处理

**主入口文件（index.js）：**
- MQTT服务启动改为异步
- 进程退出清理改为异步

## 使用方式

### 自动启动
项目启动时会自动检测操作系统：
- **Windows**: 尝试启动EMQX，失败则回退到mosquitto
- **Linux/macOS**: 直接使用mosquitto

### API接口
```javascript
// 启动MQTT服务
POST /api/mqtt/start
{
  "port": 1883,
  "bind": "0.0.0.0"
}

// 查看服务状态
GET /api/mqtt/status

// 停止服务
POST /api/mqtt/stop
```

### 返回格式
```javascript
{
  "running": true,
  "broker": "emqx",  // 或 "mosquitto"
  "port": 1883,
  "status": "running"
}
```

## EMQX特性

### 自动下载安装
- 首次使用时自动下载EMQX 5.3.1
- 解压到`C:\control-panel\tools\emqx`
- 支持断点续传和进度显示

### 服务管理
- 支持启动、停止、重启、状态检查
- 集成日志系统，实时显示运行状态
- 错误自动恢复机制

### 配置说明
- 默认端口：1883
- 默认绑定：0.0.0.0
- 允许匿名连接
- 支持WebSocket连接

## 注意事项

1. **Windows权限**：首次运行可能需要管理员权限下载EMQX
2. **防火墙**：确保1883端口未被防火墙阻止
3. **磁盘空间**：EMQX安装包约100MB，解压后约300MB
4. **网络连接**：首次安装需要网络连接下载EMQX

## 故障排除

### EMQX启动失败
- 检查C盘是否有足够空间
- 确认网络连接正常
- 查看日志文件获取详细错误信息

### 回退到mosquitto
- 系统会自动回退，无需手动干预
- 检查mosquitto是否已安装
- 确认配置文件路径正确

## 开发说明

### 测试环境
- 开发环境下工具目录为`backend/tools`
- 生产环境下工具目录为`C:\control-panel\tools`

### 日志集成
- 所有EMQX操作都会记录到日志系统
- 支持实时日志流（SSE）
- 日志级别：info, warn, error, debug