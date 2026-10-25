# 插线固件更新设计

## 1. 目标与场景

设备(ESP32-C3)通过 USB 线连接电脑,在 control-panel 中完成固件整片烧录更新:
选串口 → 自动识别型号(失败则手选)→ 版本对比 → 烧录(带进度)→ 自动重启。

补 WiFi OTA 覆盖不了的场景:设备变砖救回、WiFi 配不进去、产线首次烧录。

## 2. 不复用 WiFi OTA 通道的部分与复用的部分

- 复用:固件清单拉取方式(`firmware.undersilicon.cn/firmware/latest/version.json`,随机 query 防缓存),取 `kind='merged'` 条目(整片烧录镜像,烧录地址 `0x0`),校验 `size_bytes` + `sha256`。
- 新通道:串口烧录(esptool-js + serialport),与 `firmwareOtaService` 的 MQTT 下发完全不同。

## 3. 关键技术决策(全部为真机实测结论)

### 3.1 esptool-js 在 Node 的集成

- esptool-js 0.6.1 为 ESM,CJS 后端用动态导入:`await import('esptool-js/bundle.js')`。
  不可 import `esptool-js/lib/*`(内部为无扩展名 ESM 引用,Node 无法解析)。
- `Transport` 需要 WebSerial 形态的 device 对象。自实现适配层
  (`backend/transports/nodeSerialDevice.js`):队列缓冲的 readable(允许多次 readLoop 重入)、
  writable(write+drain)、`setSignals` 映射 `port.set({dtr,rts})`。
  **不要用 `Readable.toWeb()`**,实测 readLoop 读不到数据。

### 3.2 DTR/RTS 与控制线映射(CH343 板卡实测,与乐鑫默认约定不同)

| 信号 | 作用 |
|---|---|
| `DTR=false` | EN 拉低(芯片保持复位) |
| `DTR=true` | EN 释放(运行) |
| `RTS=false` | BOOT(GPIO9)拉低 |
| `RTS=true` | BOOT 释放(高) |

- 进下载模式(从 app 状态 6/6 一次成功):`{dtr:false,rts:true}` 300ms → `{dtr:true,rts:false}` 300ms。
  注意 `{dtr:false,rts:false}` → `{dtr:true,rts:false}` 的直踩时序实测**不可靠**(芯片保持复位)。
- 复位回 app:`{dtr:false,rts:false}` 150ms → `{dtr:true,rts:true}`。
- **不用** esptool-js 自带的 ClassicReset/HardReset(其 Classic 序列在本板卡上进不了下载模式,
  HardReset 会把芯片拉死)。统一由 `backend/transports/serialReset.js` 先手动进下载模式,
  再 `esploader.main('no_reset')` 同步;连接失败重试 3 次。

### 3.3 烧录参数

```js
writeFlash({
  fileArray: [{ data, address: 0x0 }],
  flashMode: 'dio', flashFreq: '80m', flashSize: '4MB',
  eraseAll: false,          // 不整片擦除(用户决策)
  compress: true,
  reportProgress: (i, written, total) => {...},
})
```

- merged 镜像从 0x0 连续覆盖到 app 末尾,NVS/otadata 在覆盖范围内,
  **烧完后 WiFi 配网/绑定信息丢失,需重新配网**(即使不 erase 也一样,属预期,定位即"彻底重置/救砖")。
- 实测 1.5MB merged bin @115200 压缩传输约 78.6 秒。

### 3.4 型号识别走启动日志,不走 @DEBUG START 握手

- 固件已有 `@DEBUG START` 握手(device_serial_debug.c),但首台联调设备(QTZ)因 VL6180X
  传感器故障 first-ready 失败,握手不可用;且旧固件没有该功能。
- 启动日志里包含全部所需信息:
  - 版本:`App version:      v1.1.38`
  - MAC:`MAC Address: 6055f97c342c`(或 `wifi:mode : sta (60:55:f9:7c:34:2c)`)
  - 型号:日志标签如 `QTZ: device_init`(型号列表与 hardware 仓库 CI 矩阵一致:
    TD01/DIANJI/QTZ/ZIDONGSUO/PJ01/QIYA/DZC01/CUNZHI01)
- 识别流程:打开串口 115200 → `{dtr:true,rts:true}` → 复位脉冲 `{dtr:false,rts:false}` 150ms →
  `{dtr:true,rts:true}` → 采集 4 秒输出,**先累积成完整文本再正则**(按 chunk 匹配会漏,实测教训)。
- 识别不到型号返回 identified:false,前端提示用户手选。

## 4. 后端结构

