# 游戏上传禁止重复 game_id

- 状态：Accepted
- 日期：2026-10-06

## 摘要

每个游戏上传时禁止与已有 game_id 重复；他人不能用已存在的 id 投稿或覆盖。

## 用户要求

game_id 归属按计划执行：首个发布者拥有该 id，官方 id 保留，本人可升版更新。

## 决定

- 归属取该 `game_id` 最早一条带 `submission_id` 的 release 的 `submissions.author_id`；`revoked` 的 release 仍参与归属判定，id 不能被他人复用。
- 该 `game_id` 存在 `submission_id` 为空的官方 release 且早于任何社区 release 时，id 保留，只有管理员身份的投稿可以发布到它。判定用投稿时记录的 `submissions.author_is_admin`，不看批准者身份。
- 硬校验放在 `publishSubmission` 的发布事务内（发布前先跑一次只为少写无用文件）；ZIP 投稿在 `completeZipSubmission` 上传完成时提前拦一次，Git 投稿只能发布时拦。
- 本人更新要求版本严格高于该 id 当前最新 release 的版本（semver，`+` 构建元数据不参与比较）。
- 审核后台列表回填 `gameId` / `gameIdStatus`（new / own / official / conflict），只解析 ZIP 投稿的源包。

## 后果

- 老库启动时自动补 `submissions.author_is_admin` 列，历史投稿默认为 0：旧投稿在官方 id 上会被拒，需要管理员重新投稿或手工订正数据。
- 审核后台列表多读一次私有桶对象解析 manifest，ZIP 投稿数量大时列表会变慢；Git 投稿没有标记。
