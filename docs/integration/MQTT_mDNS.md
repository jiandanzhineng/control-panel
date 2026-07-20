# MQTT、EMQX、mDNS 集成说明

本文按当前代码实现整理，覆盖 MQTT Broker、MQTT 客户端、网络地址枚举和 mDNS 发布。

## MQTT Broker

入口：

- API 路由：[backend/routes/mqtt.js](../../backend/routes/mqtt.js)
- 服务实现：[backend/services/mqttService.js](../../backend/services/mqttService.js)

后端启动时会自动调用 `mqttService.start()`。

### Windows

Windows 平台优先使用 EMQX：

- EMQX 服务实现：[backend/services/emqxService.js](../../backend/services/emqxService.js)
- 开发环境工具目录：`backend/tools`
- 非开发环境工具目录：`C:\easysmart\tools`
- EMQX 工作目录：`{toolsDir}\emqx`
- 下载地址：`https://packages.emqx.io/emqx-ce/v5.3.1/emqx-5.3.1-windows-amd64.zip`
- 解压依赖：`adm-zip`

如果未检测到 `bin/emqx.cmd` 和 `bin/emqx_ctl.cmd`，服务会先下载并解压 EMQX。启动命令为 `emqx.cmd start`，状态检查命令为 `emqx_ctl.cmd status`，停止命令为 `emqx.cmd stop`。

EMQX 启动失败时，`mqttService` 会记录错误并继续走 mosquitto 启动逻辑。

### Linux/macOS 或回退场景

非 Windows 或 EMQX 回退时使用 mosquitto：

- 默认配置文件：`backend/config/mosquitto.conf`
- 如果未传 `configPath`，会按 `port` 和 `bind` 生成临时配置：
  ```conf
  listener 1883 0.0.0.0
  allow_anonymous true
  ```
- 启动命令：`mosquitto -c {confPath}`

## MQTT 客户端

入口：[backend/services/mqttClientService.js](../../backend/services/mqttClientService.js)

后端启动时会初始化单例客户端：

- Broker URL：`MQTT_CLIENT_URL`，默认 `mqtt://127.0.0.1:1883`
- Client ID：`MQTT_CLIENT_ID`，默认 `fb-client-{hostname}-{timestamp}`
- 重连周期：3000ms
- 连接成功后默认订阅 `#`
- 每 60 秒向 `/all` 发布 `{ "message": "Master controller is online" }`

设备协议约定：

- 设备上报主题：`/dpub/{deviceId}`
- 控制器下发主题：`/drecv/{deviceId}`
- `method=report`：自动创建设备或合并上报数据。
- `method=update`：按字段更新设备状态。
- `method=ota_status`：更新设备 OTA 状态。

## mDNS

入口：

- API 路由：[backend/routes/mdns.js](../../backend/routes/mdns.js)
- 当前挂载服务：[backend/services/mdnsService.js](../../backend/services/mdnsService.js)

当前 API 不读取请求体。`POST /api/mdns/publish` 使用 Node.js 内置 `dgram`
模块创建 UDP4 socket，绑定 `0.0.0.0:5353` 并在选中的物理局域网网卡上加入
`224.0.0.251` 组播组。实现不再启动 `mdns_tool.exe`，也不依赖 Python、zeroconf
或第三方 Node mDNS 包。

服务只发布设备连接 MQTT 所需的 `A easysmart.local`：

- WLAN/Wi-Fi 优先，其次是物理 Ethernet 网卡。
- 自动排除 Hyper-V、WSL、VPN、蓝牙和常见虚拟网卡以及链路本地地址。
- 可用 `MDNS_INTERFACE` 或 `MDNS_IPV4` 指定物理网卡；指定虚拟网卡仍会被拒绝。
- 对源端口不是 `5353` 的查询使用 legacy-unicast：响应回到查询者的随机源端口，
  保留查询 Transaction ID 和 Question，并设置 `QDCOUNT=1`。
- 标准 mDNS 查询使用 `ID=0` 的响应，启动/停止时分别发送 TTL 120/0 的 A 记录公告。

`GET /api/mdns/status` 会返回所选 `interface`、`ip`、Node 进程 PID 以及查询/响应计数。
同目录下的 `mdnsServiceWindows.js` 和 `backend/inner-tools/mdns_tool.exe` 是未挂载的旧实现。

直接运行 `node backend/index.js` 时，Windows 会在后端监听成功后尝试自动发布 mDNS。Electron 通过 `require backend/index.js` 获取 Express app，因此不会触发该自动发布分支，需要通过页面或 API 启动。

## 网络地址枚举

入口：[backend/services/networkService.js](../../backend/services/networkService.js)

`GET /api/network/ips` 使用 Node `os.networkInterfaces()` 收集本机非内网 IPv4，并返回：

```json
[
  { "interface": "WLAN", "ip": "192.168.1.10", "cidr": 24 }
]
```

当前实现不调用 WSL、`ifconfig` 或 Python 脚本。

## 前端入口

网络设置页面：[frontend/src/views/ServicesView.vue](../../frontend/src/views/ServicesView.vue)

页面提供：

- mDNS 启动、停止、状态刷新。
- MQTT Broker 启动、停止、状态刷新。
- MQTT 客户端状态刷新。
- 底部实时日志，过滤 `emqx`、`mqtt`、`mdns` 模块。
