# 设备注册表

> 对照基准：`backend/devices/registry.js`

## 设备类型清单

| 设备类型 | 名称 | 能力集 | operations |
|---|---|---|---|
| `PJ01` | 往复电机控制器 | `strength` | start/stop + close |
| `TD01` | 偏轴电机控制器 | `strength` | start/stop + close |
| `OSR6` | OSR6 控制器 | `strength` | start/stop + close |
| `QIYA` | 气压传感器 | `sphincterPressure`、`reporting` | close |
| `DIANJI` | 电脉冲设备 | `shock` | start/stop + close |
| `ZIDONGSUO` | 自动锁 | `lock` | lock/unlock + close |
| `QTZ` | 测距及脚踏传感器 | `distance`、`buttonInput`、`tiptoePressure`、`reporting` | close |
| `DZC01` | 电子秤 | `weight`、`reporting` | close |
| `CUNZHI01` | 寸止玩法设备 | `sphincterPressure`、`tiptoePressure`、`strength`、`shock`、`reporting` | start/stop + close |

## 能力总表

| 能力 key | 名称 | actions | events | 拥有设备 |
|---|---|---|---|---|
| `strength` | 强度控制 | set(value:0-255) | — | PJ01, TD01, OSR6, CUNZHI01 |
| `shock` | 电击控制 | start(voltage), stop() | — | DIANJI, CUNZHI01 |
| `lock` | 锁控制 | setOpen(open:bool) | — | ZIDONGSUO |
| `sphincterPressure` | 括约压力 | — | pressureChange | QIYA, CUNZHI01 |
| `tiptoePressure` | 踮脚压力 | — | pressureChange | QTZ, CUNZHI01 |
| `distance` | 距离 | configure(lowBand, highBand, reportDelayMs) | enterLow, enterHigh | QTZ |
| `buttonInput` | 按钮输入 | — | pressed, pushDown, pushUp | QTZ |
| `weight` | 重量 | — | weightChange | DZC01 |
| `reporting` | 上报频率 | setReportDelay(ms) | — | QIYA, QTZ, DZC01, CUNZHI01 |

## 能力值映射

`sphincterPressure`、`tiptoePressure`、`distance`、`weight` 提供可读标量值。CUNZHI01 的 `tiptoePressure` 默认读取真实 `pressure1`；QTZ 则通过设备 override 从 `button0/button1` 派生，任一按钮为数值 `1`（含字符串 `"1"`）时返回 200，否则返回 0。

QTZ 的 0/200 是兼容玩法阈值判断的模拟状态值，不是 kPa 测量值，也不会在 BLE 属性目录中伪造 `pressure1` 特征。
