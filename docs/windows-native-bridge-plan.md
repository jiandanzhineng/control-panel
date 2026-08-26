# 跨平台本机桥（Native Bridge）方案

> 目标：让 **Windows / macOS / Linux** 的 Electron 客户端都能用「本机桥接（native）」直连役次元(YCY)与郊狼(DG-LAB Coyote)。
> 选型：**Rust + btleplug + axum**（一个二进制通吃三平台，Windows BLE 走 WinRT 最稳，且可取代现有 macOS Swift 桥）。

## 0. 为什么做
- 网页蓝牙(Web BLE)在 Windows 已是本地直连且功能更强（可下原始强度/通道/帧/泵），但部分设备/浏览器枚举自定义 GATT 不稳定，需要「本机桥接」作为统一、兜底的本地通道。
- 现有「本机桥接」是 macOS 专属 Swift 二进制（`tools/ycy_bridge` / `tools/dglab_bridge`），靠 launchd / 手动起，其他平台与用户无法使用。
- 已改为 Electron 主进程内 `superviseBridge()` 监管（崩溃自启、跨平台、随 app 生命周期）。本次把桥本身做成跨平台 Rust 二进制。

## 1. 已核实的契约（前端零改动）
桥为 **纯 GATT 透传 + HTTP REST（轮询，无 WebSocket）**；AES-128-ECB 在客户端算好 hex 再由 `/api/send` 下发，桥不加密。

- **YCY `:3001`**：`GET /api/status`、`GET /api/devices`、`POST /api/rescan`、`POST /api/connect?addr=`、`POST /api/disconnect?addr=`、`POST /api/identify?id=`、`POST /api/send({addr,frame|frames,write?})`
  - status 返回：`{ bluetoothOn, explicitAddr, devices:[...], notifications:{id:[hex...]} }`
  - device：`{ id, name, rssi, ready, battery?, isTarget?, connection:{service?,write?,notify?}, services:[{uuid,chars:[{uuid,props:[]}]}] }`
- **郊狼 `:3002`**：`GET /api/status`、`GET /api/devices`、`GET /api/battery?addr=`、`POST /api/rescan`、`POST /api/connect?addr=`、`POST /api/disconnect?addr=`
  - device：`{ id, name, rssi, ready, isTarget?, battery:number|null }`（connection 始终 `{}`）
- 设备识别关键字：
  - YCY：`YCY,YYC,YSKJ,YOKO,YOKONEX,YISK,DJ-V2,YICIYUAN,DJ`
  - 郊狼：`D-LAB,DG-LAB,47L,COYOTE,YSKJ,ESTIM`
- 候选写服务（YCY 优先匹配）：`ff30/ff40/98a9cd00../6e400001..`
- 电量：标准 `180F/2A19`（YCY）；郊狼按「单字节 0-100」经 notify/read 校准。

## 2. 架构
```
设备BLE ─(btleplug: Win=WinRT / macOS=CoreBluetooth / Linux=BlueZ)─> 桥进程(Rust)
                                                                         │
                                           Electron superviseBridge() 崩溃自启（已就绪）
                                                                         │
                                           HTTP REST :3001/:3002 ─> 前端 ycyBridge.ts / dglabBridge.ts
```

## 3. 仓库改动
1. 新 `bridge/` Rust crate（lib + 两个 bin `ycy_bridge` / `dglab_bridge`，共享 lib）。
2. `package.json` extraResources：**按平台**放二进制（移除当前无差别打 macOS 二进制的 ~440KB 死重）；macOS 落 `tools/ycy_bridge`/`tools/dglab_bridge`（覆盖 Swift 产物），Windows 落 `.exe`。
3. `electron/main.js` `superviseBridge()`：放开 `win32`（spawn 对应 `.exe`）。
4. `BrandsPanel.vue`：删 line 35/241 的 `v-if="isMac"`，全平台显示「本机桥接」。
5. 文档：本文件 + `V2-WEBBLE-GUIDE.md` 跨平台说明。

## 4. 移植难点（按风险）
1. **GATT 枚举稳定性**：自定义服务 UUID 在 Windows 枚举行为不同，需真机验证。
2. **配对/绑定**：Windows BLE 配对弹窗与 macOS 不同。
3. **多设备并发**：YCY 支持同连多台，需 per-device 表。
4. 通知回流 = 轮询（桥缓存 hex 随 status 回传），传输层极简。

