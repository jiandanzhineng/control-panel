package main

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

func openDatabase(path string) (*sql.DB, error) {
	if err := ensureParentDir(path); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA foreign_keys = ON",
		"PRAGMA busy_timeout = 5000",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("database setup: %w", err)
		}
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func migrate(db *sql.DB) error {
	if err := migrateLegacyLocalAccounts(db); err != nil {
		return err
	}
	// payout_reports 的语义变了：从「自动拉 OpenPanel 生成的月度报表」改成
	// 「管理员手工录入的发放记录」，主键、字段和状态列都不同。旧结构从未上线过
	// 生产（2026-10-06 之前只在开发分支存在），所以这里检测到旧表就直接 DROP 重建，
	// 不做数据迁移。
	if err := dropLegacyPayoutReports(db); err != nil {
		return err
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS identities (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS submissions (
			id TEXT PRIMARY KEY,
			author_id TEXT NOT NULL REFERENCES identities(id),
			author_name TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			kind TEXT NOT NULL CHECK(kind IN ('zip', 'git')),
			git_url TEXT NOT NULL DEFAULT '',
			zip_key TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL CHECK(status IN ('draft', 'pending', 'changes_requested', 'rejected', 'published')),
			review_note TEXT NOT NULL DEFAULT '',
			reviewed_by TEXT REFERENCES identities(id),
			release_id TEXT NOT NULL DEFAULT '',
			author_is_admin INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_submissions_author ON submissions(author_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, updated_at ASC)`,
		`CREATE TABLE IF NOT EXISTS releases (
			id TEXT PRIMARY KEY,
			submission_id TEXT REFERENCES submissions(id),
			game_id TEXT NOT NULL,
			version TEXT NOT NULL,
			entry_json TEXT NOT NULL,
			source_hash TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'revoked')),
			created_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_releases_active ON releases(status, game_id)`,
		// 管理员手工录入的发放记录。唯一键 (month, game_id) 保证同月同游戏只录一条；
		// valid_plays 可空，是管理员从 OpenPanel 手抄的参考数据，不参与计算。
		`CREATE TABLE IF NOT EXISTS payout_reports (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			month TEXT NOT NULL,
			game_id TEXT NOT NULL,
			author_id TEXT NOT NULL DEFAULT '',
			author_name TEXT NOT NULL DEFAULT '',
			valid_plays INTEGER,
			amount_cny INTEGER NOT NULL,
			note TEXT NOT NULL DEFAULT '',
			paid_at INTEGER NOT NULL DEFAULT 0,
			paid_by TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL DEFAULT 0,
			UNIQUE (month, game_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_payout_reports_author ON payout_reports(author_id, month DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_payout_reports_month ON payout_reports(month DESC, game_id ASC)`,
		// game_owners 记录管理员手工指定的 game_id 归属，优先级高于「首个社区 release 作者」。
		// 用于把导入时没有投稿记录、实际是社区作者的游戏认领给作者。
		`CREATE TABLE IF NOT EXISTS game_owners (
			game_id TEXT PRIMARY KEY,
			author_id TEXT NOT NULL,
			author_name TEXT NOT NULL,
			set_by TEXT NOT NULL DEFAULT '',
			set_at INTEGER NOT NULL DEFAULT 0
		)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	// 旧库补列：发布事务里要按「投稿时是否为管理员」判归属，所以随投稿一起落库。
	var hasAuthorIsAdmin int
	err := db.QueryRow(`SELECT 1 FROM pragma_table_info('submissions') WHERE name = 'author_is_admin'`).Scan(&hasAuthorIsAdmin)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := db.Exec(`ALTER TABLE submissions ADD COLUMN author_is_admin INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	return nil
}

// dropLegacyPayoutReports 删掉旧结构的 payout_reports（有 status/generated_at、
// 主键是 (month, game_id) 的那一版）。当前新表主键是 id 自增，两者不兼容。
func dropLegacyPayoutReports(db *sql.DB) error {
	var found int
	err := db.QueryRow(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'payout_reports'`).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	// 新表已有 id 列说明已经是新结构，什么都不用做。
	var hasID int
	if err := db.QueryRow(`SELECT 1 FROM pragma_table_info('payout_reports') WHERE name = 'id'`).Scan(&hasID); err == nil {
		return nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := db.Exec(`DROP TABLE payout_reports`); err != nil {
		return err
	}
	return nil
}

func migrateLegacyLocalAccounts(db *sql.DB) error {
	var found int
	err := db.QueryRow(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := db.Exec(`PRAGMA foreign_keys = OFF`); err != nil {
		return err
	}
	defer db.Exec(`PRAGMA foreign_keys = ON`)

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statements := []string{
		`ALTER TABLE users RENAME TO legacy_users`,
		`ALTER TABLE submissions RENAME TO legacy_submissions`,
		`ALTER TABLE releases RENAME TO legacy_releases`,
		`CREATE TABLE identities (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE submissions (
			id TEXT PRIMARY KEY,
			author_id TEXT NOT NULL REFERENCES identities(id),
			author_name TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			kind TEXT NOT NULL CHECK(kind IN ('zip', 'git')),
			git_url TEXT NOT NULL DEFAULT '',
			zip_key TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL CHECK(status IN ('draft', 'pending', 'changes_requested', 'rejected', 'published')),
			review_note TEXT NOT NULL DEFAULT '',
			reviewed_by TEXT REFERENCES identities(id),
			release_id TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE releases (
			id TEXT PRIMARY KEY,
			submission_id TEXT REFERENCES submissions(id),
			game_id TEXT NOT NULL,
			version TEXT NOT NULL,
			entry_json TEXT NOT NULL,
			source_hash TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'revoked')),
			created_at INTEGER NOT NULL
		)`,
		`INSERT INTO identities(id, email, created_at, updated_at)
			SELECT 'legacy:' || id, email, created_at, created_at FROM legacy_users`,
		`INSERT INTO submissions(id, author_id, author_name, title, description, kind, git_url, zip_key, status, review_note, reviewed_by, release_id, created_at, updated_at)
			SELECT s.id, 'legacy:' || s.user_id, u.display_name, s.title, s.description, s.kind, s.git_url, s.zip_key, s.status, s.review_note,
				CASE WHEN s.reviewed_by IS NULL THEN NULL ELSE 'legacy:' || s.reviewed_by END, s.release_id, s.created_at, s.updated_at
			FROM legacy_submissions s JOIN legacy_users u ON u.id = s.user_id`,
		`INSERT INTO releases(id, submission_id, game_id, version, entry_json, source_hash, status, created_at)
			SELECT id, submission_id, game_id, version, entry_json, source_hash, status, created_at FROM legacy_releases`,
		`DROP TABLE legacy_releases`,
		`DROP TABLE legacy_submissions`,
		`DROP TABLE legacy_users`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return fmt.Errorf("migrate local accounts: %w", err)
		}
	}
	return tx.Commit()
}

func nowUnix() int64 { return time.Now().UTC().Unix() }

func scanSubmission(scanner interface{ Scan(...any) error }) (Submission, error) {
	var submission Submission
	var reviewedBy sql.NullString
	err := scanner.Scan(
		&submission.ID, &submission.UserID, &submission.AuthorName, &submission.Title, &submission.Description,
		&submission.Kind, &submission.GitURL, &submission.ZipKey, &submission.Status, &submission.ReviewNote,
		&reviewedBy, &submission.ReleaseID, &submission.AuthorIsAdmin, &submission.CreatedAt, &submission.UpdatedAt,
	)
	if err != nil {
		return Submission{}, err
	}
	if reviewedBy.Valid {
		submission.ReviewedBy = reviewedBy.String
	}
	return submission, nil
}

const submissionSelect = `SELECT s.id, s.author_id, s.author_name, s.title, s.description,
	s.kind, s.git_url, s.zip_key, s.status, s.review_note,
	COALESCE(reviewer.email, ''), s.release_id, s.author_is_admin, s.created_at, s.updated_at
	FROM submissions s
	LEFT JOIN identities reviewer ON reviewer.id = s.reviewed_by`

func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }
