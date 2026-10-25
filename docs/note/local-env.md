# 本机环境与常用查询

## 当前版本与安装包

- 源码版本以仓库根 package.json 为准；版本号更新流程见 `docs/agent/update.md`。
- 本地测更新用的未打包安装版：`E:\smart\project\control-panel\.tmp\1.0.34-beta.2-win\win-unpacked\UnderSilicon.exe`。

## MQTT

- 本机 MQTT 客户端查询：`C:\easysmart\tools\emqx\bin\emqx_ctl.cmd clients list`。虚拟网页设备 clientId 形如 `vweb_v-web-cunzhi_xxxxxx`，面板 clientId 形如 `fb-client-DESKTOP-...`。

## 后端接口

- 查面板在线设备：`GET http://127.0.0.1:5278/api/devices`（Electron 内置后端）。进程内虚拟设备另走 `GET /api/virtual-devices`。

## 端口约定（测试用）

- 双隔离 Electron 被控端前端/后端/CDP `5303/5301/9224`（部分轮次 `9234`），主控端 `5304/5302/9225`；测试房间服务 `8787`，本机 MQTT `1883`。

## 串口工具链

- esptool 用 IDF 5.5 venv：`C:\Users\46907\.espressif\python_env\idf5.5_py3.11_env\Scripts\python.exe -m esptool`。
- MicroPython 工具（mpremote）在 IDF 5.2 venv；bleak 也装在该 venv。
