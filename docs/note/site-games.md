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
