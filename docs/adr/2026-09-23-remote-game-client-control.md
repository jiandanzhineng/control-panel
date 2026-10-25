---
date: 2026-09-23
summary: 游戏在设备所在端执行，PC 与手机互为执行端/控制端
supersedes: ADR-2026-09-23-remote-game-host-authority.md, ADR-2026-09-23-remote-game-config-parity.md, mobile-pc-bidirectional-client-control.md
---

# 远程游戏：设备所在端执行，两端互为执行端与控制端

游戏逻辑只在设备所在端 A 的 JS 运行层执行；B 加入同一游戏，使用一致 UI，查看同步状态、修改全部参数并执行开始/暂停/继续/停止。B 不重复执行逻辑，断线不影响 A。

A 可授权客户端级远控，授权后 B 能浏览、选择并启动新游戏，同时远控设备管理；游戏开始设置属于远控范围，其他设置不纳入。

远程「启动游戏」启动被控端选中的游戏，启动前设备映射与参数配置和本机玩法一致。首版按一个 B 简化。实现方案见 plans/remote-game-host-implementation-plan.md。
