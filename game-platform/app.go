package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
)

type App struct {
	config    Config
	db        *sql.DB
	store     ObjectStore
	publishMu sync.Mutex
}

func newApp(config Config) (*App, error) {
	db, err := openDatabase(config.DatabasePath)
	if err != nil {
		return nil, err
	}
	store, err := newObjectStore(config)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &App{config: config, db: db, store: store}, nil
}

func (a *App) close() error { return a.db.Close() }

func (a *App) userByID(ctx context.Context, id int64) (User, error) {
	var user User
	err := a.db.QueryRowContext(ctx, `SELECT id, email, display_name, role FROM users WHERE id = ?`, id).Scan(&user.ID, &user.Email, &user.DisplayName, &user.Role)
	if err != nil {
		return User{}, err
	}
	return user, nil
}

func (a *App) userByEmail(ctx context.Context, email string) (User, string, error) {
	var user User
	var passwordHash string
	err := a.db.QueryRowContext(ctx, `SELECT id, email, display_name, role, password_hash FROM users WHERE email = ?`, normalizeEmail(email)).Scan(&user.ID, &user.Email, &user.DisplayName, &user.Role, &passwordHash)
	if err != nil {
		return User{}, "", err
	}
	return user, passwordHash, nil
}

func (a *App) createUser(ctx context.Context, email, displayName, password string) (User, error) {
	email = normalizeEmail(email)
	displayName = strings.TrimSpace(displayName)
	if !strings.Contains(email, "@") || len(email) > 254 {
		return User{}, errors.New("email is invalid")
	}
	if len(displayName) < 2 || len(displayName) > 40 {
		return User{}, errors.New("display name must be 2-40 characters")
	}
	if len(password) < 10 || len(password) > 128 {
		return User{}, errors.New("password must be 10-128 characters")
	}
	passwordHash, err := hashPassword(password)
	if err != nil {
		return User{}, err
	}
	role := "author"
	if a.config.AdminEmails[email] {
		role = "admin"
	}
	result, err := a.db.ExecContext(ctx, `INSERT INTO users(email, display_name, password_hash, role, created_at) VALUES(?, ?, ?, ?, ?)`, email, displayName, passwordHash, role, nowUnix())
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return User{}, errors.New("email is already registered")
		}
		return User{}, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return User{}, err
	}
	return User{ID: id, Email: email, DisplayName: displayName, Role: role}, nil
}

func (a *App) createSubmission(ctx context.Context, user User, title, description, kind, gitURL string) (Submission, error) {
	title = strings.TrimSpace(title)
	description = strings.TrimSpace(description)
	if len(title) < 2 || len(title) > 100 {
		return Submission{}, errors.New("title must be 2-100 characters")
	}
	if len(description) > 2000 {
		return Submission{}, errors.New("description is too long")
	}
	if kind != "zip" && kind != "git" {
		return Submission{}, errors.New("submission kind must be zip or git")
	}
	if kind == "git" {
		if _, err := validateGitURL(gitURL); err != nil {
			return Submission{}, err
		}
	} else {
		gitURL = ""
	}
	id, err := randomID("sub_")
	if err != nil {
		return Submission{}, err
	}
	now := nowUnix()
	status := "pending"
	zipKey := ""
	if kind == "zip" {
		status = "draft"
		zipKey = a.config.SubmissionPrefix + "/" + id + "/source.zip"
	}
	_, err = a.db.ExecContext(ctx, `INSERT INTO submissions(id, user_id, title, description, kind, git_url, zip_key, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, user.ID, title, description, kind, strings.TrimSpace(gitURL), zipKey, status, now, now)
	if err != nil {
		return Submission{}, err
	}
	return a.submissionByID(ctx, id)
}

func (a *App) submissionByID(ctx context.Context, id string) (Submission, error) {
	return scanSubmission(a.db.QueryRowContext(ctx, submissionSelect+` WHERE s.id = ?`, id))
}

func (a *App) listSubmissions(ctx context.Context, userID int64, status string, admin bool) ([]Submission, error) {
	query := submissionSelect
	args := make([]any, 0, 2)
	if admin {
		if status != "" {
			query += ` WHERE s.status = ?`
			args = append(args, status)
		}
	} else {
		query += ` WHERE s.user_id = ?`
		args = append(args, userID)
	}
	query += ` ORDER BY s.updated_at DESC`
	rows, err := a.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Submission{}
	for rows.Next() {
		submission, err := scanSubmission(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, submission)
	}
	return out, rows.Err()
}

func (a *App) completeZipSubmission(ctx context.Context, submission Submission) (Submission, error) {
	if submission.Kind != "zip" || submission.Status != "draft" {
		return Submission{}, errors.New("submission cannot be completed")
	}
	meta, err := a.store.Head(ctx, submission.ZipKey)
	if err != nil {
		return Submission{}, errors.New("uploaded zip was not found")
	}
	if meta.Size <= 0 || meta.Size > a.config.MaxUploadBytes {
		return Submission{}, errors.New("uploaded zip exceeds maximum size")
	}
	source, err := a.store.Get(ctx, submission.ZipKey, a.config.MaxUploadBytes)
	if err != nil {
		return Submission{}, errors.New("uploaded zip could not be read")
	}
	if _, err := prepareGameArchive(source, a.config); err != nil {
		return Submission{}, err
	}
	_, err = a.db.ExecContext(ctx, `UPDATE submissions SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'draft'`, nowUnix(), submission.ID)
	if err != nil {
		return Submission{}, err
	}
	return a.submissionByID(ctx, submission.ID)
}

func (a *App) reviewSubmission(ctx context.Context, submission Submission, reviewer User, status, note string) (Submission, error) {
	if reviewer.Role != "admin" {
		return Submission{}, errors.New("admin role required")
	}
	if status != "changes_requested" && status != "rejected" {
		return Submission{}, errors.New("review status is invalid")
	}
	note = strings.TrimSpace(note)
	if len(note) < 2 || len(note) > 2000 {
		return Submission{}, errors.New("review note must be 2-2000 characters")
	}
	_, err := a.db.ExecContext(ctx, `UPDATE submissions SET status = ?, review_note = ?, reviewed_by = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'changes_requested')`, status, note, reviewer.ID, nowUnix(), submission.ID)
	if err != nil {
		return Submission{}, err
	}
	return a.submissionByID(ctx, submission.ID)
}

func (a *App) assertSubmissionOwner(submission Submission, user User) error {
	if submission.UserID != user.ID && user.Role != "admin" {
		return fmt.Errorf("submission not found")
	}
	return nil
}
