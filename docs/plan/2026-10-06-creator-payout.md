# 社区游戏创作者分成计划

- 日期：2026-10-06
- 状态：待实施
- 涉及：`game-platform/`、`play-registry/`、`frontend/`（PC 埋点）、mobile 仓库埋点、Shop 后台（只用现有功能）

## 目标

按社区游戏上线后的游玩表现，每月给创作者发一次奖励金到 Shop 账号。数据来自 OpenPanel，**发放全程手工**，系统只负责出报表和记账，不自动入账。

## 用户已定

- 每月手工发放一次，不做自动入账。
- 同一个 game_id 禁止被其他人重复上传。
- 历史投稿（`legacy:` 作者）先不处理。

## 现成能力（不用新做）

- 作者 ↔ 账号：`releases.game_id → submission_id → submissions.author_id`（账号中心用户 ID）→ Shop `User.accountId`。投稿平台和 Shop 都已接账号中心。
- 官方游戏没有对应投稿（`submission_id` 为空），天然不参与分成。
- PC 埋点（develop `frontend/src/playAnalytics.ts`）：`game_start` / `game_stop` 已带 `game_id`、`version`、`source`、`device_macs`、`device_count`、`duration_ms`、`end_reason`。
- Shop 后台可按账号增减奖励金并记备注（Shop ADR-0011）。

## 参数（全部可配置，正式发钱时再定）

奖金池金额、有效游玩门槛等数值留到首次正式发钱时再定（用户 2026-10-06 决定）。代码里全部做成配置项，下表仅为占位默认值。

| 项 | 默认 |
| --- | --- |
| 发放形式 | Shop 奖励金（CNY），走现有「后台增减奖励金」 |
| 计算方式 | 固定月度奖金池，按各游戏有效游玩次数占比分配 |
| 有效游玩 | 社区游戏；至少映射 1 台真实设备；单次时长 ≥ 5 分钟 |
| 去重 | 同一设备（MAC）+ 同一游戏 + 同一天只算 1 次 |
| 入围门槛 | 当月有效游玩 ≥ 20 次才参与分配，否则当月为 0 |
| 排除 | 内部/测试设备与账号名单（服务端配置） |
| 起算 | 埋点上线后的下一个自然月，不追算历史 |

分配公式：`游戏金额 = 奖金池 × 该游戏有效游玩 / 所有入围游戏有效游玩之和`，按元取整，零头不发。

## 阶段 0：game_id 归属校验（先做，独立上线）

现状：批准发布时，同 game_id 的旧 release 直接被置为 `superseded`，不校验作者，社区投稿甚至能覆盖官方游戏。开始发钱后这等于能抢别人的收益。

规则：

- game_id 归属于**第一个发布它的作者**；官方/导入游戏（`submission_id` 为空的 release）的 id 视为保留。
- 已下架（`revoked`）的 id 仍保留，不允许别人复用。
- 其他作者提交同一 game_id：拒绝，提示「该游戏 ID 已被占用，请改用其他 id」。
- 同一作者更新自己的游戏：允许，但 `version` 必须高于当前线上版本。
- 历史 `legacy:` 作者按 author_id 字符串照常比对，不做额外认领处理。

实现：

1. `publisher.go` 发布事务内查 `releases` 现有归属，归属不符即中止（硬保证，Git 投稿只能在这里拦）。
2. ZIP 投稿在上传确认、读到 manifest 时提前校验，早点告诉作者，减少无效审核。
3. 审核后台列表显示「新游戏 / 更新（原作者）/ ID 冲突」标记。
4. `platform_test.go` 补用例：他人同 id 被拒、覆盖官方 id 被拒、本人升版通过、本人同版本被拒、revoked id 不可复用。

## 阶段 1：埋点补齐

PC 端基本已具备，只需确认：

- 社区游戏启动时 `source` 能区分社区/官方/本地上传/外部 URL；本地上传和外部 URL 不计入分成。
- `game_stop` 在关窗、崩溃、切换游戏时都能补发（已有 `end_reason: replaced`，核对其他路径）。

mobile 端（`lib/core/analytics/analytics.dart`）需补：

