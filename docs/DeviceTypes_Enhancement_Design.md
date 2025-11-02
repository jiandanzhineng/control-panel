# 设备类型扩展功能设计文档

## 概述

本文档描述了对现有设备类型配置系统的扩展设计，主要包括：

1. 设备监控数据定义
2. 设备操作定义
3. 前端UI交互增强
4. 后端API接口扩展

## 1. 现状分析

### 1.1 现有设备类型配置

当前 `deviceTypes.js` 只包含基本的设备类型映射：

- 简单的类型名称映射
- 基础的类型验证功能
- 无监控数据定义
- 无操作定义

### 1.2 现有设备管理页面

- 基本的设备列表展示
- 简单的删除操作
- 无数据监控功能
- 无设备操作功能

## 2. 扩展设计

### 2.1 设备类型配置数据结构扩展

#### 2.1.1 新的配置结构

```javascript
const deviceTypeConfig = {
  'TD01': {
    name: '偏轴电机控制器',
    operations: [
      {
        key: 'start',
        name: '启动',
        mqttData: { method: 'update', power: 255 }
      },
      {
        key: 'stop',
        name: '关闭',
        mqttData: { method: 'update', power: 0 }
      }
    ]
  },
  'QIYA': {
    name: '气压传感器',
    monitorData: [
      {
        key: 'pressure',
        name: '气压',
        unit: 'Pa'
      },
      {
        key: 'temperature',
        name: '温度',
        unit: '°C'
      }
    ],
    operations: []
  }
};
```

#### 2.1.2 数据结构说明

- 所有监控数据均为数值类型

### 2.2 配置文件API扩展

#### 2.2.1 新增函数

```javascript
// 获取设备类型的监控数据定义
function getDeviceMonitorData(type) {
  const config = deviceTypeConfig[type];
  return config ? config.monitorData : [];
}

// 获取设备类型的操作定义
function getDeviceOperations(type) {
  const config = deviceTypeConfig[type];
  return config ? config.operations : [];
}

// 检查设备是否支持数据监控
function hasMonitorData(type) {
  const monitorData = getDeviceMonitorData(type);
  return monitorData && monitorData.length > 0;
}

// 检查设备是否支持操作
function hasOperations(type) {
  const operations = getDeviceOperations(type);
  return operations && operations.length > 0;
}

// 获取完整的设备类型配置
function getDeviceTypeConfig(type) {
  return deviceTypeConfig[type] || null;
}
```

## 3. 前端UI设计

### 3.1 设备列表操作列扩展

#### 3.1.1 操作按钮布局

```
[数据监控] [启动] [关闭] [删除]
```

#### 3.1.2 按钮显示逻辑

- **数据监控按钮**: 仅当设备类型定义了 `monitorData` 且长度 > 0 时显示
- **操作按钮**: 根据设备类型的 `operations` 配置动态生成
- **删除按钮**: 始终显示

#### 3.1.3 按钮样式

- 数据监控: 蓝色主题按钮
- 操作按钮: 根据操作类型使用不同颜色
  - 启动类: 绿色
  - 停止类: 红色
  - 其他: 默认灰色
- 删除: 红色危险按钮

### 3.2 数据监控弹窗设计

#### 3.2.1 弹窗结构

```
设备数据监控 - [设备名称]
┌─────────────────────────────────────────┐
│ ┌─────────────────────────────────────┐ │
│ │     功率 (%)                        │ │
│ │  255 ┤                             │ │
│ │      │  ╭─╮                        │ │
│ │  128 ┤ ╱   ╲                       │ │
│ │      │╱     ╲                      │ │
│ │    0 └────────────────────────────  │ │
│ │      10:00  10:05  10:10  10:15    │ │
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │     转速 (rpm)                      │ │
│ │ 2000 ┤                             │ │
│ │      │    ╭─╮                      │ │
│ │ 1000 ┤   ╱   ╲                     │ │
│ │      │  ╱     ╲                    │ │
│ │    0 └────────────────────────────  │ │
│ │      10:00  10:05  10:10  10:15    │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [关闭]                                  │
└─────────────────────────────────────────┘
```

#### 3.2.2 折线图特性

- 每个监控数据项显示为独立的折线图
- X轴显示时间，Y轴显示数值
- 数据来源于设备的report信息和update信息
- 实时更新，显示最近一段时间的数据趋势
- 图表标题显示监控项名称和单位

#### 3.2.3 数据更新机制

- 自动接收MQTT消息更新图表数据
- 前端最多保留最近30分钟的历史数据（不超过100条）
- 注册设备属性监听 当监听到新数据时通过SSE推送到前端

### 3.3 操作执行反馈

#### 3.3.1 操作提示

- 点击操作按钮后直接执行，无需确认对话框
- 执行后显示Toast提示："已执行[操作名称]操作"
- 操作失败时显示错误提示

## 4. 后端API设计

### 4.1 设备类型配置API

#### 4.1.1 获取设备类型配置

```
GET /api/device-types/:type/config
```

响应:

