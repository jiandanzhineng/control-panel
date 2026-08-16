# 虚拟设备网页（CUNZHI01 调试台）

浏览器冒充一台 CUNZHI01：滑块调踮脚压力，页面实时显示电击状态和跳蛋强度。
用来在没有真硬件时调玩法（反射弧阈值、电击时机、规划层反应）。

## 与 control-panel 的关系

**没有代码耦合**。这个页面走 MQTT 直接当一台真设备接入，control-panel
认不出它是网页——它走的是和真 ESP32 固件完全相同的 topic 和报文格式。

唯一的文件级依赖是 `server.js` 从 `../backend/node_modules/mqtt/dist/mqtt.min.js`
借浏览器版 mqtt 库（只读一个文件）。想彻底独立就把它拷到 `vendor/mqtt.min.js`，
`server.js` 会优先用那份。

和 `backend/services/virtualDeviceService.js` 的虚拟设备是两条独立路线：
后者在 control-panel 进程内注入消息，前者从进程外经 broker 进来。

## 用法

```powershell
node server.js                 # 默认 http://127.0.0.1:3100
$env:PORT=3200; node server.js # 换端口
```

浏览器打开 → 填 Broker 和设备 ID → 连接。默认值：

| 项 | 默认 | 说明 |
|---|---|---|
| Broker | `ws://127.0.0.1:8083/mqtt` | EMQX 的 WebSocket 监听口，匿名可连 |
| 设备 ID | `v-web-cunzhi` | control-panel 里的设备 id |
| 上报间隔 | 500ms | 周期发 pressure/pressure1/battery/game_cz_count（固件默认 5s） |

连上后 control-panel 会自动注册这台设备（`report` 报文触发），
在设备列表里和真设备一样可见、可控。断线（Keepalive timeout 等）会
按 1s/2s/4s…最多 15s 自动重连；点「断开」才停。页签回前台立刻重试。

## 协议

对齐 `hardware` 里 CUNZHI01.c + base_device.c。订阅 `/drecv/<id>` 和 `/all`。

上行 `/dpub/<id>`：
- `{"method":"report","ver":"...","device_type":"CUNZHI01",...全部属性}` — 连上立刻发，之后每 10s 心跳
- `{"method":"update","pressure":0,"pressure1":45,"battery":0,"game_cz_count":0}` — 周期上报

下行 `/drecv/<id>` 或 `/all`（set/update 只改状态，不 MQTT 回显）：
- `{"method":"update","shock":1,"voltage":20}` — 电击开
- `{"method":"update","shock":0}` — 电击关
- `{"method":"update","power":200}` — 马达/跳蛋强度（0~255）
- `{"method":"set","key":"power","value":50}` — 单属性
- `{"method":"get","key":"battery","msg_id":102}` — 回复 `{"method":"update","msg_id":102,"key":"battery","value":0}`
- `{"method":"dian","voltage":12,"time":1500}` — 旧式定时电击（自动停，真机已不用）

`pressure1` 是 `tiptoePressure` 能力读的字段，滑块动的就是它。
压力条上那条白线是数字人 `tiptoe-punish` 弧的阈值 30。

`power` 是 `strength` 能力（跳蛋/马达强度）写的字段，0~255。页面上那张紫色卡片
显示它：数值、百分比、档位名（弱/中/强/最强）、变更次数和最近一次时间；
大于 0 时卡片会按强度成比例地抖动。它是只读的——只反映下行指令，页面上没有
手动调它的控件，因为真设备的强度也只由上位机决定。

## 接数字人玩法

玩法默认绑 `v-pressure`/`v-shock`。要用这个网页设备，启动时指定绑定：

```powershell
.venv\Scripts\python.exe src\server.py --play `
  --play-sensor v-web-cunzhi --play-punisher v-web-cunzhi
```

CUNZHI01 同时有 `tiptoePressure` 和 `shock`，所以两个角色可以填同一台。

拖滑块过 30 → 反射弧命中 → 电击下行回到页面（电击框变红）→ 数字人说「啧」。

## 测试

```powershell
node selftest.js   # 协议逻辑，不需要 broker
node e2e.js        # 真链路：注册 -> 读压力 -> 下发电击 -> 设备收到
```

`e2e.js` 需要 control-panel（3000）和 broker（8083）都在跑，用完自动删掉测试设备。