- `backend/transports/nodeSerialDevice.js`:serialport → WebSerial 形态适配层。
- `backend/transports/serialReset.js`:线控时序(withPort/setLines/enterDownloadMode/hardResetToApp)。
- `backend/services/firmwareManifestService.js`:清单拉取/校验/条目查询(从 firmwareOtaService 抽取共用,OTA 行为不变)。
- `backend/services/wiredFlashService.js`:串口枚举、型号识别、固件下载缓存(`backend/data/wired-flash-cache/`,按 sha256 命中)、烧录编排、状态机推送。
- `backend/routes/wiredFlash.js` → `/api/wired-flash`:
  `GET /ports`、`POST /identify`、`GET /firmware`、`POST /flash`、`GET /flash/:flashId/status`。
- 烧录状态机:`downloading → verifying → entering_bootloader → flashing(0-100%) → resetting → success / failed`。
- 与 serialConnectionService 的互斥:端口被串口连接占用时报 `SERIAL_PORT_BUSY`。

## 5. 前端

`frontend/src/views/WiredFlashUpdate.vue`,路由 `/devices/wired-flash`,设备管理页加入口。
流程:选串口 → 自动识别(失败手选)→ 版本对比 → 二次确认(明示配网丢失)→ 进度条 → 成功提示重新配网。

## 6. 已知边界

- 本线控时序按 CH343 板卡实测标定;若未来换桥接芯片(CH340/CP2102)或改用 C3 原生 USB,
  需要重新验证(原生 USB 在 esptool-js 走 UsbJtagSerialReset 路径)。
- CH340/CH343 驱动依赖系统自动安装,当前不做安装包集成。
- 烧录耗时约 80 秒(115200),后续可评估提高到 460800 波特率。

## 7. 迭代(2026-08-09 下午):页面合并 + 驱动检测 + 识别修正

- 页面合并:新增 `FirmwareUpdate.vue` 外壳(`/devices/firmware`,el-tabs),
  OTA(`FirmwareBatchUpgrade`)与插线烧录(`WiredFlashUpdate`)作为子路由页签;
  旧路由 `/devices/firmware-batch`、`/devices/wired-flash` 重定向到新页签,
  设备管理页两个入口按钮合并为「固件更新」。
- 插线页压缩:四卡片合并为「连接与识别」「固件与烧录」两卡片,一屏可读完。
- 驱动检测:`GET /api/wired-flash/driver-status`(Windows 下查 Win32_PnPEntity 中
  VID_1A86 且 ConfigManagerErrorCode≠0 的设备)。前端串口列表为空时自动检测,
  发现驱动缺失引导用户到 wch.cn 下载 CH341SER。不做自动安装(需 UAC,静默参数不可靠)。
- 识别修正:型号解析优先取 `device_init`/`on_device_init` 行的日志标签,
  避免共享组件标签(如 `td01:` 模块)或正文偶发型号字符串误判;无 init 命中再回退全文词边界匹配。
  实测注意:日志标签跟随所刷固件类型,识别结果反映的是设备上当前固件,不代表硬件型号。

## 8. 迭代(2026-08-09 晚):型号识别改走 `@DEBUG IDENTIFY` 协议

- 固件侧(hardware 仓库):
  - `device_identity` 身份 JSON 新增 `device_type` 字段(编译期 `DEVICE_TYPE_NAME` 常量),
    `@DEBUG READY` 与新增的 `@DEBUG IDENT` 共用同一载荷。
  - `device_serial_debug.c` 新增只读查询:`@DEBUG IDENTIFY` → `@DEBUG IDENT {json}`。
    不开启调试会话、不触发 `device_first_ready`、任何状态下都可应答。
    原因:`@DEBUG START` 握手以 first-ready 为前提,QTZ 样机 VL6180X 传感器故障时握手必然失败,
    且识别不该改变设备状态;旧固件不认识该命令,静默忽略。
- 客户端侧(`wiredFlashService.identify`):
  - 流程:复位进 app → 采集 4 秒启动日志(兜底数据源)→ 发 `@DEBUG IDENTIFY`,
    等最多 2.5 秒身份帧。
  - 收到含 `device_type` 的 IDENT 帧直接采信,返回 `source:'protocol'`;
    无帧或无 `device_type`(旧固件)回退启动日志解析,返回 `source:'bootlog'`,
    IDENT 帧里的 MAC/版本仍合并进结果。
  - 身份帧解析不锚定行首:上行日志若没换行,帧会黏在日志文本后面(实测踩到)。
- 前端插线页:自动识别成功时标注来源(协议/启动日志)。
- 真机实测(COM17,QTZ v1.1.38,传感器故障机):协议识别 4.4 秒返回
  `{deviceType:"QTZ", version:"v1.1.38", mac:"6055f97c342c", source:"protocol"}`,
  该机的 bootlog 兜底路径此前已验证。
- 局限不变:`device_type` 仍是"当前固件的型号",刷错 bin 的设备会报错型号;
  绑定硬件需出厂写独立 NVS 分区/eFuse,暂不做。
