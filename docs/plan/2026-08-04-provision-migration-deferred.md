# provision 服务迁移调研报告（暂缓执行）

> **状态**：已完成调研，**暂缓执行**。待主客户端融合小念/酒馆插件完成后，再单独排期处理。
>
> **来源**：wayfinder map `docs/plan/wayfinder-st-iot-bridge-merge.md` 的 `provision-migration` 票（已 resolve，但用户决定暂不执行）。
>
> **详细调研**：`.tmp/provision-migration-research.md`

## 背景

副仓 `st-iot-bridge/integrations/control-panel/backend` 有主仓没有的 provision 服务（给 CUNZHI01 配网，写 Wi-Fi + MQTT broker）。原计划搬到主仓，但主仓已有部分设备接入功能，需要挑选增量合入，不能整体直搬。

## 结论速览

### 要搬（5 个文件，无冲突）

- `routes/provision.js`（152 行，13 个 HTTP 端点）
- `services/provisionService.js`（1579 行，配网核心逻辑）
- `services/cunzhiBleService.js`（BLE 桥服务）
- `inner-tools/cunzhi01_blufi_provision.py`（Blufi 配网脚本）
- `inner-tools/cunzhi01_ble_bridge.py`（BLE 桥脚本）

### 不搬

- `inner-tools/firmware/cunzhi-mqtt-gateway/`（ESP32 固件源码，与后端运行时无关）
- 副仓 `mdnsService.js` / `networkService.js` / `mqttService.js` / `mqttClientService.js` / `deviceService.js` 整文件——主仓都有同名服务，只挑增量合入

### 要改主仓（4 处硬冲突）

| 主仓文件 | 需要的改动 |
|---|---|
| `services/deviceService.js` | 新增 3 个函数（`getLastDeviceDataReport` / `probeDeviceProperty` / `handleDeviceMessage` 字段解析） |
| `services/mqttClientService.js` | 新增 `connectionEpoch` 状态字段 |
| `services/mqttService.js` | 导出常量 `DEFAULT_DEVICE_BIND` / `DEFAULT_PORT` |
| `services/networkService.js` | 可选追加 `getCurrentWifi()` |

### 新增挂载

- `index.js` 追加 `app.use('/api/provision', require('./routes/provision'))`
- `backend/data/provision_device_bindings.json` 运行时自动生成

## 待拍板的 3 个风险点

1. **Windows BLE 策略**：副仓 `cunzhiBleService.shouldEnable()` 只在非 Windows 启用。主仓是 Windows 应用，BLE 桥会自动 disabled。需要决定 Windows 是否启用 BLE。
2. **mdnsService.publish() 异步兼容**：副仓 provision 行 959 同步 try/catch 捕不到主仓 async publish 的 rejection，搬时需改为 `await ... .catch(...)`。
3. **deviceService 增量合入方式**：直接在 deviceService.js 里加，还是独立成新模块 `deviceIngressService.js`。

## 后续验证清单（执行时跑）

1. 主仓现有 MQTT 设备能否被 provision 识别为 candidate
2. `mqttClientService` 重连后 `connectionEpoch` 是否正确递增
3. Windows 上 EMQX 强制 1883/0.0.0.0 路径与 provision 推荐逻辑的兼容性
4. `mdnsService.publish()` 的 async 错误处理

## 暂缓原因

用户决定：「provision 整个不搬，状态计划单独写个文档，晚点另行处置」。当前优先做 window-mode/device-config-ownership/tavern-bootstrap/hud-fate 已 resolve 的小念游戏化 + 酒馆插件融入。
