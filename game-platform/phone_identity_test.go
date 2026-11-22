package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestPhoneIdentitySubmissionAndPayout(t *testing.T) {
	center := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		verified := r.Header.Get("Authorization") != "Bearer unverified"
		_ = json.NewEncoder(w).Encode(map[string]any{"user": map[string]any{"id": "phone-author", "email": nil, "provider": "phone", "phoneVerified": verified, "phoneMasked": "+86138****0000", "isAdmin": false}})
	}))
	defer center.Close()
	cfg := testConfig(t.TempDir())
	cfg.IdentityAPIBaseURL = center.URL
	app, err := newApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	req := httptest.NewRequest("GET", "/api/auth/me", nil)
	req.Header.Set("Authorization", "Bearer phone")
	user, err := app.currentUser(req)
	if err != nil {
		t.Fatal(err)
	}
	if user.Email != "" || user.Role != "author" || !user.PhoneVerified {
		t.Fatalf("unexpected phone identity: %#v", user)
	}
	req.Header.Set("Authorization", "Bearer unverified")
	if _, err := app.currentUser(req); err == nil {
		t.Fatal("unverified phone accepted")
	}
	ctx := context.Background()
	if err := app.syncIdentity(ctx, User{ID: "second-phone", PhoneVerified: true, PhoneMasked: "+86139****0000"}); err != nil {
		t.Fatal(err)
	}
	submission, err := app.createSubmission(ctx, user, "Public Author", "Phone game", "", "git", "https://github.com/example/game")
	if err != nil {
		t.Fatal(err)
	}
	if submission.UserID != user.ID {
		t.Fatal("submission ownership changed")
	}
	owner, err := app.setGameOwner(ctx, "phone-game", user.ID, "Public Author", "admin-id")
	if err != nil {
		t.Fatal(err)
	}
	if owner.AuthorID != user.ID {
		t.Fatal("owner lookup did not use central ID")
	}
	payout, err := app.createPayoutRecord(ctx, "2026-11", "phone-game", 100, nil, "", "admin-id")
	if err != nil {
		t.Fatal(err)
	}
	if payout.AuthorID != user.ID || payout.AuthorPhoneMasked != user.PhoneMasked {
		t.Fatalf("payout identity lost: %#v", payout)
	}
	other, err := app.listPayoutRecords(ctx, "", "second-phone")
	if err != nil || len(other) != 0 {
		t.Fatal("payout visible to another user")
	}
}

func TestNullableIdentityMigrationPreservesAuthorReferences(t *testing.T) {
	cfg := testConfig(t.TempDir())
	cfg.DatabasePath = filepath.Join(t.TempDir(), "legacy.db")
	app, err := newApp(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	user := testIdentity(t, app, "old-center-id", "legacy@test.local", "author")
	submission, err := app.createSubmission(ctx, user, "Legacy Author", "Old game", "", "git", "https://github.com/example/old")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = app.setGameOwner(ctx, "legacy-game", user.ID, "Legacy Author", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err = app.createPayoutRecord(ctx, "2026-10", "legacy-game", 100, nil, "", "admin"); err != nil {
		t.Fatal(err)
	}
	_, err = app.db.Exec(`PRAGMA foreign_keys=OFF;
 CREATE TABLE old_identities(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 INSERT INTO old_identities SELECT id,email,created_at,updated_at FROM identities;
 DROP TABLE identities; ALTER TABLE old_identities RENAME TO identities; PRAGMA foreign_keys=ON;`)
	if err != nil {
		t.Fatal(err)
	}
	app.close()
	for i := 0; i < 2; i++ {
		app, err = newApp(cfg)
		if err != nil {
			t.Fatal(err)
		}
		var authorID string
		if err = app.db.QueryRow(`SELECT author_id FROM submissions WHERE id=?`, submission.ID).Scan(&authorID); err != nil || authorID != user.ID {
			t.Fatal("submission reference lost", err)
		}
		payouts, err := app.listPayoutRecords(ctx, "", user.ID)
		if err != nil || len(payouts) != 1 {
			t.Fatal("payout reference lost", err)
		}
		owner, err := app.gameOwner(ctx, app.db, "legacy-game")
		if err != nil || owner.AuthorID != user.ID {
			t.Fatal("owner reference lost", err)
		}
		if err = app.syncIdentity(ctx, User{ID: "phone-new", PhoneVerified: true, PhoneMasked: "+86138****0000"}); err != nil {
			t.Fatal(err)
		}
		app.close()
	}
}