```json
{
  "name": "偏轴电机控制器",
  "operations": [
    {
      "key": "start",
      "name": "启动",
      "mqttData": { "method": "setPower", "power": 255 }
    },
    {
      "key": "stop",
      "name": "关闭",
      "mqttData": { "method": "setPower", "power": 0 }
    }
  ]
}
```

#### 4.1.2 获取所有设备类型配置

```
GET /api/device-types/configs
```

响应:

```json
{
  "TD01": {
    "name": "偏轴电机控制器",
    "operations": [
      {
        "key": "start",
        "name": "启动",
        "mqttData": { "method": "setPower", "power": 255 }
      },
      {
        "key": "stop",
        "name": "关闭",
        "mqttData": { "method": "setPower", "power": 0 }
      }
    ]
  },
  "QIYA": {
    "name": "气压传感器",
    "monitorData": [
      {
        "key": "pressure",
        "name": "气压",
        "unit": "Pa"
      },
      {
        "key": "temperature",
        "name": "温度",
        "unit": "°C"
      }
    ],
    "operations": []
  }
}
```

### 4.2 设备操作API

#### 4.2.1 执行设备操作

```
POST /api/devices/:id/operations/:operationKey
```

请求体:

```json
{
  "params": {} // 可选的操作参数
}
```

响应:

```json
{
  "success": true,
  "message": "操作执行成功"
}
```

#### 4.2.2 获取设备监控数据

```
GET /api/devices/:id/monitor-data
```

响应:

```json
{
  "deviceId": "device-001",
  "type": "TD01",
  "data": {
    "power": 128,
    "speed": 1500
  },
  "timestamp": "2024-01-17T14:30:25.123Z"
}
```

#### 4.2.3 获取设备监控数据（SSE模式）

```
GET /api/devices/:id/monitor-stream
```

响应: **Server-Sent Events (SSE) 流**

**实时数据更新事件:**

```
event: update
data: {
  "deviceId": "device-001",
  "timestamp": "2024-01-17T14:15:00.000Z",
  "power": 135,
  "speed": 1550
}

```

### 4.3 MQTT消息格式

#### 4.3.1 设备操作消息

发送到设备的操作消息格式:

```json
{
  "method": "update",
  "power": 255
}
```

## 5. 实现步骤

### 5.1 后端实现

1. 扩展 `deviceTypes.js` 配置文件
2. 更新 `deviceService.js` 添加操作支持
3. 扩展 `routes/deviceTypes.js` 添加新API
4. 新增 `routes/deviceOperations.js` 处理设备操作
5. 实现SSE服务提供实时监控数据流

**SSE服务实现示例:**

```javascript
// routes/devices.js
router.get('/:id/monitor-stream', (req, res) => {
  const deviceId = req.params.id;
  const duration = req.query.duration || '30m';
  
  // 设置SSE响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  // 发送历史数据
  const historyData = getHistoryData(deviceId, duration);
  res.write(`event: history\n`);
  res.write(`data: ${JSON.stringify(historyData)}\n\n`);
  
  // 订阅MQTT实时数据
  const mqttTopic = `device/${deviceId}/report`;
  mqttClient.subscribe(mqttTopic);
  
  const messageHandler = (topic, message) => {
    if (topic === mqttTopic) {
      const data = JSON.parse(message.toString());
      res.write(`event: update\n`);
      res.write(`data: ${JSON.stringify({
        deviceId,
        timestamp: new Date().toISOString(),
        ...data
      })}\n\n`);
    }
  };
  
  mqttClient.on('message', messageHandler);
  
  // 连接关闭时清理
  req.on('close', () => {
    mqttClient.unsubscribe(mqttTopic);
    mqttClient.removeListener('message', messageHandler);
  });
});
```

### 5.2 前端实现

1. 更新 `DevicesView.vue` 添加新按钮
2. **数据监控弹窗组件**

   - 创建监控数据弹窗组件
   - 集成图表库（如Chart.js或ECharts）
   - 实现折线图展示
   - 建立SSE连接获取实时数据流
   - 处理历史数据初始化和实时数据更新

   **SSE连接实现示例:**

   ```javascript
   // 建立SSE连接
   const eventSource = new EventSource(`/api/devices/${deviceId}/monitor-stream`);


   // 处理实时数据更新
   eventSource.addEventListener('update', (event) => {
     const data = JSON.parse(event.data);
     updateCharts(data);
   });


   // 组件销毁时关闭连接
   onUnmounted(() => {
     eventSource.close();
   });
   ```
3. 实现Toast提示组件
4. 更新设备管理相关的API调用

## 6. 注意事项

### 6.2 错误处理

- MQTT发送失败时显示Toast错误提示
- SSE连接断开时自动重连
- 历史数据获取失败时显示"暂无数据"
- 图表数据为空时显示"暂无监控数据"

### 6.3 性能考虑

- 弹窗关闭时及时关闭SSE连接
- 实时数据更新时使用节流处理，避免频繁重绘

### 6.5 SSE连接管理

- 客户端断开连接时服务端及时清理资源
- 设置合理的连接超时时间
- 监控SSE连接状态，异常时进行重连
- 避免内存泄漏，正确处理MQTT订阅和取消订阅
