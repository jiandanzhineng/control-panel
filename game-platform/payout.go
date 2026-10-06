package main

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// PayoutRecord 是 payout_reports 的一行，即「管理员手工录入的一条发放记录」。
// 数据来源是管理员在 OpenPanel 看板手工统计 + 商城后台手工发奖励金的结果，
// 投稿平台不拉 OpenPanel，也不参与算钱。
type PayoutRecord struct {
	ID          int64  `json:"id"`
	Month       string `json:"month"`
	GameID      string `json:"gameId"`
	AuthorID    string `json:"authorId"`
	AuthorName  string `json:"authorName"`
	AuthorEmail string `json:"authorEmail"`
	// ValidPlays 是管理员手填的参考数据，可以不填。
	ValidPlays *int   `json:"validPlays"`
	AmountCNY  int64  `json:"amountCny"`
	Note       string `json:"note"`
	PaidAt     int64  `json:"paidAt"`
	PaidBy     string `json:"paidBy"`
	CreatedAt  int64  `json:"createdAt"`
}

var (
	errInvalidPayoutMonth = errors.New("month must use the YYYY-MM format")
	errPayoutGameMissing  = errors.New("game_id has no community author")
	errPayoutDuplicate    = errors.New("this game already has a payout record for the month")
	errPayoutAmount       = errors.New("amount must be greater than zero")
	errPayoutNoteTooLong  = errors.New("note is too long")
	errPayoutRecordGone   = errors.New("payout record not found")
)

// payoutMonthPattern 校验 YYYY-MM；只做格式与月份范围检查，不涉及时区。
func validPayoutMonth(month string) bool {
	if len(month) != 7 || month[4] != '-' {
		return false
	}
	_, err := time.Parse("2006-01", month)
	return err == nil
}

const payoutSelect = `SELECT p.id, p.month, p.game_id, p.author_id, p.author_name, p.valid_plays,
	p.amount_cny, p.note, p.paid_at, p.paid_by, p.created_at
	FROM payout_reports p`

func scanPayoutRecord(scanner interface{ Scan(...any) error }) (PayoutRecord, error) {
	var record PayoutRecord
	var validPlays sql.NullInt64
	err := scanner.Scan(
		&record.ID, &record.Month, &record.GameID, &record.AuthorID, &record.AuthorName,
		&validPlays, &record.AmountCNY, &record.Note, &record.PaidAt, &record.PaidBy, &record.CreatedAt,
	)
	if err != nil {
		return PayoutRecord{}, err
	}
	if validPlays.Valid {
		value := int(validPlays.Int64)
		record.ValidPlays = &value
	}
	return record, nil
}

// listPayoutRecords 列出发放记录；month 为空时返回全部，按月份倒序。
// authorID 非空时只返回该作者的记录（作者端「我的分成」）。
func (a *App) listPayoutRecords(ctx context.Context, month, authorID string) ([]PayoutRecord, error) {
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
	query += " ORDER BY p.month DESC, p.game_id ASC"
	rows, err := a.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PayoutRecord{}
	for rows.Next() {
		record, err := scanPayoutRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, record)
	}
	return out, rows.Err()
}

func (a *App) payoutRecordByID(ctx context.Context, id int64) (PayoutRecord, error) {
	return scanPayoutRecord(a.db.QueryRowContext(ctx, payoutSelect+` WHERE p.id = ?`, id))
}

