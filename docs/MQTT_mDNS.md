# 前后端集成说明（MQTT + mDNS）

## 概述

- 目标：前端可视化启动匿名 `mosquitto`，并触发后端运行 `mdns/mdns.py` 做 mDNS 发布。
- 约束：mDNS 发布前，用户必须在前端手动选择发布用的本机 IP（通过 `ifconfig` 获取）。
- 基线：后端 Node.js（`backend`），前端 Vue3+Vite（`frontend`），已有 `mdns/mdns.py`。

## 后端 API

- 基本

  - 基址：`http://localhost:<PORT>`（默认 `3000`）
  - 统一返回 JSON，失败包含 `error.code`、`error.message`
  - 建议启用 CORS（前端开发端口 `5173`）
- MQTT Broker

  - `POST /mqtt/start`：启动 `mosquitto`（匿名）
    - body：`{ port?: 1883, configPath?: "backend/mosquitto.conf", bind?: "0.0.0.0" }`
    - resp：`{ running: true, port, pid }`
  - `GET /mqtt/status`：返回运行状态
    - resp：`{ running, pid?: number, port?: number }`
  - `POST /mqtt/stop`：停止 broker
    - resp：`{ running: false }`
- 网络接口（供选择 IP）

  - `GET /network/ips`：列出可用 IPv4 地址（通过 `ifconfig`）
    - resp：`[{ interface, ip, cidr }]`（排除 `127.0.0.1`）
- mDNS 发布

  - `POST /mdns/publish`
    - body：`{ ip }`
    - 行为：调用 `python mdns/mdns_register_ip.py --ip ...`
    - resp：`{ published: true, ip }`
  - `POST /mdns/unpublish`
    - body：无
    - resp：`{ published: false, id }`
  - `GET /mdns/status`
    - resp：`[{ ip, pid(if running), running }]`

## 前端页面

- 布局：两个卡片——“MQTT Broker”和“mDNS 发布”，底部简单日志区。
- MQTT 卡片
  - 显示：运行状态、端口、PID
  - 操作：输入端口→“启动”；“停止”
- mDNS 卡片（分步）
  - 步骤 1：点击“获取 IP”→下拉选择网卡 IP
  - 步骤 2：填写服务名、类型（默认 `_http._tcp`）、端口、TXT（可选）
  - 步骤 3：点击“发布”→显示返回的 `id` 与状态；支持“取消发布”

## 交互流程

- 启动 MQTT：前端 `POST /mqtt/start` → `GET /mqtt/status` 展示状态。
- 获取 IP：前端 `GET /network/ips` → 用户选择。
- 发布 mDNS：前端 `POST /mdns/publish`（携带所选 IP）→显示已发布项；支持 `POST /mdns/unpublish`。

## 配置与运行

- `mosquitto`：建议配置包含 `listener 1883 0.0.0.0`、`allow_anonymous true`；可用 Windows 原生安装或 WSL/Docker。
- `ifconfig`：在 Windows 上通过 WSL 运行（`wsl ifconfig`）；如不可用，可提示安装 net-tools。
- `mdns/mdns.py`：通过 `python` 或 `wsl python3` 调用，支持 `publish/unpublish` 动作与必要参数。

## 错误与验证

- 常见错误码：`MQTT_START_FAILED`、`IFCONFIG_NOT_AVAILABLE`、`MDNS_PUBLISH_FAILED`
- 验证
  - MQTT：`mosquitto_sub -h localhost -t test -v`（匿名可连）
  - mDNS：`avahi-browse -a`（Linux）或 `dns-sd -B _http._tcp`（macOS）
  - IP：断网/切换网卡后重新调用 `GET /network/ips` 验证更新

以上为最小可行设计文档，覆盖接口、页面与运行要求。

## mDNS 脚本用法（简化）

- 文件：`mdns/mdns_register_ip.py`
- 用法：

```
pip install zeroconf
python mdns/mdns_register_ip.py --ip 192.168.1.100
```

- 说明：传入 IP 为本机可用 IPv4，进程常驻以保持广播。
