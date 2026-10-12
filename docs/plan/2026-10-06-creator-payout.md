# 社区游戏创作者分成计划

- 日期：2026-10-06
- 状态：实施中
- 涉及：`game-platform/`、`play-registry/`、`frontend/`（PC 埋点）、mobile 仓库埋点、商城后台（只用现有功能）

## 目标

按社区游戏上线后的游玩表现，每月给创作者发一次奖励金到商城账号。**发放全程手工**：

1. 管理员在 OpenPanel 看板自己统计上月的游玩表现；
2. 到商城后台手工发奖励金；
3. 回投稿平台把发放记录录进来，作者在「我的分成」看到。

OpenPanel 数据**不进前台**，也**不由系统拉取**。投稿平台只保存发放记录，不算钱。

运营步骤见 `docs/guides/creator-payout-guide.md`。

## 用户已定

- 每月手工发放一次，不做自动入账。
- 同一个 game_id 禁止被其他人重复上传。
- 历史投稿（`legacy:` 作者）先不处理。
- 奖金池、门槛等参数留到正式发钱时再定，**代码里不出现这些阈值配置**。

## 现成能力（不用新做）

- 作者 ↔ 账号：`releases.game_id → submission_id → submissions.author_id`（账号中心用户 ID）→ 商城用户。
- 官方游戏没有对应投稿（`submission_id` 为空），天然不参与分成。
- PC 埋点（`frontend/src/playAnalytics.ts`）：`game_start` / `game_stop` 带 `game_id`、`version`、`source`、
  `device_macs`、`device_count`、`duration_ms`、`end_reason`；字段从 1.0.36 beta 起才有。
- 商城后台可按账号增减奖励金并记备注（商城 ADR-0011）。

## 阶段 0：game_id 归属校验（已实现）

现状：批准发布时，同 game_id 的旧 release 直接被置为 `superseded`，不校验作者，社区投稿甚至能覆盖官方游戏。开始发钱后这等于能抢别人的收益。

规则（最终优先级）：`game_owners` 手工指定 > 最早的社区 release 作者 > 官方保留。

- game_id 归属于**第一个发布它的作者**；官方/导入游戏（`submission_id` 为空的 release）的 id 视为保留。
- 已下架（`revoked`）的 id 仍保留，不允许别人复用。
- 其他作者提交同一 game_id：拒绝，提示「该游戏 ID 已被占用，请改用其他 id」。
- 同一作者更新自己的游戏：允许，但 `version` 必须高于当前线上版本。
- **管理员投稿可以发布到任何已存在的 game_id**（官方 id、他人的社区游戏、指定归属的游戏），
  方便团队继续维护已上线的社区游戏（如线上 `surge-edging`）；**归属不变**，版本仍须严格升高。
- **归属指定**：管理员可以手工把 game_id 指定给某个作者（表 `game_owners`），用于导入时没有投稿记录、
  实际是社区作者的游戏；被指定后该游戏视为社区游戏，可录入分成，作者本人可升版更新。
- 历史 `legacy:` 作者按 author_id 字符串照常比对，不做额外认领处理。

实现：

1. `publisher.go` 发布事务内查 `releases` 现有归属，归属不符即中止（硬保证，Git 投稿只能在这里拦）。
2. ZIP 投稿在上传确认、读到 manifest 时提前校验，早点告诉作者，减少无效审核。
3. 审核后台列表显示「新游戏 / 更新（原作者）/ 管理员更新 / 官方 ID / ID 冲突」标记。
4. `platform_test.go`、`payout_owner_test.go` 覆盖：他人同 id 被拒、覆盖官方 id 被拒、本人升版通过、
   本人同版本被拒、revoked id 不可复用、管理员更新他人游戏且归属不变、指定归属后作者可升版并可录入分成。

## 阶段 1：埋点补齐

PC 端基本已具备，只需确认：

- 社区游戏启动时 `source` 能区分社区/官方/本地上传/外部 URL；本地上传和外部 URL 不计入分成。
- `game_stop` 在关窗、崩溃、切换游戏时都能补发（已有 `end_reason: replaced`，核对其他路径）。

mobile 端（`lib/core/analytics/analytics.dart`）需补：

- `game_exit` 增加 `version`、`source`、`device_macs`（或设备 remote_id）、`device_count`，与 PC `game_stop` 字段对齐。
- 统一字段名：`duration_ms`（mobile 现为 `session_duration_ms`，两个字段都看，新版本改齐）。

