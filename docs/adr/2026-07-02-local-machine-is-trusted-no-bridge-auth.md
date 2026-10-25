---
date: 2026-07-02
summary: 本机即可信，bridge 不做连接认证，不引入激活 token
---

# 信任边界：本机即可信，bridge 不做连接认证

插件的 detector 在 webview preload 的 Node 环境用 ws 连本机 bridge 驱动设备，Node 客户端可绕过 origin 校验；配置经 `active-plugin.json` 纯文件传递。

决定：不引入激活 token 或连接身份认证。信任边界为「本机 = 可信」，只依赖 Electron 沙箱挡住第三方页面脚本拿到 Node 能力。

理由：单机自用工具，环境里没有要防范的其他本机进程；加 token 要改 init 协议、`verifyClient` 和握手，并区分游戏/插件两条路径，复杂度不划算。

后果：本机任意进程可无认证触发设备，这是已知取舍。若将来多机/联网/多用户，此决定必须重审，bridge 认证是第一优先级。
