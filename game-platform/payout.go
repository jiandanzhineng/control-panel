package main

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"
	"time"
)

// PayoutReport 是 payout_reports 的一行，即某月某游戏的快照。
type PayoutReport struct {
	Month         string  `json:"month"`
	GameID        string  `json:"gameId"`
	AuthorID      string  `json:"authorId"`
	AuthorName    string  `json:"authorName"`
	AuthorEmail   string  `json:"authorEmail"`
	ValidPlays    int     `json:"validPlays"`
	UniqueDevices int     `json:"uniqueDevices"`
	TotalMinutes  float64 `json:"totalMinutes"`
	AmountCNY     int64   `json:"amountCny"`
	Status        string  `json:"status"`
	PaidAt        int64   `json:"paidAt"`
	PaidBy        string  `json:"paidBy"`
	Note          string  `json:"note"`
	GeneratedAt   int64   `json:"generatedAt"`
}

// PayoutThresholds 是生成报表时可逐项覆盖的入围参数。
type PayoutThresholds struct {
	MinDurationMS  int64 `json:"minDurationMs"`
	MinDeviceCount int   `json:"minDeviceCount"`
	MinValidPlays  int   `json:"minValidPlays"`
}

// payoutAggregate 是过滤去重后的单游戏统计。
type payoutAggregate struct {
	ValidPlays    int
	UniqueDevices int
	TotalMS       int64
	devices       map[string]bool
}

// addDevices 累计独立设备数。
func (a *payoutAggregate) addDevices(macs []string) {
	if a.devices == nil {
		a.devices = map[string]bool{}
	}
	for _, mac := range macs {
		a.devices[mac] = true
	}
	a.UniqueDevices = len(a.devices)
}

var errInvalidPayoutMonth = errors.New("month must use the YYYY-MM format")

// payoutMonthRange 返回该自然月按配置时区计算的 [start, end)。
func payoutMonthRange(month string, location *time.Location) (time.Time, time.Time, error) {
	parsed, err := time.ParseInLocation("2006-01", month, location)
	if err != nil || len(month) != 7 {
		return time.Time{}, time.Time{}, errInvalidPayoutMonth
	}
	return parsed, parsed.AddDate(0, 1, 0), nil
}

