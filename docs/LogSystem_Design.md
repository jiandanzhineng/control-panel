# 日志系统设计文档

## 概述

本文档描述了控制面板项目的日志系统设计，包括后端日志服务和前端日志管理界面。该系统提供统一的日志记录、存储、查看和管理功能。

## 系统架构

### 后端日志服务

#### 1. 日志服务模块 (LogService)

**文件位置**: `backend/services/logService.js`

**主要功能**:

- 统一日志记录接口
- 日志文件管理（按日期分割）
- 自动清理过期日志文件
- 日志级别控制

**日志级别**:

- ERROR: 错误信息
- WARN: 警告信息
- INFO: 一般信息
- DEBUG: 调试信息

#### 2. 日志存储结构

**存储路径**: `backend/logs/`

**文件命名规则**: `YYYY-MM-DD.log`

**示例**:

```
backend/logs/
├── 2024-01-15.log
├── 2024-01-16.log
└── 2024-01-17.log
```

#### 3. 日志格式

```
[时间戳] [级别] [模块] 消息内容
```

**示例**:

```
[2024-01-17 14:30:25] [INFO] [DeviceService] 设备连接成功: device-001
[2024-01-17 14:30:26] [ERROR] [MqttService] MQTT连接失败: Connection timeout
```

### API 接口设计

#### 1. 日志路由 (LogRoutes)

**文件位置**: `backend/routes/logs.js`

**接口列表**:

##### GET /api/logs/current

获取当前日志流（实时日志）

**响应**: SSE (Server-Sent Events) 流

```javascript
// 响应格式
data: {
  timestamp: "2024-01-17T14:30:25.123Z",
  level: "INFO",
  module: "DeviceService", 
  message: "设备连接成功"
}
```

##### GET /api/logs/files

获取日志文件列表

**响应**:

```json
{
  "files": [
    {
      "filename": "2024-01-17.log",
      "size": 1024576,
      "date": "2024-01-17",
      "lastModified": "2024-01-17T14:30:25.123Z"
    }
  ]
}
```

##### GET /api/logs/download/:filename

下载日志文件

**参数**:

- filename: 日志文件名

**响应**: 文件下载流

### 前端日志管理界面

#### 1. 日志管理页面组件

**文件位置**: `frontend/src/views/LogManagement.vue`

**主要功能**:

- 实时日志查看
- 历史日志文件管理
- 日志文件下载

#### 2. 组件结构设计

```
LogManagement.vue (主页面)
├── RealTimeLog.vue (实时日志组件)
├── LogFileList.vue (日志文件列表组件)
├── LogViewer.vue (日志查看器组件)
└── LogFilter.vue (日志过滤组件)
```

**组件职责**:

- **LogManagement.vue**: 主容器，管理页面状态和组件通信
- **RealTimeLog.vue**: 处理SSE连接，显示实时日志流
- **LogFileList.vue**: 显示历史日志文件，提供下载功能

#### 3. 页面布局设计

┌─────────────────────────────────────┐
│           日志管理系统               │
├─────────────────────────────────────┤
│  [实时日志] [历史文件]        │
├─────────────────────────────────────┤
│                                     │
│  实时日志区域 (信息流形式)           │
│  ┌─────────────────────────────────┐ │
│  │ [INFO] 14:30:25 设备连接成功     │ │
│  │ [WARN] 14:30:26 网络延迟较高     │ │
│  │ [ERROR] 14:30:27 MQTT连接失败    │ │
│  │ ...                             │ │
│  └─────────────────────────────────┘ │
│                                     │
│  历史文件区域                       │
│  ┌─────────────────────────────────┐ │
│  │ 📄 2024-01-17.log (1.2MB) [下载]│ │
│  │ 📄 2024-01-16.log (0.8MB) [下载]│ │
│  │ 📄 2024-01-15.log (1.5MB) [下载]│ │
│  └─────────────────────────────────┘ │
└─────────────────────────────────────┘

#### 4. 组件功能详细设计

##### 实时日志组件 (RealTimeLog.vue)

- 使用 EventSource 接收 SSE 流
- 自动滚动到最新日志
- 日志级别颜色区分
- 日志过滤功能

##### 日志文件列表组件 (LogFileList.vue)

- 显示日志文件列表
- 文件大小和日期信息
- 文件下载功能

#### 5. 路由配置

**文件位置**: `frontend/src/router/index.ts`

```javascript
// 路由配置示例
{
  path: '/logs',
  name: 'LogManagement',
  component: () => import('@/views/LogManagement.vue'),
  meta: { title: '日志管理' }
}
```

## 技术实现要点

### 后端实现

#### 1. 日志服务核心功能

```javascript
// 伪代码示例
class LogService {
  // 记录日志
  log(level, module, message) {
    // 格式化日志
    // 写入当日日志文件
    // 广播给SSE客户端
  }
  
  // 获取日志文件列表
  getLogFiles() {
    // 扫描logs目录
    // 返回文件信息
  }
  
  // 清理过期日志
  cleanOldLogs() {
    // 删除7天前的日志文件
  }
}
```

#### 2. SSE 实时日志推送

```javascript
// 伪代码示例
app.get('/api/logs/current', (req, res) => {
  // 设置SSE响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  
  // 监听新日志事件
  logService.on('newLog', (logData) => {
    res.write(`data: ${JSON.stringify(logData)}\n\n`);
  });
});
```

### 前端实现

#### 1. SSE 连接管理

```javascript
// 伪代码示例
class LogStreamManager {
  connect() {
    this.eventSource = new EventSource('/api/logs/current');
    this.eventSource.onmessage = (event) => {
      const logData = JSON.parse(event.data);
      this.addLogToDisplay(logData);
    };
  }
  
  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
    }
  }
}
```

#### 2. 日志显示优化

- 虚拟滚动处理大量日志
- 日志级别颜色编码
- 自动清理过多历史记录

## 实现步骤

### 第一阶段：后端基础功能

1. 创建日志服务模块 (`backend/services/logService.js`)
2. 实现日志路由 (`backend/routes/logs.js`)
3. 集成到主应用 (`backend/index.js`)
4. 创建日志存储目录

### 第二阶段：前端基础界面

1. 创建日志管理页面 (`frontend/src/views/LogManagement.vue`)
2. 实现实时日志组件 (`frontend/src/components/RealTimeLog.vue`)
3. 添加路由配置
4. 创建状态管理

### 第三阶段：完善功能

1. 实现日志文件列表和下载
