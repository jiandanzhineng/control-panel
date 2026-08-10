# 自动化测试页串口自动供给 E2E

真机联调脚本：`backend/tests/e2e/provisionRealDevice.e2e.js`。

覆盖「插上设备 → 自动串口连接 → 失败则自动烧录 → 再次连接 → 自动开始内置自动化测试」整条链路，
以及供给设置的读写、失败端口的手动重试、停止平台后恢复串口自动连接原值。

## 前置条件

- 一台 ESP32-C3 设备通过 USB（CH340，VID 1A86）接在本机，记下串口号（如 `COM17`）。
- 串口没被别的程序占用（VSCode 串口监视器、`idf.py monitor`、另一个后端实例都会占口）。
- 固件必须包含串口调试协议（`@DEBUG START` / `@DEBUG READY`）。
  截至 2026-08-10，线上 manifest 的 latest（v1.1.38）**不含**该协议，
  真机跑通需要本地编译固件并用本地 manifest 顶掉线上地址，见下一节。

## 准备本地固件与 manifest

线上固件不可用时，从 `hardware/` 本地编译 CUNZHI01 并 merge：

```powershell
# Git Bash 会把 MSYS 变量漏进 PowerShell 导致 idf.py 报 "MSys/Mingw is not supported"，先清掉
Remove-Item Env:MSYSTEM, Env:MSYS, Env:MINGW_PREFIX, Env:MSYSTEM_PREFIX -ErrorAction SilentlyContinue
. C:\Users\46907\esp\v5.2.3\esp-idf\export.ps1
idf.py set-target esp32c3
idf.py build
```

把 merge 出来的镜像放到 `.tmp/fwserver/firmware/latest/`，并写一份 `version.json`：

```json
{
  "latest_version": "v9.9.9-e2e",
  "firmwares": [
    {
      "device": "CUNZHI01",
      "kind": "merged",
      "filename": "under_silicon_CUNZHI01_e2e_merged.bin",
      "object_key": "firmware/latest/under_silicon_CUNZHI01_e2e_merged.bin",
      "size_bytes": 1577488,
      "sha256": "<镜像的 sha256>"
    }
  ]
}
```

`size_bytes` 和 `sha256` 必须和实际文件一致，否则烧录前的校验会失败。

起一个静态服务托管这个目录（脚本可放 `.tmp/fwserver.js`，监听 `127.0.0.1:3999`，
把 `req.url` 映射到 `.tmp/fwserver/` 下的文件即可）。

## 启动后端

```bash
cd backend
PORT=3100 \
BACKEND_DATA_DIR=<仓库>/.tmp/e2e-data \
FIRMWARE_BASE_URL=http://127.0.0.1:3999 \
node index.js
```

`BACKEND_DATA_DIR` 指向一个空目录，让供给设置从默认值（`autoFlash:false`）开始，
避免上一轮残留的设置影响断言。

## 跑脚本

```bash
cd backend
E2E_PORT=COM17 E2E_DEVICE_TYPE=CUNZHI01 BACKEND_URL=http://127.0.0.1:3100 \
  node tests/e2e/provisionRealDevice.e2e.js
```

全绿是 `结果: 23/23 通过`。任一断言失败进程以非 0 退出。

## 想覆盖烧录分支

设备已经是好固件时，第一次握手就成功，脚本只会走 `probing → connected`，烧录分支被跳过。
要强制覆盖烧录，先把 flash 擦掉再跑（注意：会清掉 NVS，WiFi 配网信息丢失，属预期）：

```bash
# 先停掉后端，否则串口被占用
"C:/Users/46907/.espressif/python_env/idf5.2_py3.11_env/Scripts/python.exe" \
  "C:/Users/46907/esp/v5.2.3/esp-idf/components/esptool_py/esptool/esptool.py" \
  --chip esp32c3 --port COM17 erase_flash
```

擦完再启动后端跑脚本，阶段流转应是 `probing → flashing → connected`。

## 排查

- `SERIAL_OPEN_FAILED`：串口被别的程序占了。这个错误码**不会**触发烧录（设计如此）。
- `SERIAL_PROBE_TIMEOUT` 但设备明显在跑：固件不含串口调试协议，见上文。
- 端口停在 `failed` 且不再自动重试：这是约定行为，终态会保留端口预留以阻断自动重烧，
  需要点页面上的「重试」或重新插拔。
- 步骤 [4] 采样 30 秒是因为 CUNZHI01 的 loop 有 4 步、每步 2 秒（一轮 8 秒），
  `shock=1` 只在其中一步保持，窗口太短会偶发漏采。
