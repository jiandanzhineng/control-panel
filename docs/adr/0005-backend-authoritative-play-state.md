# 运行状态权威：bridge 连接即真相，唯一性与复位收敛到 session 生命周期

**背景**：需实现"全局同时只有一个玩法在跑（游戏/插件互斥，自动顶掉）"和"退出/切换必对设备复位"（见 [[0004-single-active-play-carrier]]）。但游戏在后端完全无状态（`games.js` 的 status/start/stop 都不记状态），插件状态在 `active-plugin.json`，没有任何一方同时看得见两种玩法及其设备映射。

**决定**：不额外维护运行状态，以 **bridge 的 WebSocket 连接为唯一真相**。所有唯一性与复位逻辑收敛到 bridge 的 session 生命周期：

1. bridge 维持"全局同时只有一个活跃 session"。
2. 新玩法 `init` 握手时，若已有旧 session：先对旧 session 的 `deviceMap` 逐能力 `stop` 复位、断开旧 session，再建新 session（= 自动顶掉 + 顶掉即复位）。
3. **复位双通道，与"ws 断开"解耦**（避免短时重连误复位）：
   - **正常退出（主道，显式信号）**：插件运行页 webview 关闭 → **主进程监听 webview 销毁并发退出信号**（页面已关，detector 自己发不出）；游戏 → 前端离开时发退出信号。信号**不带 id**，含义为"复位当前活跃玩法"（靠全局唯一约束定位）→ bridge 复位当前活跃 session 的设备 + 清 session。
   - **ws 断开（兜底，60 秒宽限期）**：ws `close` **不再立刻复位**，session 转"待定"并起 60 秒计时器；60 秒内任意重连 init 即恢复（不复位）；超时未重连才兜底复位 + 清 session。仅处理进程崩溃/断电/来不及发信号等异常。

**为什么**：游戏和插件本就都连 bridge、init 时都上交 deviceMap，复位所需信息 bridge 现成握有（`GameSession.deviceMap`）。两条硬约束遂成为 session 生命周期的自然结果，游戏/插件侧零改动，且无需给游戏补后端状态——ADR-0004 中"游戏后端无状态"的矛盾随之消失。

**后果**：唯一性与安全复位的正确性依赖"每个玩法运行期保持 bridge 连接"（当前游戏与插件均成立）。bridge 需新增：init 时顶掉旧 session 的逻辑、退出信号触发的复位、ws close 后的 60 秒宽限期与超时复位。**复位不再由 ws close 立即触发**（那会导致短时重连误停正在进行的电击）——正常退出走显式信号，ws 断开只作 60 秒兜底。若将来出现不经 bridge 的玩法，此真相来源失效，需重审。关联 [[0001-local-machine-is-trusted-no-bridge-auth]]。
