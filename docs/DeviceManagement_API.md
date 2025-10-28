# 设备管理页面接口文档（参考 DeviceManagement.vue）

说明：本接口文档依据 `frontend/reference/DeviceManagement.vue` 页面行为与交互推断所需后端能力，参考代码并非本项目的现有实现。目标是为后续后端接口开发提供清晰的契约与示例，覆盖设备列表、设备详情、数据编辑下发、删除设备以及实时监控等功能。

## 功能概述
- 初始化设备列表并展示统计（总数、在线、离线）。
- 选中设备后展示设备详情（基本信息、最后上报、电量、数据键值）。
- 编辑设备数据并下发到设备（MQTT）。
- 删除单个设备、清空所有设备。

## 数据模型
**Device**
- `id`：string，设备唯一标识。
- `name`：string，设备显示名称。
- `type`：string，设备类型标识；前端通过映射表展示中文名。
- `connected`：boolean，是否在线。
- `lastReport`：string（ISO8601），最后上报时间戳。
- `data`：object，设备上报或当前状态的键值数据（可能包含 number / boolean / string）。

**DeviceTypeMap**
- `record<string, string>`，类型代码到中文名称映射。例如：`{"thermo":"温度传感器"}`。

**响应格式约定（与项目现状一致）**
- 成功：直接返回业务数据载荷（对象或数组），不包裹 `code/message/data`。
- 失败：使用 HTTP 状态码，并返回如下结构（由后端 `sendError` 统一）：
```json
{
  "error": { "code": "SOME_ERROR_CODE", "message": "描述信息" }
}
```
- `code` 为字符串（例如 `DEVICE_NOT_FOUND`、`MQTT_CLIENT_PUBLISH_FAILED`），用于前端区分错误类型。

## HTTP 接口
基础路径：`/api`

1) 查询设备列表
- `GET /api/devices`
- 响应 `200`：
```json
[
  {
    "id": "dev-001",
    "name": "客厅传感器",
    "type": "thermo",
    "connected": true,
    "lastReport": "2025-01-01T12:00:00Z",
    "data": { "temperature": 23.6, "battery": 88 }
  }
]
```

2) 查询设备详情
- `GET /api/devices/:id`
- 响应 `200`：返回单个 `Device` 对象。
示例：
```json
{
  "id": "dev-001",
  "name": "客厅传感器",
  "type": "thermo",
  "connected": true,
  "lastReport": "2025-01-01T12:00:00Z",
  "data": { "temperature": 23.6, "battery": 88 }
}
```

3) 删除单个设备
- `DELETE /api/devices/:id`
- 响应 `200`：`{"ok": true}`。
（失败示例：`{"error": {"code": "DEVICE_NOT_FOUND", "message": "设备不存在"}}`，状态码如 `404`）

4) 清空所有设备
- `DELETE /api/devices/all`
- 响应 `200`：`{"ok": true}`。

5) 获取设备类型映射
- `GET /api/device-types`
- 响应 `200`：
```json
{ "thermo": "温度传感器", "switch": "开关" }
```

6) 更新设备元数据（例如名称）
- `PATCH /api/devices/:id`
- 请求体（示例）：`{"name":"卧室传感器"}`
- 响应 `200`：返回更新后的 `Device` 对象。
会通过mqtt发布消息 `/drecv/{id}` 来通知设备更新。
消息格式：
```json
{
  "method": "update",
  "name": "卧室传感器"
}
```


## 接口与页面映射
- 页面初始化：`GET /api/devices`，`GET /api/device-types`。
- 选中设备并展示详情：`GET /api/devices/:id`（或从列表中直接用）。
- 编辑设备数据并保存：`POST /api/mqtt/publish`（`topic=/drecv/{id}`，负载含 `method:update` 与差异字段）。
- 删除设备：`DELETE /api/devices/:id`。
- 清空设备：`DELETE /api/devices/all`。

