package main

import (
	"context"
	"encoding/json"
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

// publishTestGameAs 同 publishTestGame，但可以指定这次投稿的署名。
func publishTestGameAs(t *testing.T, app *App, author, admin User, authorName, gameID, version string) (RegistryEntry, error) {
	t.Helper()
	ctx := context.Background()
	submission, err := app.createSubmission(ctx, author, authorName, "Game "+gameID, "", "zip", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := app.store.Put(ctx, submission.ZipKey, gameZIP(t, gameID, version), "application/zip"); err != nil {
		t.Fatal(err)
	}
	submission, err = app.completeZipSubmission(ctx, submission)
	if err != nil {
		return RegistryEntry{}, err
	}
	return app.publishSubmission(ctx, submission, admin)
}

// registryEntryOf 从玩法站用的 registry.json 里取某个 game_id 的条目。
func registryEntryOf(t *testing.T, app *App, gameID string) RegistryEntry {
	t.Helper()
	body, err := app.store.Get(context.Background(), "registry.json", 128*1024)
	if err != nil {
		t.Fatal(err)
	}
	var document registryDocument
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatal(err)
	}
	for _, entry := range document.Games {
		if entry.ID == gameID {
			return entry
		}
	}
	t.Fatalf("game %q is missing from registry.json", gameID)
	return RegistryEntry{}
}

// TestPublishKeepsOwnerAuthorName 覆盖前台署名与归属一致：管理员代发不改署名，
// 归属被指定时显示指定署名，作者本人更新时可以改署名，官方保留 ID 保持原行为。
func TestPublishKeepsOwnerAuthorName(t *testing.T) {
	app := payoutTestApp(t)
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	other := testIdentity(t, app, "mobile-other", "other@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")

	publishTestGame(t, app, author, admin, "owner-game", "1.0.0")
	// 管理员代发：署名仍是原作者，不是管理员这次投稿的署名。
	entry, err := publishTestGameAs(t, app, admin, admin, "Platform Team", "owner-game", "1.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if entry.AuthorName != "Author mobile-author" {
		t.Fatalf("admin update changed the author name: %#v", entry.AuthorName)
	}
	if got := registryEntryOf(t, app, "owner-game"); got.AuthorName != "Author mobile-author" || got.Version != "1.1.0" {
		t.Fatalf("registry shows the wrong author: %#v", got)
	}

	// 作者本人更新时可以改署名。
	entry, err = publishTestGameAs(t, app, author, admin, "New Name", "owner-game", "1.2.0")
	if err != nil {
		t.Fatal(err)
	}
	if entry.AuthorName != "New Name" || registryEntryOf(t, app, "owner-game").AuthorName != "New Name" {
		t.Fatalf("owner could not rename: %#v", entry.AuthorName)
	}

	// 归属指定后管理员代发：显示指定署名。
	insertOfficialRelease(t, app, "imported-game", "1.0.0")
	if _, err := app.setGameOwner(ctx, "imported-game", other.Email, "DK", admin.Email); err != nil {
		t.Fatal(err)
	}
	entry, err = publishTestGameAs(t, app, admin, admin, "Platform Team", "imported-game", "1.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if entry.AuthorName != "DK" || registryEntryOf(t, app, "imported-game").AuthorName != "DK" {
		t.Fatalf("assigned author name was not used: %#v", entry.AuthorName)
	}

	// 官方保留 ID 由管理员发布时保持原行为：用当次投稿的署名。
	insertOfficialRelease(t, app, "official-only", "1.0.0")
	entry, err = publishTestGameAs(t, app, admin, admin, "Platform Team", "official-only", "1.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if entry.AuthorName != "Platform Team" {
		t.Fatalf("official id behaviour changed: %#v", entry.AuthorName)
	}
}

// TestRemoveGameOwnerRestoresOriginalOwnership 覆盖撤销归属指定：删掉 game_owners 那一行后，
// 归属回落到「最早的社区 release 作者 > 官方保留」的原判定。
func TestRemoveGameOwnerRestoresOriginalOwnership(t *testing.T) {
	app := payoutTestApp(t)
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	other := testIdentity(t, app, "mobile-other", "other@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")

	// 导入的游戏：撤销后回到官方保留，别的作者不能发布、也不能录分成。
	insertOfficialRelease(t, app, "imported-game", "1.0.0")
	if _, err := app.setGameOwner(ctx, "imported-game", other.Email, "DK", admin.Email); err != nil {
		t.Fatal(err)
	}
	if err := app.removeGameOwner(ctx, "imported-game"); err != nil {
		t.Fatal(err)
	}
	if err := app.removeGameOwner(ctx, "imported-game"); err != errGameOwnerGone {
		t.Fatalf("second revoke error = %v, want errGameOwnerGone", err)
	}
	ownership, err := loadGameIDOwnership(ctx, app.db, "imported-game")
	if err != nil {
		t.Fatal(err)
	}
	if !ownership.Official || ownership.Assigned || ownership.OwnerAuthorID != "" {
		t.Fatalf("ownership did not fall back to official: %#v", ownership)
	}
	if _, err := publishZip(t, app, other, admin, "imported-game", "1.1.0"); err == nil {
		t.Fatal("author must not publish after the assignment was revoked")
	}
	if _, err := app.createPayoutRecord(ctx, "2026-09", "imported-game", 10, nil, "", admin.Email); err != errPayoutGameMissing {
		t.Fatalf("payout error = %v, want errPayoutGameMissing", err)
	}

	// 社区游戏：撤销后回到最早的社区 release 作者。
	publishTestGame(t, app, author, admin, "owner-game", "1.0.0")
	if _, err := app.setGameOwner(ctx, "owner-game", other.Email, "Other", admin.Email); err != nil {
		t.Fatal(err)
	}
	if err := app.removeGameOwner(ctx, "owner-game"); err != nil {
		t.Fatal(err)
	}
	ownership, err = loadGameIDOwnership(ctx, app.db, "owner-game")
	if err != nil {
		t.Fatal(err)
	}
	if ownership.OwnerAuthorID != author.ID || ownership.Assigned {
		t.Fatalf("ownership did not fall back to the first community author: %#v", ownership)
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
