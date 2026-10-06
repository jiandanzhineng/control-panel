package main

import (
	"context"
	"testing"
)

// publishTestGame 走完整投稿流程把一个社区游戏发布上线。
func publishTestGame(t *testing.T, app *App, author, admin User, gameID, version string) {
	t.Helper()
	ctx := context.Background()
	submission, err := app.createSubmission(ctx, author, "Author "+author.ID, "Game "+gameID, "", "zip", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := app.store.Put(ctx, submission.ZipKey, gameZIP(t, gameID, version), "application/zip"); err != nil {
		t.Fatal(err)
	}
	submission, err = app.completeZipSubmission(ctx, submission)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.publishSubmission(ctx, submission, admin); err != nil {
		t.Fatal(err)
	}
}

// TestPayoutOwnershipFollowsAssignedOwner 覆盖归属指定：被指定的导入游戏视为社区游戏，
// 作者本人可以升版更新，也可以录入分成。
func TestPayoutOwnershipFollowsAssignedOwner(t *testing.T) {
	app := payoutTestApp(t)
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	// 线上 surge-edging 的现实情况：导入时没有投稿记录，只有官方 release。
	insertOfficialRelease(t, app, "imported-game", "1.0.0")

	// 指定前：官方保留，作者不能发布，也不能录入分成。
	if _, err := publishZip(t, app, author, admin, "imported-game", "1.1.0"); err == nil {
		t.Fatal("author must not publish an unclaimed official id")
	}
	if _, err := app.createPayoutRecord(ctx, "2026-09", "imported-game", 10, nil, "", admin.Email); err != errPayoutGameMissing {
		t.Fatalf("unclaimed payout error = %v, want errPayoutGameMissing", err)
	}

	if _, err := app.setGameOwner(ctx, "imported-game", "author@example.com", "DK", admin.Email); err != nil {
		t.Fatal(err)
	}

	// 指定后：归属是 DK，作者本人可以升版更新。
	ownership, err := loadGameIDOwnership(ctx, app.db, "imported-game")
	if err != nil {
		t.Fatal(err)
	}
	if ownership.Official || ownership.OwnerAuthorID != author.ID || !ownership.Assigned {
		t.Fatalf("unexpected ownership after assignment: %#v", ownership)
	}
	if _, err := publishZip(t, app, author, admin, "imported-game", "1.1.0"); err != nil {
		t.Fatalf("owner could not update the assigned game: %v", err)
	}
	// 别的作者仍然不行。
	other := testIdentity(t, app, "mobile-other", "other@example.com", "author")
	if _, err := publishZip(t, app, other, admin, "imported-game", "1.2.0"); err == nil {
		t.Fatal("another author must not publish an assigned id")
	}

	// 指定后可以录入分成，且作者按归属带出。
	record, err := app.createPayoutRecord(ctx, "2026-09", "imported-game", 50, nil, "", admin.Email)
	if err != nil {
		t.Fatal(err)
	}
	if record.AuthorID != author.ID || record.AuthorName != "DK" {
		t.Fatalf("assigned author not used: %#v", record)
	}

	// 归属指定覆盖已有的社区作者。
	if _, err := app.setGameOwner(ctx, "imported-game", "other@example.com", "Other", admin.Email); err != nil {
		t.Fatal(err)
	}
	ownership, err = loadGameIDOwnership(ctx, app.db, "imported-game")
	if err != nil {
		t.Fatal(err)
	}
	if ownership.OwnerAuthorID != other.ID {
		t.Fatalf("reassignment did not take effect: %#v", ownership)
	}
	// 重新指定后，原作者不再是归属人。
	if _, err := publishZip(t, app, author, admin, "imported-game", "1.3.0"); err == nil {
		t.Fatal("former owner must not publish after reassignment")
	}
}
