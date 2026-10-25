---
date: 2026-07-02
summary: 以 bridge 的 ws 连接为唯一真相，唯一性与复位收敛到 session 生命周期
---

# 运行状态权威：bridge 连接即真相

不额外维护运行状态，以 bridge 的 WebSocket 连接为唯一真相：

1. bridge 全局只有一个活跃 session。
2. 新玩法 init 若有旧 session：先按旧 deviceMap 逐能力 stop、断开，再建新的。
3. 复位双通道：正常退出走显式退出信号（插件由主进程监听 webview 销毁发出，游戏由前端离开时发出；不带 id），bridge 复位并清 session；ws 断开只作兜底，转待定起 60 秒计时，重连即恢复，超时才复位。

理由：init 都上交 deviceMap，bridge 握有复位信息；ws close 立即复位会误停进行中的电击。后果：依赖玩法运行期保持 bridge 连接。
