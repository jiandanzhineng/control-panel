# 手机号身份

feat/phone-login 已本地开发验收，尚未部署。PC Express 转发中心 phone/code|login|bind，复用中心 JWT 与本地 relay-session；AccountView 新增验证码入口/双码换绑，重载按 /me 恢复。

Go identity 接受邮箱身份或 provider=phone 且 phoneVerified 的中心用户；匿名/未验证拒绝。identities.email 可空且唯一，phone_masked 只作展示，投稿/owner/payout 按中心 ID。

旧 identities 升级保留作者、审核人、手工归属和分成引用并检查外键；旧邮箱身份仍走既有 ID 迁移。不按脱敏号码匹配作者，昵称/联系邮箱不作权限。

静态站缓存中心 ID/phoneMasked，支持验证码登录和纯手机号投稿/作者管理；管理台指定作者可用邮箱或中心 ID。资源引用检查修复正则内引号跨行误判，回归仍拦截未声明外部来源。

本地中心3999、Go8787、静态站3299，数据库/对象均在 tmp/；PC 使用独立 tmp/electron-profile、CDP9334和本地中心。逐步截图报告：tmp/phone-login-test-report.md。真实短信、一键登录、线上发布均未执行。
