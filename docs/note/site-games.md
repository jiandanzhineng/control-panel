# 游戏网站页面与游戏条目

## 站点页面

- 游戏介绍页入口 `game-intro.html?id=`（`game-detail.html` 同页保留），跟站点深色主题、中英切换，本页可启动/缓存。
- 作者管理页 `author.html`；作者修改已发布投稿通过 `POST /api/submissions/:id/update` 回到待审核。
- 投稿登录页是正式登录页；首页一半推荐游戏、一半投稿说明；保留独立游戏列表页。
- 游戏网站接入百度统计（账号 ysy1997212，2026-09-04）：`game.undersilicon.cn` siteId `23498945`，hm `4ad0c770327c5e885bfd688a80ccac47`。`admin.html` 审核后台不接入。

## 游戏条目约定

- `drink-pee-unlock` 对外称「喝水/液体收集」，pee 模式是容器放秤上、秤变重。不要写憋尿/排尿/排泄，也不要写成站上秤、喝水变重。游戏版本 2.3.5。
- 俯卧撑游戏：`backend/games/pushup-detection` 与移动端 `assets/games/pushup-detection` 同步。
- 已发布包按 `游戏 ID + 版本 + 内容哈希` 使用不可变路径；下架或回滚只更新 registry。

## 手机试玩拍摄计划（腾讯文档）

- 《喝水玩法手机试玩拍摄计划》文件 ID `ULkZlEcSTKtC`，链接 https://docs.qq.com/doc/DVUxrWmxFY1NUS3RD ，含三章：喝水/液体收集解锁玩法（`drink-pee-unlock`）、背诵玩法（`reading-game` 的 recite 模式）、背单词玩法（`vocab-game`）。
- 写拍摄步骤时以对应游戏 manifest 的默认参数为准（朗读游戏 1.1.6：过关 85%、沉默 6 秒、遮字 10%/级、休息 20 秒、电击上限 30V；背单词 1.1.13：四选一、20 秒/题、答错电击并排队尾、今日完成解锁）。
