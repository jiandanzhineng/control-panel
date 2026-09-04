package main

import (
	"database/sql"
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
	statements := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'author',
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS submissions (
			id TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id),
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			kind TEXT NOT NULL CHECK(kind IN ('zip', 'git')),
			git_url TEXT NOT NULL DEFAULT '',
			zip_key TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL CHECK(status IN ('draft', 'pending', 'changes_requested', 'rejected', 'published')),
			review_note TEXT NOT NULL DEFAULT '',
			reviewed_by INTEGER REFERENCES users(id),
			release_id TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id, created_at DESC)`,
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

const submissionSelect = `SELECT s.id, s.user_id, u.display_name, s.title, s.description,
	s.kind, s.git_url, s.zip_key, s.status, s.review_note,
	COALESCE(reviewer.display_name, ''), s.release_id, s.created_at, s.updated_at
	FROM submissions s
	JOIN users u ON u.id = s.user_id
	LEFT JOIN users reviewer ON reviewer.id = s.reviewed_by`

func normalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }
