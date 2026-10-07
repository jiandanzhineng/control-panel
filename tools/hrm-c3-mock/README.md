# hrm-c3-mock —— ESP32-C3 虚拟心率带（标准 BLE HRS 假设备）

给 control-panel / 移动端做**心率接入测试**用，替代真实心率带。真机心率带只能被一个中央连接占用、读数不可控，没法脚本化；这块假设备可以固定心率、模拟接触丢失和无数据。

## 硬件

- ESP32-C3 开发板，USB 串口 `COM17`（CH343），芯片 MAC `60:55:f9:7c:34:2c`，BLE 地址 `60:55:f9:7c:34:2e`
- 板载 MicroPython `v1.26.1`（刷机包 `E:\smart\microPython\ESP32_GENERIC_C3-20250911-v1.26.1.bin`）
- 广播名 `HRM-Virtual`（刻意与真机 `HRM_Sensor` 区分）

## 部署

```powershell
pwsh -File deploy.ps1              # 默认 COM17
pwsh -File deploy.ps1 -Port COM17
```

等价手工命令（需要已装 mpremote）：

```powershell
$mp = "C:\Users\46907\.espressif\python_env\idf5.2_py3.11_env\Scripts\python.exe"
& $mp -m mpremote connect COM17 fs cp hrm.py :hrm.py
& $mp -m mpremote connect COM17 fs cp main.py :main.py
& $mp -m mpremote connect COM17 reset
```

## GATT 结构

| 服务 | 特征 | 属性 |
| --- | --- | --- |
| `0x180D` Heart Rate | `0x2A37` 测量 | notify + read |
| | `0x2A38` 佩戴位置 | read（1 = 胸部） |
| | `0x2A39` 控制点 | write |
| `0x180F` Battery | `0x2A19` 电量 | read + notify（60s） |
| `0x180A` Device Info | `0x2A29/0x2A24/0x2A25/0x2A26` | read（序列号 = 基础 MAC） |
| `0x00FF` 面板身份 | `0xFF04` | read，JSON 遵循 `docs/adr/0010` |
| `0xFFE0` 测试控制 | `0xFFE1` 命令 | write |
| | `0xFFE2` 状态 | notify + read |

心率帧按标准组：`flags + 心率(8bit) + 能量消耗(kJ) + RR 间期(1/1024s)`，1Hz 上报。

## 控制命令

两条通道，命令文本一样（空格或分号分隔多条）：

- **BLE**：写 `0xFFE1`，状态从 `0xFFE2` 回读/通知
- **REPL**：`Ctrl-C` 中断主循环（BLE 连接不受影响）→ `import hrm` → `hrm.cmd("hr=150")` → `hrm.run()` 继续

| 命令 | 作用 |
| --- | --- |
| `hr=150` | 立即固定为 150bpm（切到 fixed，测试断言用这个） |
| `mode=cycle` | 自主循环：静息 68 → 爬升到 150 → 保持 → 回落，180s 一轮（**默认**） |
| `mode=rest` | 静息 68，带一阶惯性（约 8s 时间常数） |
| `mode=fixed` | 用当前 `hr_fixed` 值 |
| `mode=nocontact` / `contact=0` | 标准「接触未检测」：flags 清掉 detected 位、心率报 0 |
| `mode=silent` | 连接保持但不再推数据（模拟戴着无数据，练看门狗/超时） |
| `rr=0/1` | 帧里是否带 RR 间期 |
| `energy=0/1`、`reset` | 能量消耗字段开关 / 归零 |
| `battery=42` | 改电量（立即写入特征） |
| `noise=2.5` | 心率抖动幅度 |
| `name=X`、`adv=on/off` | 改广播名 / 开停广播 |
| `status`、`help` | 回读状态 / 命令表 |

## 主机侧自测

```powershell
& "C:\Users\46907\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe" host_test.py
```

扫描 + 连接 + 身份 + 20 项场景断言，全绿即固件正常（实测 20/20 通过）。

## 注意事项

- **心率带类设备只允许一个中央连接**。测试脚本连上去写命令时，panel / 手机就连不上，反之亦然。要脚本控制就先设好参数再断开，让 panel 连；或者直接用默认自主模式。
- 接 panel 时的 Web Bluetooth 过滤用 `services: [0x180D]` 即可命中（广播包里有该 16 位 UUID）。
- 使用 `mpremote`/串口工具时，**DTR/RTS 会把板子按在复位态**：手工开串口要先把 DTR、RTS 都置 False 再读。
- 本目录的 `main.py` 会覆盖板上原来的 `tools/ycy-c3-mock/main.py`（役次元杯 mock）。切回去：

```powershell
& $mp -m mpremote connect COM17 fs cp ..\ycy-c3-mock\main.py :main.py
```