## 5. 分阶段
- **Phase 1（macOS 先跑通，取代 Swift 桥）**：用现有 Mac+设备验证协议/REST/AES 向量，风险最低。
- **Phase 2（Windows 真机）**：验证 YCY+郊狼枚举/连接/AES/通知，修 Windows 专属坑；`superviseBridge` 放开 win32；UI 放开；Linux 冒烟。
- **Phase 3（打包）**：extraResources 分平台 + 构建脚本（`npm run build:bridge`）。
- **Phase 4（全量真机）**：三平台 + 崩溃自启验证。

## 6. 硬前提
- 必须有 **Windows 真机 + 真设备** 验证，无法纯靠编译。
- 分发需 codesign(mac) / 代码签名+SmartScreen(Win)；Windows 多为 x64，需 x64 构建。
- Windows 下 btleplug 需 WinRT 支持，建议在 Windows 上构建（或配置好 WinRT 交叉环境）。

## 7. 工作量粗估
Rust 路线 ≈ 1–2 周（骨架 + 两品牌 GATT/AES + Win 调坑）。Phase 1（macOS 取代 Swift）可立即用现有硬件验证。

## 8. Windows ELE 适配（作为 control-panel 的扩展，非独立端）
本机桥是 **control-panel 现有 Electron 端（UnderSilicon）的扩展功能**：
- 桥二进制由 `electron/main.js` 的 `superviseBridge()` 监管（崩溃 1s 自启、随 app 生命周期），不是独立进程/独立 app。
- UI 只是 `BrandsPanel.vue` 里的一个「本机桥接」单选模式；前端经 `ycyBridge.ts`/`dglabBridge.ts` 直接 `fetch http://127.0.0.1:3001|3002`（CORS `*`），无需后端中转。
- 打包时桥作为 `extraResources` 进入 `resources/tools/`，`getResourcePath()` 在开发/打包两种环境都能解析。

### 8.1 已确认可绕开的 Windows 坑
- **蓝牙 manifest capability 不需要**：`package.json` 的 `win.target` 是 `nsis`（非 UWP/AppX 打包的 Win32 桌面应用）。btleplug 的 WinRT BLE 在**非打包** Win32 进程下可直接用，不受 UWP `bluetooth` DeviceCapability 限制。仅当用户改用 `appx` 目标时才需补 manifest。
- **路径/扩展名**：`superviseBridge()` 已按 `process.platform === 'win32'` 自动补 `.exe`，`cwd` 指向 `resources/tools/`，`spawn` 用数组参数（无 shell，路径含空格也安全）。
- **防火墙**：桥只监听 loopback `127.0.0.1`，不对外暴露端口，首次运行一般不弹防火墙。

### 8.2 真正卡点（需你的环境 / 外部资源）
1. **Windows 真机 + 真设备验证**：沙箱无 Win 硬件，且 btleplug 的 WinRT 后端最好在 Windows 上构建。拿到 `.exe` 后在 Win 机器点连 YCY/郊狼，验证枚举→连接→AES→通知。
2. **Windows 二进制来源**：二选一
   - (a) 本机：`cargo build --release --manifest-path bridge/Cargo.toml`，产物 `bridge/target/release/{ycy_bridge,dglab_bridge}.exe` → 经 `npm run build:bridge` 复制到 `tools/`。
   - (b) CI：见 `.github/workflows/build-bridges.yml`，push/手动触发后在 Actions 下载 `bridges-windows-x64` artifact，解压到 `tools/` 即可。
3. **SmartScreen / Authenticode**：未签名 `.exe` 首次运行会被 Windows Defender SmartScreen 拦截。需 Authenticode 代码签名证书（EV 证书可更快积累信誉）。macOS 侧需 `codesign`（Gatekeeper）。
4. **默认通道**：当前 `BrandsPanel.vue` 默认 `isMac ? 'native' : 'webble'`——非 Mac 仍先走最稳的网页蓝牙，避免未签名桥直接报错。Windows 验证 + 签名就绪后可考虑全平台默认 `native`。

### 8.3 落地顺序建议
1. macOS 端已跑通（Phase 1 完成，真机验证通过）。
2. 推仓库 → CI 自动产出 Win `.exe` + Mac 双架构（见 8.2-2b）。
3. 你回 Windows 真机：放 `.exe` 进 `tools/` → `npm run build:win`（或 `build:installer`）→ 安装后点连验证。
4. 签名（mac codesign / Win Authenticode）后放开全平台默认 native。

