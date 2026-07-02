# 信任边界：本机即可信，bridge 不做连接认证

**背景**：插件的 detector 跑在 webview preload 的 Node 环境，用 Node `ws` 连本机 bridge 驱动电击设备。Node 客户端天然能绕过 bridge 现有的 origin 校验（`verifyClient` 对无 origin 的连接直接放行）。配置经 `active-plugin.json` 纯文件传递，无归属校验。

**决定**：不引入激活 token 或任何连接身份认证。信任边界定为"本机 = 可信"——不防范本机其他进程写 `active-plugin.json` 或连 bridge，只依赖 Electron 沙箱挡住第三方**页面脚本**拿到 Node 能力。

**为什么**：单机自用工具，运行环境里没有需要防范的其他本机进程。加 token 会改动 bridge 的 init 协议、`verifyClient`、握手流程，且要区分游戏（同源）与插件（带 token）两条路径，复杂度不划算。刻意选择简单。

**后果**：电击设备可被本机任意进程无认证触发。这是已知且接受的取舍，不是疏漏。若将来面板要多机/联网/多用户，此决定必须重审——届时 bridge 认证是第一优先级。