// aggregatePayoutEvents 过滤并去重游玩事件。
// 去重键是「设备 MAC + game_id + 自然日」：同一天里只要该设备已经算过，
// 后续任何包含这台设备的游玩都不再计入。
func aggregatePayoutEvents(events []payoutEvent, location *time.Location, thresholds PayoutThresholds, excludedMACs, excludedProfiles map[string]bool) map[string]*payoutAggregate {
	ordered := make([]payoutEvent, len(events))
	copy(ordered, events)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].OccurredAt.Before(ordered[j].OccurredAt) })

	seen := map[string]bool{}
	out := map[string]*payoutAggregate{}
	for _, event := range ordered {
		if event.GameID == "" || event.DurationMS < thresholds.MinDurationMS {
			continue
		}
		if event.OccurredAt.IsZero() {
			continue
		}
		if excludedProfiles[strings.ToLower(event.ProfileID)] {
			continue
		}
		macs := []string{}
		for _, mac := range event.DeviceMACs {
			if mac != "" && !excludedMACs[mac] {
				macs = append(macs, mac)
			}
		}
		if len(macs) < thresholds.MinDeviceCount || len(macs) == 0 {
			continue
		}
		dayKey := event.GameID + "|" + event.OccurredAt.In(location).Format("2006-01-02")
		duplicate := false
		for _, mac := range macs {
			if seen[dayKey+"|"+mac] {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		for _, mac := range macs {
			seen[dayKey+"|"+mac] = true
		}
		entry := out[event.GameID]
		if entry == nil {
			entry = &payoutAggregate{}
			out[event.GameID] = entry
		}
		entry.ValidPlays++
		entry.TotalMS += event.DurationMS
		entry.addDevices(macs)
	}
	return out
}

// splitPool 按「奖金池 × 本游戏有效游玩 / 入围游戏有效游玩总和」分配，按元向下取整。
// 有效游玩不足 minValidPlays 的游戏不参与分配，金额为 0，也不计入分母。
func splitPool(pool int64, aggregates map[string]*payoutAggregate, minValidPlays int) map[string]int64 {
	out := map[string]int64{}
	total := 0
	for _, entry := range aggregates {
		if entry.ValidPlays >= minValidPlays {
			total += entry.ValidPlays
		}
	}
	for gameID, entry := range aggregates {
		if pool <= 0 || total <= 0 || entry.ValidPlays < minValidPlays {
			out[gameID] = 0
			continue
		}
		out[gameID] = pool * int64(entry.ValidPlays) / int64(total)
	}
	return out
}

// generatePayoutReports 拉取 OpenPanel 数据、过滤去重、关联作者、按公式分配并写快照。
// draft 行会被重新生成覆盖，paid / skipped 行保持原样。
func (a *App) generatePayoutReports(ctx context.Context, month string, pool int64, thresholds PayoutThresholds) ([]PayoutReport, error) {
	location, err := time.LoadLocation(a.config.Payout.Timezone)
	if err != nil {
		return nil, err
	}
	start, end, err := payoutMonthRange(month, location)
	if err != nil {
		return nil, err
	}
	events, err := a.openpanel.events(ctx, start, end)
	if err != nil {
		return nil, err
	}
	aggregates := aggregatePayoutEvents(events, location, thresholds,
		toSet(a.config.Payout.ExcludedMACs), toSet(a.config.Payout.ExcludedProfiles))
	authors, err := a.authorOfGame(ctx)
	if err != nil {
		return nil, err
	}
	// 只有存在社区 release 的 game_id 才参与分成，官方游戏不能稀释奖金池。
	eligible := map[string]*payoutAggregate{}
	for gameID, entry := range aggregates {
		if _, ok := authors[gameID]; ok {
			eligible[gameID] = entry
		}
	}
	amounts := splitPool(pool, eligible, thresholds.MinValidPlays)

	transaction, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `DELETE FROM payout_reports WHERE month = ? AND status = 'draft'`, month); err != nil {
		return nil, err
	}
	generatedAt := nowUnix()
	gameIDs := make([]string, 0, len(aggregates))
	for gameID := range aggregates {
		gameIDs = append(gameIDs, gameID)
	}
	sort.Strings(gameIDs)
	for _, gameID := range gameIDs {
		author, ok := authors[gameID]
		if !ok {
			continue
		}
		entry := aggregates[gameID]
		if _, err := transaction.ExecContext(ctx, `INSERT INTO payout_reports
			(month, game_id, author_id, author_name, valid_plays, unique_devices, total_minutes, amount_cny, status, paid_at, paid_by, note, generated_at)
			VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, '', '', ?)
			ON CONFLICT(month, game_id) DO NOTHING`,
			month, gameID, author.AuthorID, author.AuthorName, entry.ValidPlays, entry.UniqueDevices,
			float64(entry.TotalMS)/60000.0, amounts[gameID], generatedAt); err != nil {
			return nil, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return nil, err
	}
	reports, err := a.listPayoutReports(ctx, month, "")
	if err != nil {
		return nil, err
	}
	return a.attachAuthorEmails(ctx, reports)
}

func toSet(values []string) map[string]bool {
	out := map[string]bool{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value != "" {
			out[value] = true
		}
	}
	return out
}

// authorOfGame 把 game_id 关联到作者：releases → submissions → identities。
// 与 game_id 归属规则一致：按发布顺序第一条 release 决定归属；第一条是官方 release
// （submission_id 为空）的 id 不参与分成。含已下架 release，月中下架的游戏当月仍可结算。
func (a *App) authorOfGame(ctx context.Context) (map[string]PayoutReport, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT r.game_id, COALESCE(r.submission_id, ''), COALESCE(s.author_id, ''), COALESCE(s.author_name, ''), COALESCE(i.email, '')
		FROM releases r
		LEFT JOIN submissions s ON s.id = r.submission_id
		LEFT JOIN identities i ON i.id = s.author_id
		ORDER BY r.created_at ASC, r.rowid ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]PayoutReport{}
	decided := map[string]bool{}
	for rows.Next() {
		var gameID, submissionID string
		var author PayoutReport
		if err := rows.Scan(&gameID, &submissionID, &author.AuthorID, &author.AuthorName, &author.AuthorEmail); err != nil {
			return nil, err
		}
		if decided[gameID] {
			continue
		}
		decided[gameID] = true
		if submissionID == "" {
			continue
		}
		author.GameID = gameID
		out[gameID] = author
	}
	return out, rows.Err()
}

