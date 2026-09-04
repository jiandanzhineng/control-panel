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
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
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
		&reviewedBy, &submission.ReleaseID, &submission.CreatedAt, &submission.UpdatedAt,
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
	COALESCE(reviewer.email, ''), s.release_id, s.created_at, s.updated_at
	FROM submissions s
	LEFT JOIN identities reviewer ON reviewer.id = s.reviewed_by`

func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }
