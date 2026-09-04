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
	identity  *identityClient
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
	identity, err := newIdentityClient(config.IdentityAPIBaseURL, config.IdentityTimeout)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &App{config: config, db: db, store: store, identity: identity}, nil
}

func (a *App) close() error { return a.db.Close() }

func (a *App) syncIdentity(ctx context.Context, user User) error {
	user.Email = normalizeEmail(user.Email)
	if user.ID == "" || user.Email == "" {
		return errors.New("mobile identity is incomplete")
	}

	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var currentEmail string
	err = tx.QueryRowContext(ctx, `SELECT email FROM identities WHERE id = ?`, user.ID).Scan(&currentEmail)
	if err == nil {
		if currentEmail != user.Email {
			if _, err := tx.ExecContext(ctx, `UPDATE identities SET email = ?, updated_at = ? WHERE id = ?`, user.Email, nowUnix(), user.ID); err != nil {
				return err
			}
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	var emailOwner string
	err = tx.QueryRowContext(ctx, `SELECT id FROM identities WHERE email = ?`, user.Email).Scan(&emailOwner)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if _, err := tx.ExecContext(ctx, `INSERT INTO identities(id, email, created_at, updated_at) VALUES(?, ?, ?, ?)`, user.ID, user.Email, nowUnix(), nowUnix()); err != nil {
			return err
		}
	case err != nil:
		return err
	case strings.HasPrefix(emailOwner, "legacy:"):
		// A historical platform account becomes owned by the mobile account only after
		// the same email successfully authenticates with mobile.
		legacyEmail := "migrated-" + strings.ReplaceAll(emailOwner, ":", "-") + "@invalid.local"
		if _, err := tx.ExecContext(ctx, `UPDATE identities SET email = ? WHERE id = ?`, legacyEmail, emailOwner); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO identities(id, email, created_at, updated_at) VALUES(?, ?, ?, ?)`, user.ID, user.Email, nowUnix(), nowUnix()); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE submissions SET author_id = ? WHERE author_id = ?`, user.ID, emailOwner); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE submissions SET reviewed_by = ? WHERE reviewed_by = ?`, user.ID, emailOwner); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM identities WHERE id = ?`, emailOwner); err != nil {
			return err
		}
	default:
		return errors.New("email is already associated with a different mobile account")
	}
	return tx.Commit()
}

func (a *App) createSubmission(ctx context.Context, user User, authorName, title, description, kind, gitURL string) (Submission, error) {
	authorName = strings.TrimSpace(authorName)
	title = strings.TrimSpace(title)
	description = strings.TrimSpace(description)
	if len(authorName) < 2 || len(authorName) > 40 {
		return Submission{}, errors.New("author name must be 2-40 characters")
	}
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
	_, err = a.db.ExecContext(ctx, `INSERT INTO submissions(id, author_id, author_name, title, description, kind, git_url, zip_key, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, user.ID, authorName, title, description, kind, strings.TrimSpace(gitURL), zipKey, status, now, now)
	if err != nil {
		return Submission{}, err
	}
	return a.submissionByID(ctx, id)
}

func (a *App) submissionByID(ctx context.Context, id string) (Submission, error) {
	return scanSubmission(a.db.QueryRowContext(ctx, submissionSelect+` WHERE s.id = ?`, id))
}

func (a *App) listSubmissions(ctx context.Context, userID string, status string, admin bool) ([]Submission, error) {
	query := submissionSelect
	args := make([]any, 0, 2)
	if admin {
		if status != "" {
			query += ` WHERE s.status = ?`
			args = append(args, status)
		}
	} else {
		query += ` WHERE s.author_id = ?`
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
