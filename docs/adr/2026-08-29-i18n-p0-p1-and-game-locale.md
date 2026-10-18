---
date: 2026-08-29
summary: 面板 i18n 先中英，游戏用同一 locale code 与同一包，运行中不热切
---

# 面板 i18n 分期与游戏语言

1. 第一期只做中英：先 P0 骨架和 P1 面板英文，日/韩/西后置。
2. 游戏 i18n 必须兼容移动端：同一套 locale code 和同一份游戏包；宿主注入 `DeviceAPI.locale`，游戏自带翻译。
3. 运行中的游戏不热切语言，重进再生效。
4. play-registry 官网 i18n 放到 P2。
5. 内置游戏先补 `manifest.i18n.en`；页内玩法 UI 可仍中文。
