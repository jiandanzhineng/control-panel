# 手机号身份

手机号功能已正式发布：PC 1.0.38（277c69f / v1.0.38），Go与游戏静态站生产版本为20261103-phone-login-2。PC Express 转发中心 phone/code|login|bind，复用中心 JWT 与本地 relay-session；AccountView 新增验证码入口/双码换绑，重载按 /me 恢复。

Go identity 接受邮箱身份或 provider=phone 且 phoneVerified 的中心用户；匿名/未验证拒绝。identities.email 可空且唯一，phone_masked 只作展示，投稿/owner/payout 按中心 ID。

旧 identities 升级保留作者、审核人、手工归属和分成引用并检查外键；旧邮箱身份仍走既有 ID 迁移。不按脱敏号码匹配作者，昵称/联系邮箱不作权限。

静态站缓存中心 ID/phoneMasked，支持验证码登录和纯手机号投稿/作者管理；管理台指定作者可用邮箱或中心 ID。资源引用检查修复正则内引号跨行误判，回归仍拦截未声明外部来源。

## 生产与验证

- 游戏API current：/opt/game-platform/releases/20261103-phone-login-2，上一正常版本20261022-security保留。生产库 /var/lib/game-platform/game-platform.db；迁移前备份 game-platform.db.bak.20261103-pre-phone-login。integrity/外键检查通过，submissions前后dump哈希一致。健康端点为 /healthz。
- 游戏站和PC均使用真实短信登录到原中心账号；游戏站成功进入投稿工作台和作者管理，该用户没有自己的投稿，未向生产提交假稿。
- PC Build/Release 41554891118成功；正式OSS的latest.yml、installer、blockmap、固定ZIP、源码ZIP全部核验，版本/SHA512及ZIP内安装包一致。installer SHA256为1606fc165118b3bb4127bce29a1697a5d0c715bca3b5b80d1c2ff5a760cc15ab。
- 实际发布安装包提取后的Electron已运行，独立profile恢复原手机号会话，正式更新源检查currentVersion/latestVersion均1.0.38、available=false。未执行旧版本安装包的原地升级，不把提取运行视为安装升级测试。
- 本期为短信验证码认证，运营商本机一键登录尚未实现。

## 本地复现与证据

中心3999、Go8787、静态站3299，数据库/对象均在 tmp/；PC 使用独立 tmp/electron-profile、CDP9334和本地中心。逐步截图报告：tmp/phone-login-test-report.md。生产制品证据：tmp/pc-release-1.0.38/verified.json、tmp/pc-release-verification.log；生产跨端截图总报告在 backend worktree 的 tmp/phone-login-production-report-20261103.md。