- `game_exit` 增加 `version`、`source`、`device_macs`（或设备 remote_id）、`device_count`，与 PC `game_stop` 字段对齐。
- 统一字段名：`duration_ms`（mobile 现为 `session_duration_ms`，报表两者都读，新版本改齐）。

两端 OpenPanel client 不同（PC `1fc33a58…`，mobile `d06ee26e…`），先确认是否同一 project；报表需同时拉两边。

验收：社区游戏各玩一局，OpenPanel 后台两端都能看到带完整字段的结束事件。

## 阶段 2：月度报表（game-platform）

配置：

- 在 OpenPanel 看板生成 **read 权限** client（每个 project 一个），Secret 只放 game-platform 服务器 `.env`，绝不进仓库和前端（同 `analytics-design.md` 约定）。
- `.env` 增加：OpenPanel API 地址、read client id/secret、排除名单（设备 MAC、账号 ID）、有效游玩阈值。

数据：

- 新表 `payout_reports`：`month`、`game_id`、`author_id`、`author_name`、`valid_plays`、`unique_devices`、`total_minutes`、`amount_cny`、`status`（`draft` / `paid` / `skipped`）、`paid_at`、`paid_by`、`note`。唯一键 `(month, game_id)`。
- 报表一旦生成即为快照；`draft` 状态可重新生成，已 `paid` 的行不再覆盖。

接口（仅管理员）：

- `POST /api/admin/payouts/{month}/generate`：参数奖金池金额。拉 OpenPanel 导出数据 → 按「有效游玩」规则过滤去重 → 只保留有社区 release 的 game_id → 关联作者 → 按公式算金额 → 写快照。
- `GET /api/admin/payouts/{month}`：返回报表行，附作者邮箱、账号中心 ID，供去 Shop 定位账号。
- `GET /api/admin/payouts/{month}.csv`：导出。
- `POST /api/admin/payouts/{month}/{game_id}/mark`：手工标记 `paid` / `skipped` 并写备注。

页面：`play-registry/admin.html` 增加「月度分成」tab：选月份、填奖金池、生成、查看、导出、逐行标记已发。

验收：用测试数据（或上个月真实数据）生成一次，核对 2–3 个游戏的次数与 OpenPanel 看板一致。

## 阶段 3：每月手工发放流程（不开发 Shop）

每月初执行一次：

1. 管理员在审核后台生成上月报表，检查异常（单设备刷量、时长异常、内部设备漏排）。
2. 对每一行：在 Shop 后台按作者账号找到用户 →「增加奖励金」→ 备注 `创作者分成 2026-11 <game_id>`。
3. 回到审核后台把该行标记为 `paid`。
4. 作者还没登录过 Shop（Shop 里没有对应用户）：该行保持 `draft` 并备注，通知作者登录一次商城，下月一并补发。

前置核对：Shop 后台的奖励金入口目前按什么查账号。如果不支持按邮箱或 `accountId` 查，补一个查询条件（小改动，单独评估）。

## 阶段 4：网站与作者端

- `docs/contribute.html` 与投稿页：把「联系客服领套餐」改为公开规则——有效游玩定义、奖金池分配方式、每月结算时间、发到商城奖励金、需先登录商城。
- 作者工作台增加「我的分成」：只读展示自己游戏各月的有效游玩和金额（来自 `payout_reports`，管理员生成后才可见）。新接口 `GET /api/payouts/mine`。
- 游戏卡片和详情页显示作者署名（registry 已有 `authorName`，核对各页面都在显示）。

## 顺序与依赖

| 顺序 | 内容 | 依赖 |
| --- | --- | --- |
| 1 | 阶段 0 game_id 归属校验 | 无，可立即做 |
| 2 | 阶段 1 mobile 埋点 + PC 核对 | 随下个 App 版本发布 |
| 3 | 阶段 2 报表 | 阶段 1 上线并积累满一个自然月 |
| 4 | 阶段 4 网站规则 + 作者端 | 规则参数定稿 |
| 5 | 阶段 3 首次手工发放 | 阶段 2、4 完成 |

## 待定参数

- 每月奖金池金额。
- 有效游玩的最短时长、入围门槛（默认 5 分钟、20 次）。
- 是否改发佣金（USD）而非奖励金；若改，Shop 需补佣金的后台手工入口。
