# ESP32-C3 虚拟心率带（HRS）

同一块 C3 板（COM17 / CH343，芯片 MAC `60:55:f9:7c:34:2c`，BLE 地址 `60:55:f9:7c:34:2e`），广播名 `HRM-Virtual`。固件在 `tools/hrm-c3-mock/`（MicroPython `hrm.py` + 开机自启 `main.py`）。

## 部署与使用

- 部署：`pwsh tools/hrm-c3-mock/deploy.ps1`（mpremote 1.29.0 已装在 IDF 5.2 venv）。
- 主机自测：`python tools/hrm-c3-mock/host_test.py`（21 项检查；bleak 只装在 `C:\Users\46907\.espressif\python_env\idf5.2_py3.11_env\Scripts\python.exe`）。
- 面板连着时改场景：`python tools/hrm-c3-mock/serial_cmd.py "contact=0"`（走串口 REPL）。

## 服务与命令

- 标准 `0x180D`（`0x2A37` notify 1Hz / `0x2A38` / `0x2A39`）+ `0x180F` 电量 + `0x180A` 设备信息（序列号 = 基础 MAC）+ `0x00FF` 面板身份 `0xFF04` + `0xFFE0` 测试控制（`0xFFE1` 写文本命令）。
- 命令：`hr=150` 立即固定、`mode=cycle/rest/fixed/nocontact/silent`、`contact=0`、`rr=0/1`、`battery=NN`、`noise=F`、`adv=on/off`。

## 坑

1. 写命令要占用设备唯一中央连接，panel/手机连着时脚本连不上。
2. 串口工具打开端口时 DTR/RTS 会把板子按在复位态，需同时置 False 才能读到输出。
3. 该 `main.py` 覆盖了板上原来的 `ycy-c3-mock`，切回命令见 README。
4. 面板接入：品牌页自动连接，设备类型 `HRM`、能力 `heartRate`，设备 ID 取 0xFF04 = `6055f97c342c`。

## 实测：标准 BLE 心率带（2026-10-07）

- 本机蓝牙：Realtek Bluetooth 5.0 Adapter（USB VID_0BDA&PID_8771）。
- 工具：`E:\smart\tools\ble-heart-rate\scan.py`（扫描 BLE 广播并标记标准心率服务 0x180D）、`verify.py`（连接并订阅 0x2A37 读实时心率）。
- 运行：`C:\Users\46907\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe`（该 venv 已装 `bleak`，参数 `<MAC> [秒数]`）。
- 实测：心率带 `HRM_Sensor` MAC `CB:72:59:CB:97:F3`，广播 0x180D + 0x180A，服务含 Heart Rate / Device Information / Battery。
- 注意：同一心率带被手机 App 占用时会连接失败或读不到数据。
- HRS 接触位：bit2 表示支持接触检测，bit1 表示已接触（最初实现写反过）。
- 心率带功能已在 `develop` 合入（`15931dc feat(hrm)`），设备类型 `HRM`、能力 `heartRate`。
- 同一批提交里 `869edff` 修复了远程会话分支引入的问题：本地游戏 iframe 的 sandbox 被设成 "undefined"，导致所有本地游戏无法运行。

## 同一块 C3 板当 YCY-FJB-03 模拟杯

- 广播名 `YCY-FJB-03`，GATT `FF40`（`FF41` 写 / `FF42` 通知）；固件 MicroPython `tools/ycy-c3-mock/main.py`。
- 真机端到端命令：`node tools/noble-ycy-e2e.js`。
- esptool 用 IDF 5.5 venv：`C:\Users\46907\.espressif\python_env\idf5.5_py3.11_env\Scripts\python.exe -m esptool`。
