# 登录布局与微信扫码

- PC默认手机验证码；邮箱、微信通过切换显示。邮箱注册入口置于邮箱区域，原表单草稿保留。游戏站以相同方式整理，保留 `#login/#register/#recover/#phone` 入口。
- PC `WechatQrLogin` 仅在选中时挂载；串行轮询，刷新与离开后忽略旧响应，过期/网络错误提供重试。
- 本地 `/api/auth/wechat/qr/start|status` 转发商城专用desktop二维码接口。商城只把已绑定中心账号的扫码确认兑换成中心会话；PC复用现有会话持久化与本地relay流程。
- 商城服务默认 `https://shop.undersilicon.cn`，隔离测试可通过 `SHOP_API_URL` 指向本地；此变量是服务地址，不含凭据。
- 本轮代码未发行，新扫码依赖账号中心、商城和带明确目标提示的小程序配套升级。真实手机扫码授权需用户统一验收。
- 实际Electron及游戏站步骤截图：`tmp/login-layout-test-report.md`。联调用独立profile，勿清正式客户端数据。
