# Control Panel

单机自用的硬件控制面板：把"玩法"（游戏 / 插件）产生的信号，经本机 bridge 下发到真实设备（如电击、震动）。

## Language

**游戏 (Game)**：
面板自己 serve 的一段 HTML 玩法，跑在面板 origin 的 iframe 里，输入信号来自硬件传感器上报。
_Avoid_: 关卡、玩法（"玩法"是游戏+插件的上位概念，别单指游戏）

**插件 (Plugin)**：
挂在真实第三方网站上的一段检测脚本（detector），输入信号来自用户在该网站的真实行为（如答错单词）。与游戏并列，是第二种玩法载体。
_Avoid_: 扩展、脚本

**玩法载体 (Play Carrier)**：
承载一次玩法运行的容器。游戏的载体是面板 iframe；插件的载体是加载真实网站的 webview。

**Detector**：
插件注入到目标网页的检测脚本，跑在 webview preload（Node 环境）里，判定行为并驱动设备。附带注入右下角**悬浮状态 UI**——**只显示状态**（⚡触发次数、对/错计数），**不含停止按钮**（detector 关不掉自己的宿主 webview，停止唯一入口是运行页导航栏，见 [[退出信号]]）。

**Bridge**：
本机 WebSocket 通道（`/bridge`），把玩法侧的 DeviceAPI 调用转成后端设备下发。游戏与插件共用同一协议。

**DeviceAPI**：
玩法侧统一的设备驱动抽象。游戏用浏览器 WebSocket 接 bridge（`device-api-bridge.js`），插件 detector 用 Node `ws` 接 bridge，接口一致但**各自独立实现**——detector 照抄一份 Node 版，刻意不与游戏侧抽公共层，避免为插件重构跑得好的游戏代码。协议一致（init/invoke/writeProps/subscribe），故代价是协议若大改需改两处（当前协议稳定）。

**设备映射 (Device Map)**：
把玩法声明的逻辑设备 id（如 `shock`）映射到真实物理设备 id 的配置，启动前一次性选定。

**激活配置 (Active Config)**：
写在 `active-plugin.json` 的一次性**配置信箱**——只给 detector 传 pluginId + deviceMap + params，detector 启动时同步读取。它**不承担运行状态语义**："当前跑的是谁"的真相在 bridge 的活跃 session（见 [[0005-backend-authoritative-play-state]]），不看这个文件。
_Avoid_: 把它当"当前激活状态"的真相来源

**设备复位 (Device Reset)**：
让当次映射的所有设备回到停止态的动作——对每个设备按其能力逐一调 `stop`（电击归 0、强度归 0）。设备侧没有统一的 `close`，"复位"就是逐能力 `stop` 的组合。触发有两条通道，见 [[退出信号]]。
_Avoid_: close、关闭（口语可说"关掉设备"，但模型里是逐能力 stop）

**退出信号 (Exit Signal)**：
玩法正常退出时主动发给 bridge 的显式信号，是设备复位的主通道。插件由主进程监听 webview 销毁后发出，游戏由前端离开时发出。信号**不带 id**——含义为"复位当前活跃玩法"，靠全局唯一约束定位。与之互补的是 ws 断开后的 60 秒宽限期（仅兜底崩溃/断电等异常，不承担正常退出）。见 [[0005-backend-authoritative-play-state]]。
