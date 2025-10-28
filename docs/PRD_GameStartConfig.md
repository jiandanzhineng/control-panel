# PRD：游戏启动前配置界面

## 背景与目标
- 从游戏列表点击“启动”后先进入“启动前配置”界面。
- 在该界面完成玩法所需设备映射与参数填写，确保一次启动成功。

## 用户流程
- 入口：游戏列表页点击某游戏的“启动”。
- 加载：并发拉取游戏详情、设备列表、设备类型、玩法元信息（若有）。
- 配置：完成设备映射（逻辑设备→实际设备）与参数填写。
- 校验：必需设备已映射且在线、参数合法；通过后启用“启动”。
- 启动：提交配置调用后端启动；成功后进入运行页面（嵌入式HTML+SSE）。

## 界面结构
- 顶部信息：游戏名称、简介、版本、最后游玩时间（来自 `/api/games/:id`）。
- 设备映射区：展示 `requiredDevices`（`logicalId`、类型、是否必需），下拉选择在线设备，显示连接状态与类型匹配提示。
- 参数配置区：支持 `string/number/boolean/enum/range`，展示默认值与占位说明，非法输入即时提示。
- 右侧摘要与校验：映射与参数概览卡片，显示阻塞项（未映射、离线、类型不匹配、参数不合法）。
- 操作区：`启动`（校验通过才可点击）、`强行启动`（不校验）、`取消返回`。

## 交互与校验
- 设备映射：所有 `required=true` 的逻辑设备必须映射到一个在线设备；若提供类型则需类型匹配。
- 参数校验：必填项必须填写；`number` 支持 `min/max`；`enum` 限定集合；默认值可直接采用。
- 启动冲突：已有玩法运行时后端返回 `409`，前端提示“停止当前玩法后再启动”。

## 数据与接口（对接现有后端）
- `GET /api/games/:id`：获取游戏详情（含 `configPath`）。
- `GET /api/devices`：设备列表（含 `id/connected/type/meta/data`）。
- `GET /api/device-types`：设备类型映射（用于过滤与推荐）。
- `POST /api/games/:id/start`：启动玩法，Body：
  - `deviceMapping: { [logicalId]: deviceId }`
  - `parameters: { [key]: value }`
- 启动成功后：
  - `GET /api/games/current/html`：获取运行页的嵌入式HTML。
  - `GET /api/games/current/stream`：订阅SSE（事件：`hello/state/ui/log/ping`）。

### 可选后端增强（便于自动生成表单）
- `GET /api/games/:id/meta`：返回玩法元信息：
  - `requiredDevices: Array<{ logicalId, type?, required: boolean, description? }>`
  - `parameterSchema: Record<string, { type, required?, default?, enum?, min?, max? }>`
- `POST /api/games/:id/validate`：仅校验不启动，返回阻塞项列表（可后续迭代加入）。

## 验收标准
- 在“启动前配置”界面完成设备映射与参数填写；所有校验通过后可点击“启动”。
- 必需设备缺失或离线时明确阻塞提示，`启动`按钮禁用。
- 参数非法时即时提示；修正后通过校验可启动。
- 启动成功自动进入运行页，正常渲染首屏HTML并收到 SSE `hello` 快照。
- 接口异常与运行冲突有清晰提示与可恢复路径。

## 术语与示例
- `deviceMapping` 示例：`{ "controller": "dev_abc123", "display": "dev_xyz789" }`
- `parameters` 示例：`{ "rounds": 3, "difficulty": "hard", "enableBonus": true }`