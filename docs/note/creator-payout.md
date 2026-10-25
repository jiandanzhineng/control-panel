# 创作者月度分成（手工录入）

## 后端（game-platform）

- 表 `payout_reports`：`id` 自增主键、`month`、`game_id`、`author_id`、`author_name`、`valid_plays`（可空，管理员手抄参考）、`amount_cny`、`note`、`paid_at`、`paid_by`、`created_at`，唯一键 `(month, game_id)`。旧结构（`status`/`generated_at`）从未上线，迁移时检测到直接 DROP 重建（`database.go` 的 `dropLegacyPayoutReports`）。
- 接口：`POST /api/admin/payouts`（month、gameId、amountCny>0、validPlays?、note?；作者按 game_id 归属自动带出；非社区游戏中文报错；同月同游戏 409）、`GET /api/admin/payouts?month=YYYY-MM`（不带 month 返回全部按月份倒序，附作者邮箱与账号中心 ID）、`POST /api/admin/payouts/{id}/delete`、`GET /api/admin/community-games`、`GET|POST /api/admin/game-owners`、作者端 `GET /api/payouts/mine`。
- 已删除自动统计：不再拉 OpenPanel，`generate` 接口、奖金池/门槛/排除名单/OpenPanel 配置、`tools/fake-openpanel.js` 及相关测试（`payout_openpanel.go`、`payout_test.go`）一并删除。

## game_id 归属规则（`ownership.go`）

1. 管理员投稿（`author_is_admin=1`）可发布到任何已存在的 game_id，归属不变，版本仍须严格升高。
2. `game_owners(game_id 主键, author_id, author_name, set_by, set_at)` 手工指定归属，邮箱须已存在于 `identities`（否则报「该邮箱尚未登录过投稿平台」）。
3. 最终优先级：`game_owners` 指定 > 最早的社区 release 作者 > 官方保留。被指定后视为社区游戏（可录入分成、作者本人可升版）。审核后台 `gameIdStatus` 新增 `admin`。

## 前端与运营

- `admin.html`「月度分成」tab：社区游戏与作者列表 + 录入表单 + 记录列表（可删）+ 归属指定表单。
- `submission.js`「我的分成」显示发放记录（月份/游戏/有效游玩/金额/发放时间/备注）。
- 运营 guide：`docs/guides/creator-payout-guide.md`（埋点字段与版本、OpenPanel 按月统计、同设备同日去重近似、刷量识别、商城 `/admin/reward` 发钱与备注格式、回投稿平台录入、归属指定、每月检查清单）。
- 测试：`gofmt -l .` 干净、`go vet ./...`、`go test ./... -count=1` 通过；play-registry `npm test` 29 通过、`npm run build` 通过。

## 上线记录（2026-10-06）

- game-platform release `20261006-155439`（回滚点 `20260917-164315`，发版前备份 `game-platform.db.bak.20261006-155439-pre-creator-payout`）；静态站随 develop `45d93f1` 发布；商城 release `20261006160241`（master `fdaf3e6`，回滚点 `20261004164026`）；mobile PR #73 合入 master `3d405dc0` 自动发内测。
- `surge-edging` 已写 `game_owners` 归属 DK。
- 部署坑：生产 game-platform 二进制没有 `--help`，别在服务器裸跑（会在 cwd 建 `data/`）；商城服务器 1.8G 无 swap，`npm ci` 会 OOM，依赖不变就复制上个 release 的 `node_modules`；pm2 记录绝对路径，换版要 `delete` + `start`。
- 运营 guide `docs/guides/creator-payout-guide.md`；验收报告 `docs/test/2026-10-06-creator-payout/report.md`。
- 2 个待审投稿（三阶段寸止自动校准）若用官方 id 会被新 game_id 规则拦下，需改 id 或管理员代发。
