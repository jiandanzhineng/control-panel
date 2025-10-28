# 后端实现与测试指引（MQTT + mDNS）

基于 `MQTT_mDNS.md` 的最小可行后端（Node.js/Express）实现与测试说明，面向 Windows + WSL 环境，前端开发端口为 `5173`。

## 1. 目标与约束

- 提供 REST API 管理匿名 `mosquitto`（MQTT Broker）与 mDNS 发布进程。
- 所有接口返回 JSON，失败包含 `error.code`、`error.message`。
- 启用 CORS：允许 `http://localhost:5173` 调用。

## 2. 环境准备

- Node.js ≥ 18，建议安装依赖：`express`、`cors`。
- MQTT：安装 `mosquitto`（Windows 或 WSL）。
- WSL：安装 `net-tools`（提供 `ifconfig`）。
  ```bash
  wsl sudo apt update && wsl sudo apt install -y net-tools
  ```
- Python3 + `zeroconf`（用于 mDNS 脚本）。
  ```bash
  wsl sudo apt install -y python3-pip && wsl pip3 install zeroconf
  ```
- 项目内已有脚本：`mdns/mdns.py`（推荐）或 `mdns/mdns_register_ip.py`（简化）。

## 3. 运行后端

- 端口：默认 `3000`（可通过环境变量或代码配置）。
- 启动（示例）：
  ```powershell
  cd backend
  npm install
  node index.js  # 或 npm start（视 package.json 而定）
  ```

## 4. API 设计与实现要点

### 4.1 MQTT Broker

- POST `/mqtt/start`
  - body：无
  - 行为：`spawn` 启动 `mosquitto`（使用 `configPath backend\config\mosquitto.conf`；）。
  - 返回：`{ running: true, pid }`
  - 失败：`MQTT_START_FAILED`
- GET `/mqtt/status`
  - 返回：`{ running, pid?: number }`
- POST `/mqtt/stop`
  - 行为：停止已启动的 `mosquitto` 进程（`pid`）。
  - 返回：`{ running: false }`

实现建议：使用 `child_process.spawn` 管理进程，单例运行；在内存中保存 `{ pid, port }`。

### 4.2 网络接口（供选择 IP）

- GET `/network/ips`
  - 行为：优先 `ifconfig` 解析 IPv4；若不可用，报错。
  - 返回：`[{ interface, ip, cidr }]`，排除 `127.0.0.1`。
  - 失败：`IFCONFIG_NOT_AVAILABLE`（当 WSL 不可用且无回退时）。

### 4.3 mDNS 发布

- POST `/mdns/publish`
  - body：`{ ip}`
  - 行为：调用  `mdns_register_ip.py`。
  - 返回：`{ running: true,  pid, ip }`
  - 失败：`MDNS_PUBLISH_FAILED`
- POST `/mdns/unpublish`
  - body：无
  - 行为：停止对应发布进程。
  - 返回：`{ running: false}`
- GET `/mdns/status`
  - 返回：`[{ pid, ip, running}]`

实现建议：在内存表中维护 `{ pid, meta }`；`spawn` 进程常驻以保持广播；。

## 5. 错误格式与处理

- 统一错误返回：
  ```json
  {"error":{"code":"<CODE>","message":"<msg>"}}
  ```
- 常见错误码：
  - `MQTT_START_FAILED`：`mosquitto` 启动失败或未安装。
  - `IFCONFIG_NOT_AVAILABLE`：无 `ifconfig`，且无法回退。
  - `MDNS_PUBLISH_FAILED`：Python/zeroconf/脚本错误或参数不合法。

## 6. 测试指引（PowerShell）

前置：后端运行在 `http://localhost:3000`。

- 启动 MQTT：
  ```powershell
  Invoke-RestMethod -Uri http://localhost:3000/mqtt/start -Method Post \
    -Body (@{port=1883;bind='0.0.0.0'} | ConvertTo-Json) \
    -ContentType 'application/json'
  ``
  ```
- 查询 MQTT 状态：
  ```powershell
  Invoke-RestMethod -Uri http://localhost:3000/mqtt/status -Method Get
  ```
- 停止 MQTT：
  ```powershell
  Invoke-RestMethod -Uri http://localhost:3000/mqtt/stop -Method Post
  ```
- 获取可用 IPv4：
  ```powershell
  Invoke-RestMethod -Uri http://localhost:3000/network/ips -Method Get
  ```
- 发布 mDNS（替换 `ip`、`name`、`port`）：
  ```powershell
  $body = @{ ip='192.168.1.100'; name='MyService'; port=5173; serviceType='_http._tcp'; txt=@{version='1.0'} } | ConvertTo-Json
  Invoke-RestMethod -Uri http://localhost:3000/mdns/publish -Method Post -Body $body -ContentType 'application/json'
  ```
- 取消发布（替换 `id`）：
  ```powershell
  Invoke-RestMethod -Uri http://localhost:3000/mdns/unpublish -Method Post -Body (@{id='YOUR_ID'} | ConvertTo-Json) -ContentType 'application/json'
  ```
- 查询已发布项：
  ```powershell
  Invoke-RestMethod -Uri http://localhost:3000/mdns/status -Method Get
  ```

## 7. 运行级验证（可选）

- MQTT（WSL 内）：
  ```bash
  wsl mosquitto_sub -h localhost -t test -v &
  wsl mosquitto_pub -h localhost -t test -m "hello"
  ```

  预期：`mosquitto_sub` 收到 `hello`。
- mDNS（WSL 内）：
  ```bash
  wsl avahi-browse -a | head -n 20
  ```

  预期：能看到所发布的 `_http._tcp` 服务项。

## 8. 注意事项

- Windows 环境可能需为 `mosquitto.exe` 配置 PATH 或使用 WSL 中的 `mosquitto`。
- `network/ips` 在无 WSL 时回退到 `os.networkInterfaces()`，但不同网卡命名与 CIDR 可能不一致。
- mDNS TXT 字段需转为 `k=v` 逗号拼接；注意特殊字符转义。

—— 完 ——