两端 OpenPanel client 不同（PC `1fc33a58…`，mobile `d06ee26e…`），是**两个项目**，统计时两边分别看。

验收：社区游戏各玩一局，OpenPanel 看板两端都能看到带完整字段的结束事件。

## 阶段 2：手工发放记录（game-platform，已实现）

不再有报表生成、奖金池、门槛、排除名单，也**不读 OpenPanel**：管理员自己在看板统计、自己在商城发钱，
系统只保存发放记录。

数据表 `payout_reports`（**旧结构未上线，迁移时直接 DROP 重建**，见 `database.go` 注释）：

| 列 | 说明 |
| --- | --- |
| `id` | 自增主键 |
| `month` | `YYYY-MM` |
| `game_id` | 游戏 ID |
| `author_id` / `author_name` | 按 game_id 归属自动带出 |
| `valid_plays` | 可空，管理员手抄的参考数据，不参与计算 |
| `amount_cny` | 金额（元），必须 > 0 |
| `note` | 备注 |
| `paid_at` / `paid_by` | 发放时间与操作人 |
| `created_at` | 录入时间 |

唯一键 `(month, game_id)`：同月同游戏只能一条。

接口（仅管理员）：

- `POST /api/admin/payouts`：录入一条，body `{month, gameId, amountCny, validPlays?, note?}`。
  game_id 没有归属作者（官方游戏）时拒绝；重复录入返回 409。
- `GET /api/admin/payouts?month=YYYY-MM`：列表（附作者邮箱、账号中心 ID）；不带 month 返回全部，按月份倒序。
- `POST /api/admin/payouts/{id}/delete`：删错用。
- `GET /api/admin/community-games`：所有社区游戏（game_id、标题、当前版本、作者名、作者邮箱、账号中心 ID、
  状态 active/revoked）。
- `POST /api/admin/game-owners` / `GET /api/admin/game-owners`：指定与查看 game_id 归属。
- `GET /api/payouts/mine`：作者只读自己的发放记录。

页面：`play-registry/admin.html`「月度分成」tab 改为社区游戏与作者列表 + 录入表单 + 记录列表（可删除）+ 归属指定表单。

## 阶段 3：每月手工发放流程（不开发商城）

每月初执行一次，完整清单见 `docs/guides/creator-payout-guide.md`：

1. 在 OpenPanel 看板统计上月各社区游戏的独立设备数（主）与游玩次数（次），排除官方玩法与明显刷量。
2. 对每个作者：在商城后台 `/admin/reward` 找到用户 →「增加奖励金」→ 备注 `创作者分成 YYYY-MM <game_id>`。
3. 回审核后台「月度分成」录入发放记录。
4. 作者还没登录过商城：不录记录，通知作者登录一次商城，下月一并补发。
5. 录错就在记录列表里删除重录。

商城后台的奖励金入口**目前只支持按账号 ID 查询**；按邮箱 / 账号中心 ID 查询在商城仓库分支
`feat/reward-lookup-by-account`，**尚未上线**。

## 阶段 4：网站与作者端（已实现）

- `docs/contribute.html` 与投稿页：分成说明改为「每月由平台人工统计游玩表现并人工发放奖励金到商城账号
  （需先用同一账号登录过商城），发放后可在投稿工作台『我的分成』查看」，不写具体金额与门槛。
- 作者工作台「我的分成」：只读展示自己各月的发放记录（月份、游戏、有效游玩、金额、备注、发放时间）；
  没有记录时显示友好提示。
- 游戏卡片和详情页显示作者署名（registry 已有 `authorName`）。

## 顺序与依赖

| 顺序 | 内容 | 依赖 |
| --- | --- | --- |
| 1 | 阶段 0 game_id 归属校验 + 归属指定 | 无，可立即做 |
| 2 | 阶段 1 mobile 埋点 + PC 核对 | 随下个 App 版本发布 |
| 3 | 阶段 2 发放记录 + 阶段 4 网站与作者端 | 阶段 1 上线并积累满一个自然月 |
| 4 | 阶段 3 首次手工发放 | 阶段 2、4 完成 |

## 待定

- 首次正式发钱时的金额口径（纯人工决定，不进代码）。
- 是否改发佣金（USD）而非奖励金；若改，商城需补佣金的后台手工入口。