// attachAuthorEmails 补上作者邮箱与账号中心 ID，供管理员去商城后台定位账号。
func (a *App) attachAuthorEmails(ctx context.Context, records []PayoutRecord) ([]PayoutRecord, error) {
	if len(records) == 0 {
		return records, nil
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
	for index := range records {
		records[index].AuthorEmail = emails[records[index].AuthorID]
	}
	return records, nil
}

// createPayoutRecord 录入一条发放记录。作者按 game_id 归属自动带出；没有归属作者
// 的 game_id（官方游戏或尚未指定归属）会被拒绝。
func (a *App) createPayoutRecord(ctx context.Context, month, gameID string, amountCNY int64, validPlays *int, note, operator string) (PayoutRecord, error) {
	if !validPayoutMonth(month) {
		return PayoutRecord{}, errInvalidPayoutMonth
	}
	if amountCNY <= 0 {
		return PayoutRecord{}, errPayoutAmount
	}
	note = strings.TrimSpace(note)
	if len(note) > 500 {
		return PayoutRecord{}, errPayoutNoteTooLong
	}
	owner, err := a.gameOwner(ctx, a.db, gameID)
	if err != nil {
		return PayoutRecord{}, err
	}
	if owner.AuthorID == "" {
		return PayoutRecord{}, errPayoutGameMissing
	}
	var plays any
	if validPlays != nil {
		if *validPlays < 0 {
			return PayoutRecord{}, errors.New("valid plays cannot be negative")
		}
		plays = *validPlays
	}
	now := nowUnix()
	result, err := a.db.ExecContext(ctx, `INSERT INTO payout_reports
		(month, game_id, author_id, author_name, valid_plays, amount_cny, note, paid_at, paid_by, created_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		month, gameID, owner.AuthorID, owner.AuthorName, plays, amountCNY, note, now, operator, now)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return PayoutRecord{}, errPayoutDuplicate
		}
		return PayoutRecord{}, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return PayoutRecord{}, err
	}
	record, err := a.payoutRecordByID(ctx, id)
	if err != nil {
		return PayoutRecord{}, err
	}
	withEmail, err := a.attachAuthorEmails(ctx, []PayoutRecord{record})
	if err != nil {
		return PayoutRecord{}, err
	}
	return withEmail[0], nil
}

// deletePayoutRecord 删除录错的发放记录。
func (a *App) deletePayoutRecord(ctx context.Context, id int64) error {
	result, err := a.db.ExecContext(ctx, `DELETE FROM payout_reports WHERE id = ?`, id)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed == 0 {
		return errPayoutRecordGone
	}
	return nil
}

// setGameOwner 指定 game_id 的归属作者。作者邮箱必须已经存在于 identities
// （即该账号至少登录过一次投稿平台），否则无法定位到账号中心的用户 ID。
func (a *App) setGameOwner(ctx context.Context, gameID, email, authorName, operator string) (assignedOwner, error) {
	if gameID == "" {
		return assignedOwner{}, errors.New("game id is required")
	}
	authorName = strings.TrimSpace(authorName)
	if authorName == "" || len(authorName) > 40 {
		return assignedOwner{}, errors.New("author name must be 1-40 characters")
	}
	email = normalizeEmail(email)
	if !strings.Contains(email, "@") {
		return assignedOwner{}, errGameOwnerEmailMissing
	}
	var authorID string
	err := a.db.QueryRowContext(ctx, `SELECT id FROM identities WHERE email = ?`, email).Scan(&authorID)
	if errors.Is(err, sql.ErrNoRows) {
		return assignedOwner{}, errGameOwnerEmailMissing
	}
	if err != nil {
		return assignedOwner{}, err
	}
	now := nowUnix()
	if _, err := a.db.ExecContext(ctx, `INSERT INTO game_owners(game_id, author_id, author_name, set_by, set_at)
		VALUES(?, ?, ?, ?, ?)
		ON CONFLICT(game_id) DO UPDATE SET author_id = excluded.author_id, author_name = excluded.author_name,
			set_by = excluded.set_by, set_at = excluded.set_at`,
		gameID, authorID, authorName, operator, now); err != nil {
		return assignedOwner{}, err
	}
	return assignedOwner{GameID: gameID, AuthorID: authorID, AuthorName: authorName, Email: email, SetBy: operator, SetAt: now}, nil
}

// errGameOwnerEmailMissing 表示指定归属时给的邮箱还没有在投稿平台登录过。
var errGameOwnerEmailMissing = errors.New("该邮箱尚未登录过投稿平台")
