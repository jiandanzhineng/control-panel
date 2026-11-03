# 登录布局与微信扫码

- PC默认手机验证码；邮箱、微信通过切换显示。邮箱注册入口置于邮箱区域，原表单草稿保留。游戏站以相同方式整理，保留 `#login/#register/#recover/#phone` 入口。
- PC `WechatQrLogin` 仅在选中时挂载；串行轮询，刷新与离开后忽略旧响应，过期/网络错误提供重试。
- 本地 `/api/auth/wechat/qr/start|status` 转发商城专用desktop二维码接口。商城只把已绑定中心账号的扫码确认兑换成中心会话；PC复用现有会话持久化与本地relay流程。
- 商城服务默认 `https://shop.undersilicon.cn`，隔离测试可通过 `SHOP_API_URL` 指向本地；此变量是服务地址，不含凭据。
- PC正式版`1.0.39`已从main提交`b943cce0`打tag发布，Actions `41591247374`成功；五项OSS制品、清单SHA512、固定安装ZIP与源码三个版本均核验一致。游戏站同提交已部署（`41591230755`、`41591576338`成功）。
- 下载正式安装包后解包、独立profile实际运行：登录切换与草稿保留、生产280px微信码、更新器`currentVersion=latestVersion=1.0.39`通过；未覆盖用户安装或验证原地升级。
- 账号中心与商城已部署；小程序0.2.2在线、0.2.3目标提示和布局送审中。真实手机扫码授权需用户统一验收。
- 实际Electron及游戏站步骤截图：`tmp/login-layout-test-report.md`。联调用独立profile，勿清正式客户端数据。
- 游戏站受保护工作台已用现有生产会话验证`/api/auth/me`与`/api/submissions`；未发送测试投稿。若本机neo报`ERR_CONNECTION_CLOSED`，可对照7990代理与直连TLS：本轮是代理到game-api域名握手失败；仅临时单域直连验证，随后还原ProxyOverride，未关闭系统代理。