var errPayoutRowLocked = errors.New("paid or skipped rows are not regenerated")

func scanPayoutReport(scanner interface{ Scan(...any) error }) (PayoutReport, error) {
	var report PayoutReport
	err := scanner.Scan(
		&report.Month, &report.GameID, &report.AuthorID, &report.AuthorName,
		&report.ValidPlays, &report.UniqueDevices, &report.TotalMinutes, &report.AmountCNY,
		&report.Status, &report.PaidAt, &report.PaidBy, &report.Note, &report.GeneratedAt,
	)
	return report, err
}

const payoutSelect = `SELECT p.month, p.game_id, p.author_id, p.author_name, p.valid_plays, p.unique_devices,
	p.total_minutes, p.amount_cny, p.status, p.paid_at, p.paid_by, p.note, p.generated_at
	FROM payout_reports p`

// listPayoutReports 按月份列出报表；authorID 非空时只返回该作者的游戏。
func (a *App) listPayoutReports(ctx context.Context, month, authorID string) ([]PayoutReport, error) {
	query := payoutSelect
	args := []any{}
	conditions := []string{}
	if month != "" {
		conditions = append(conditions, "p.month = ?")
		args = append(args, month)
	}
	if authorID != "" {
		conditions = append(conditions, "p.author_id = ?")
		args = append(args, authorID)
	}
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}
	query += " ORDER BY p.month DESC, p.amount_cny DESC, p.game_id ASC"
	rows, err := a.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PayoutReport{}
	for rows.Next() {
		report, err := scanPayoutReport(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, report)
	}
	return out, rows.Err()
}

// attachAuthorEmails 补上作者邮箱，供管理员去商城定位账号。
func (a *App) attachAuthorEmails(ctx context.Context, reports []PayoutReport) ([]PayoutReport, error) {
	if len(reports) == 0 {
		return reports, nil
	}
	rows, err := a.db.QueryContext(ctx, `SELECT id, email FROM identities`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	emails := map[string]string{}
	for rows.Next() {
		var id, email string
		if err := rows.Scan(&id, &email); err != nil {
			return nil, err
		}
		emails[id] = email
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range reports {
		reports[index].AuthorEmail = emails[reports[index].AuthorID]
	}
	return reports, nil
}

func (a *App) payoutReportRow(ctx context.Context, month, gameID string) (PayoutReport, error) {
	return scanPayoutReport(a.db.QueryRowContext(ctx, payoutSelect+` WHERE p.month = ? AND p.game_id = ?`, month, gameID))
}

func (a *App) deletePayoutDraft(ctx context.Context, month, gameID string) error {
	_, err := a.db.ExecContext(ctx, `DELETE FROM payout_reports WHERE month = ? AND game_id = ? AND status = 'draft'`, month, gameID)
	return err
}

var errPayoutRowMissing = errors.New("payout row not found")

// markPayoutReport 把一行标成 paid / skipped，并记录操作人与时间。
func (a *App) markPayoutReport(ctx context.Context, month, gameID, status, note, operator string) (PayoutReport, error) {
	if status != "paid" && status != "skipped" {
		return PayoutReport{}, errors.New("status must be paid or skipped")
	}
	note = strings.TrimSpace(note)
	if len(note) > 500 {
		return PayoutReport{}, errors.New("note is too long")
	}
	paidAt := int64(0)
	if status == "paid" {
		paidAt = nowUnix()
	}
	result, err := a.db.ExecContext(ctx, `UPDATE payout_reports SET status = ?, note = ?, paid_at = ?, paid_by = ?
		WHERE month = ? AND game_id = ?`, status, note, paidAt, operator, month, gameID)
	if err != nil {
		return PayoutReport{}, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return PayoutReport{}, err
	}
	if changed == 0 {
		return PayoutReport{}, errPayoutRowMissing
	}
	report, err := a.payoutReportRow(ctx, month, gameID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return PayoutReport{}, errPayoutRowMissing
		}
		return PayoutReport{}, err
	}
	return report, nil
}
