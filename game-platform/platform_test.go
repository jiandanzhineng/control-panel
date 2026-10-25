package main

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testConfig(dir string) Config {
	return Config{
		Environment:        "test",
		DatabasePath:       filepath.Join(dir, "game-platform.db"),
		StorageDriver:      "filesystem",
		LocalStorageDir:    filepath.Join(dir, "objects"),
		IdentityAPIBaseURL: "http://identity.invalid",
		IdentityTimeout:    2 * time.Second,
		MaxUploadBytes:     256 * 1024,
		MaxUnpackedBytes:   1024 * 1024,
		MaxArchiveFiles:    20,
		SubmissionPrefix:   "submissions",
	}
}

func testIdentity(t *testing.T, app *App, id, email, role string) User {
	t.Helper()
	user := User{ID: id, Email: email, Role: role}
	if err := app.syncIdentity(context.Background(), user); err != nil {
		t.Fatal(err)
	}
	return user
}

func gameZIP(t *testing.T, id, version string) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	index, err := writer.Create("index.html")
	if err != nil {
		t.Fatal(err)
	}
	manifest := `{"id":"` + id + `","title":"Test Game","description":"A test game","version":"` + version + `","devices":[],"params":[],"permissions":[],"allowedOrigins":[]}`
	if _, err := index.Write([]byte("<script id=\"game-manifest\" type=\"application/json\">" + manifest + "</script><script src=\"game.js\"></script>")); err != nil {
		t.Fatal(err)
	}
	game, err := writer.Create("game.js")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := game.Write([]byte("window.testGame = true;")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

// pendingZipSubmission 造一个已上传、状态 pending 的 ZIP 投稿。
// 直接落库跳过 completeZipSubmission 的提前校验，用来单独验证发布事务里的硬校验。
func pendingZipSubmission(t *testing.T, app *App, author User, id, version string) Submission {
	t.Helper()
	ctx := context.Background()
	submission, err := app.createSubmission(ctx, author, "Author", "Test Game", "description", "zip", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := app.store.Put(ctx, submission.ZipKey, gameZIP(t, id, version), "application/zip"); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.ExecContext(ctx, `UPDATE submissions SET status = 'pending' WHERE id = ?`, submission.ID); err != nil {
		t.Fatal(err)
	}
	submission, err = app.submissionByID(ctx, submission.ID)
	if err != nil {
		t.Fatal(err)
	}
	return submission
}

// publishZip 走完整投稿流程（上传 → complete 提前校验 → 批准发布）。
func publishZip(t *testing.T, app *App, author, admin User, id, version string) (RegistryEntry, error) {
	t.Helper()
	ctx := context.Background()
	submission, err := app.createSubmission(ctx, author, "Author", "Test Game", "description", "zip", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := app.store.Put(ctx, submission.ZipKey, gameZIP(t, id, version), "application/zip"); err != nil {
		t.Fatal(err)
	}
	submission, err = app.completeZipSubmission(ctx, submission)
	if err != nil {
		return RegistryEntry{}, err
	}
	return app.publishSubmission(ctx, submission, admin)
}

func insertOfficialRelease(t *testing.T, app *App, id, version string) {
	t.Helper()
	entryJSON := `{"id":"` + id + `","title":"Official","version":"` + version + `","source":"builtin","path":"games/` + id + `/index.html","packageUrl":"packages/` + id + `.zip","packageSha256":"12345678"}`
	if _, err := app.db.ExecContext(context.Background(), `INSERT INTO releases(id, submission_id, game_id, version, entry_json, source_hash, status, created_at) VALUES(?, NULL, ?, ?, ?, '12345678', 'active', 1)`, "import_"+id, id, version, entryJSON); err != nil {
		t.Fatal(err)
	}
}

func TestPublishRejectsGameIDOwnedByAnotherAuthor(t *testing.T) {
	config := testConfig(t.TempDir())
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	other := testIdentity(t, app, "mobile-other", "other@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	if _, err := publishZip(t, app, author, admin, "shared-game", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := publishZip(t, app, other, admin, "shared-game", "1.0.1"); err == nil || !strings.Contains(err.Error(), "已被占用") {
		t.Fatalf("other author publish error = %v, want 已被占用", err)
	}
	if _, err := app.publishSubmission(ctx, pendingZipSubmission(t, app, other, "shared-game", "1.0.2"), admin); err == nil || !strings.Contains(err.Error(), "已被占用") {
		t.Fatalf("publish-time ownership check error = %v, want 已被占用", err)
	}
	entries, err := app.activeEntries(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Version != "1.0.0" {
		t.Fatalf("published game was overwritten: %#v", entries)
	}
}

func TestPublishRejectsOfficialGameIDForNonAdmin(t *testing.T) {
	config := testConfig(t.TempDir())
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	insertOfficialRelease(t, app, "official-game", "1.0.0")
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	if _, err := publishZip(t, app, author, admin, "official-game", "2.0.0"); err == nil || !strings.Contains(err.Error(), "官方") {
		t.Fatalf("community publish on official id error = %v, want 官方保留", err)
	}
	if _, err := app.publishSubmission(context.Background(), pendingZipSubmission(t, app, author, "official-game", "2.0.0"), admin); err == nil || !strings.Contains(err.Error(), "官方") {
		t.Fatalf("publish-time official check error = %v, want 官方保留", err)
	}
}

func TestAdminCanUpdateOfficialGameID(t *testing.T) {
	config := testConfig(t.TempDir())
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	ctx := context.Background()
	insertOfficialRelease(t, app, "official-game", "1.0.0")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	entry, err := publishZip(t, app, admin, admin, "official-game", "1.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if entry.ID != "official-game" || entry.Version != "1.1.0" {
		t.Fatalf("unexpected official update entry: %#v", entry)
	}
	entries, err := app.activeEntries(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Version != "1.1.0" {
		t.Fatalf("official game was not superseded: %#v", entries)
	}
}

func TestAdminCanUpdateCommunityGameWithoutTakingOwnership(t *testing.T) {
	config := testConfig(t.TempDir())
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	// 线上 surge-edging 的情况：社区作者的游戏，团队仓库继续维护新版。
	if _, err := publishZip(t, app, author, admin, "surge-edging", "1.4.1"); err != nil {
		t.Fatal(err)
	}
	entry, err := publishZip(t, app, admin, admin, "surge-edging", "1.5.0")
	if err != nil {
		t.Fatalf("admin could not update a community game: %v", err)
	}
	if entry.ID != "surge-edging" || entry.Version != "1.5.0" {
		t.Fatalf("unexpected entry: %#v", entry)
	}
	// 归属仍是原作者，管理员发布不改变归属。
	ownership, err := loadGameIDOwnership(ctx, app.db, "surge-edging")
	if err != nil {
		t.Fatal(err)
	}
	if ownership.OwnerAuthorID != author.ID || ownership.Official {
		t.Fatalf("ownership changed after an admin update: %#v", ownership)
	}
	// 版本仍须严格升高。
	if _, err := publishZip(t, app, admin, admin, "surge-edging", "1.5.0"); err == nil || !strings.Contains(err.Error(), "版本号") {
		t.Fatalf("same version error = %v, want 版本号", err)
	}
	// 原作者升版照常，且审核后台对管理员投稿标记为 admin。
	if _, err := publishZip(t, app, author, admin, "surge-edging", "1.6.0"); err != nil {
		t.Fatalf("owner could not continue updating: %v", err)
	}
	if status := app.gameIDStatus(ctx, app.db, admin.ID, true, "surge-edging", "1.7.0"); status != gameIDStatusAdmin {
		t.Fatalf("admin status = %q, want %q", status, gameIDStatusAdmin)
	}
	if status := app.gameIDStatus(ctx, app.db, admin.ID, true, "surge-edging", "1.5.0"); status != gameIDStatusConflict {
		t.Fatalf("stale admin status = %q, want %q", status, gameIDStatusConflict)
	}
	if status := app.gameIDStatus(ctx, app.db, author.ID, false, "surge-edging", "1.7.0"); status != gameIDStatusOwn {
		t.Fatalf("owner status = %q, want %q", status, gameIDStatusOwn)
	}
}

func TestAuthorCanUpdateOwnGameWithHigherVersion(t *testing.T) {
	config := testConfig(t.TempDir())
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	if _, err := publishZip(t, app, author, admin, "own-game", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	entry, err := publishZip(t, app, author, admin, "own-game", "1.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if entry.Version != "1.1.0" {
		t.Fatalf("unexpected update version: %#v", entry)
	}
	entries, err := app.activeEntries(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Version != "1.1.0" {
		t.Fatalf("unexpected active entries after update: %#v", entries)
	}
}

func TestAuthorCannotPublishSameOrLowerVersion(t *testing.T) {
	config := testConfig(t.TempDir())
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	if _, err := publishZip(t, app, author, admin, "versioned-game", "1.1.0"); err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{"1.1.0", "1.0.9"} {
		if _, err := publishZip(t, app, author, admin, "versioned-game", version); err == nil || !strings.Contains(err.Error(), "版本号") {
			t.Fatalf("version %s error = %v, want 版本号", version, err)
		}
	}
}

func TestRevokedGameIDCannotBeReusedByAnotherAuthor(t *testing.T) {
	config := testConfig(t.TempDir())
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	other := testIdentity(t, app, "mobile-other", "other@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	if _, err := publishZip(t, app, author, admin, "revoked-game", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if err := app.revokeRelease(ctx, "revoked-game"); err != nil {
		t.Fatal(err)
	}
	if _, err := publishZip(t, app, other, admin, "revoked-game", "1.0.1"); err == nil || !strings.Contains(err.Error(), "已被占用") {
		t.Fatalf("revoked id reuse error = %v, want 已被占用", err)
	}
	if _, err := publishZip(t, app, author, admin, "revoked-game", "1.0.1"); err != nil {
		t.Fatalf("owner could not republish revoked id: %v", err)
	}
}

func TestAdminListShowsGameIDStatus(t *testing.T) {
	config := testConfig(t.TempDir())
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	other := testIdentity(t, app, "mobile-other", "other@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	if _, err := publishZip(t, app, author, admin, "status-game", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	insertOfficialRelease(t, app, "status-official", "1.0.0")
	for _, gameID := range []string{"status-game", "status-fresh", "status-official"} {
		pendingZipSubmission(t, app, other, gameID, "1.0.1")
	}
	submissions, err := app.listSubmissions(ctx, "", "pending", true)
	if err != nil {
		t.Fatal(err)
	}
	app.annotateGameID(ctx, submissions)
	got := map[string]string{}
	for _, submission := range submissions {
		got[submission.GameID] = submission.GameIDStatus
	}
	want := map[string]string{"status-game": "conflict", "status-fresh": "new", "status-official": "official"}
	for gameID, status := range want {
		if got[gameID] != status {
			t.Fatalf("game id %s status = %q, want %q (all: %#v)", gameID, got[gameID], status, got)
		}
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.1", "1.0.0", 1},
		{"1.0.0", "1.0.1", -1},
		{"1.10.0", "1.9.0", 1},
		{"2.0.0", "1.99.99", 1},
		{"1.0.0", "1.0.0-beta.1", 1},
		{"1.0.0-beta.2", "1.0.0-beta.1", 1},
		{"1.0.0-beta.1", "1.0.0-alpha.9", 1},
		{"1.0.0-alpha.1", "1.0.0-alpha.beta", -1},
		{"1.0.0+build.2", "1.0.0+build.1", 0},
	}
	for _, testCase := range cases {
		got, err := compareVersions(testCase.left, testCase.right)
		if err != nil {
			t.Fatalf("compareVersions(%s, %s): %v", testCase.left, testCase.right, err)
		}
		if got != testCase.want {
			t.Fatalf("compareVersions(%s, %s) = %d, want %d", testCase.left, testCase.right, got, testCase.want)
		}
	}
	if _, err := compareVersions("not-semver", "1.0.0"); err == nil {
		t.Fatal("invalid version was accepted")
	}
}

func TestZipCompletionRejectsTakenGameIDEarly(t *testing.T) {
	config := testConfig(t.TempDir())
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	other := testIdentity(t, app, "mobile-other", "other@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	if _, err := publishZip(t, app, author, admin, "taken-game", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	submission, err := app.createSubmission(ctx, other, "Other", "Taken Game", "", "zip", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := app.store.Put(ctx, submission.ZipKey, gameZIP(t, "taken-game", "1.0.1"), "application/zip"); err != nil {
		t.Fatal(err)
	}
	if _, err := app.completeZipSubmission(ctx, submission); err == nil || !strings.Contains(err.Error(), "已被占用") {
		t.Fatalf("early ownership check error = %v, want 已被占用", err)
	}
	stored, err := app.submissionByID(ctx, submission.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "draft" {
		t.Fatalf("submission status = %q, want draft", stored.Status)
	}
}

func TestZipSubmissionPublishesRegistry(t *testing.T) {
	config := testConfig(t.TempDir())
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	submission, err := app.createSubmission(ctx, author, "Author", "Test Game", "description", "zip", "")
	if err != nil {
		t.Fatal(err)
	}
	if submission.Status != "draft" || submission.ZipKey == "" {
		t.Fatalf("unexpected initial submission: %#v", submission)
	}
	if err := app.store.Put(ctx, submission.ZipKey, gameZIP(t, "test-game", "1.2.3"), "application/zip"); err != nil {
		t.Fatal(err)
	}
	submission, err = app.completeZipSubmission(ctx, submission)
	if err != nil {
		t.Fatal(err)
	}
	if submission.Status != "pending" {
		t.Fatalf("submission status = %q, want pending", submission.Status)
	}
	entry, err := app.publishSubmission(ctx, submission, admin)
	if err != nil {
		t.Fatal(err)
	}
	if entry.ID != "test-game" || entry.PackageURL == "" || entry.Path == "" || entry.AuthorName != "Author" {
		t.Fatalf("unexpected published entry: %#v", entry)
	}
	registry, err := app.store.Get(ctx, "registry.json", 128*1024)
	if err != nil {
		t.Fatal(err)
	}
	var document registryDocument
	if err := json.Unmarshal(registry, &document); err != nil {
		t.Fatal(err)
	}
	if document.SchemaVersion != 2 || len(document.Games) != 1 || document.Games[0].ID != entry.ID || document.Games[0].AuthorName != "Author" {
		t.Fatalf("unexpected registry: %#v", document)
	}
	if _, err := app.store.Get(ctx, entry.Path, 128*1024); err != nil {
		t.Fatalf("published index is missing: %v", err)
	}
	if _, err := app.store.Get(ctx, entry.PackageURL, 128*1024); err != nil {
		t.Fatalf("published package is missing: %v", err)
	}
}

func TestRebuildRegistryBackfillsPublishedAuthorName(t *testing.T) {
	config := testConfig(t.TempDir())
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	submission, err := app.createSubmission(ctx, author, "Posted Author", "Old Game", "", "zip", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.ExecContext(ctx, `UPDATE submissions SET status = 'published' WHERE id = ?`, submission.ID); err != nil {
		t.Fatal(err)
	}
	entryJSON := `{"id":"old-game","title":"Old Game","version":"1.0.0","source":"community","path":"games/old-game/index.html","packageUrl":"packages/old-game.zip","packageSha256":"12345678"}`
	if _, err := app.db.ExecContext(ctx, `INSERT INTO releases(id, submission_id, game_id, version, entry_json, source_hash, status, created_at) VALUES(?, ?, 'old-game', '1.0.0', ?, '12345678', 'active', 1)`, "rel_old", submission.ID, entryJSON); err != nil {
		t.Fatal(err)
	}
	if err := app.rebuildRegistry(ctx); err != nil {
		t.Fatal(err)
	}
	registry, err := app.store.Get(ctx, "registry.json", 128*1024)
	if err != nil {
		t.Fatal(err)
	}
	var document registryDocument
	if err := json.Unmarshal(registry, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Games) != 1 || document.Games[0].AuthorName != "Posted Author" {
		t.Fatalf("expected backfilled author, got %#v", document.Games)
	}
}

func TestZipCompletionRejectsInvalidArchive(t *testing.T) {
	config := testConfig(t.TempDir())
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	submission, err := app.createSubmission(ctx, author, "Author", "Bad ZIP", "", "zip", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := app.store.Put(ctx, submission.ZipKey, []byte("not a zip"), "application/zip"); err != nil {
		t.Fatal(err)
	}
	if _, err := app.completeZipSubmission(ctx, submission); err == nil {
		t.Fatal("invalid archive was accepted")
	}
	stored, err := app.submissionByID(ctx, submission.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "draft" {
		t.Fatalf("submission status = %q, want draft", stored.Status)
	}
}

func TestGitURLAndAllowedOriginValidation(t *testing.T) {
	valid := []string{
		"https://github.com/example/game",
		"https://gitlab.com/group/subgroup/game",
	}
	for _, raw := range valid {
		if _, err := validateGitURL(raw); err != nil {
			t.Fatalf("valid Git URL %q rejected: %v", raw, err)
		}
	}
	invalid := []string{
		"http://github.com/example/game",
		"https://github.com/example/game/issues",
		"https://github.com/example/game?ref=main",
		"https://gitlab.com/example/game#readme",
		"https://github.com@example.com/example/game",
	}
	for _, raw := range invalid {
		if _, err := validateGitURL(raw); err == nil {
			t.Fatalf("invalid Git URL %q accepted", raw)
		}
	}
	if _, err := normalizeAllowedOrigins([]any{"https://api.example.com/path"}); err == nil {
		t.Fatal("allowed origin with a path was accepted")
	}
	if _, err := normalizeAllowedOrigins([]any{"https://api.example.com?token=secret"}); err == nil {
		t.Fatal("allowed origin with a query was accepted")
	}
}

func TestImportRejectsShortHash(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"schemaVersion":2,"games":[{"id":"old-game","version":"1.0.0","path":"games/old-game/index.html","packageSha256":"short"}]}`))
	}))
	defer server.Close()
	config := testConfig(t.TempDir())
	config.ExistingRegistryURL = server.URL
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	if _, err := app.importExistingRegistry(context.Background()); err == nil {
		t.Fatal("short package hash was accepted")
	}
}

func TestImportRebuildsRegistryAndIsRepeatable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"schemaVersion":2,"games":[{"id":"old-game","title":"Old Game","version":"1.0.0","path":"games/old-game/index.html","packageUrl":"packages/old-game.zip","packageSha256":"12345678"}]}`))
	}))
	defer server.Close()
	config := testConfig(t.TempDir())
	config.ExistingRegistryURL = server.URL
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	ctx := context.Background()
	for attempt := 0; attempt < 2; attempt++ {
		count, err := app.importExistingRegistry(ctx)
		if err != nil || count != 1 {
			t.Fatalf("import attempt %d: count=%d err=%v", attempt, count, err)
		}
	}
	entries, err := app.activeEntries(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].ID != "old-game" {
		t.Fatalf("unexpected active entries: %#v", entries)
	}
	registry, err := app.store.Get(ctx, "registry.json", 128*1024)
	if err != nil {
		t.Fatal(err)
	}
	var document registryDocument
	if err := json.Unmarshal(registry, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Games) != 1 || document.Games[0].ID != "old-game" {
		t.Fatalf("unexpected imported registry: %#v", document)
	}
}

func TestMobileIdentityAuthenticatesPlatformRequests(t *testing.T) {
	mobile := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/me" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Header.Get("Authorization") {
		case "Bearer author-token":
			_, _ = w.Write([]byte(`{"user":{"id":"mobile-author","email":"author@example.com","provider":"email","isAdmin":false}}`))
		case "Bearer admin-token":
			_, _ = w.Write([]byte(`{"user":{"id":"mobile-admin","email":"admin@example.com","provider":"email","isAdmin":true}}`))
		case "Bearer anonymous-token":
			_, _ = w.Write([]byte(`{"user":{"id":"anonymous-user","email":null,"provider":"anonymous","isAdmin":false}}`))
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer mobile.Close()

	config := testConfig(t.TempDir())
	config.IdentityAPIBaseURL = mobile.URL
	config.PublicSiteOrigins = []string{"http://127.0.0.1:3000"}
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()

	server := app.routes()
	request := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	request.Header.Set("Authorization", "Bearer author-token")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("author status = %d, body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("Set-Cookie") != "" {
		t.Fatal("platform must not issue a local session cookie")
	}
	var payload struct {
		User User `json:"user"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.User.ID != "mobile-author" || payload.User.Role != "author" {
		t.Fatalf("unexpected identity: %#v", payload.User)
	}

	for _, token := range []string{"anonymous-token", "revoked-token"} {
		request = httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response = httptest.NewRecorder()
		server.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("token %q status = %d, want 401", token, response.Code)
		}
	}

	request = httptest.NewRequest(http.MethodGet, "/api/admin/submissions", nil)
	request.Header.Set("Authorization", "Bearer admin-token")
	response = httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("admin status = %d, body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodOptions, "/api/submissions", nil)
	request.Header.Set("Origin", "http://127.0.0.1:3000")
	response = httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || response.Header().Get("Access-Control-Allow-Headers") != "Content-Type, Authorization" {
		t.Fatalf("unexpected CORS preflight: status=%d headers=%q", response.Code, response.Header().Get("Access-Control-Allow-Headers"))
	}
}

func TestLegacyPlatformAccountsMigrateWithoutPasswordHashes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "game-platform.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	legacy := []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'author', created_at INTEGER NOT NULL)`,
		`CREATE TABLE submissions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, git_url TEXT NOT NULL DEFAULT '', zip_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, review_note TEXT NOT NULL DEFAULT '', reviewed_by INTEGER REFERENCES users(id), release_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
		`CREATE TABLE releases (id TEXT PRIMARY KEY, submission_id TEXT REFERENCES submissions(id), game_id TEXT NOT NULL, version TEXT NOT NULL, entry_json TEXT NOT NULL, source_hash TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)`,
		`INSERT INTO users(id, email, display_name, password_hash, role, created_at) VALUES(1, 'author@example.com', 'Legacy Author', 'pbkdf2-removed', 'author', 1)`,
		`INSERT INTO submissions(id, user_id, title, description, kind, status, created_at, updated_at) VALUES('sub_legacy', 1, 'Legacy Game', '', 'git', 'pending', 1, 1)`,
	}
	for _, statement := range legacy {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	app, err := newApp(testConfig(dir))
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()

	var legacyTables int
	if err := app.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'users'`).Scan(&legacyTables); err != nil {
		t.Fatal(err)
	}
	if legacyTables != 0 {
		t.Fatal("legacy users table and password hashes were retained")
	}
	submission, err := app.submissionByID(context.Background(), "sub_legacy")
	if err != nil {
		t.Fatal(err)
	}
	if submission.UserID != "legacy:1" || submission.AuthorName != "Legacy Author" {
		t.Fatalf("legacy submission was not preserved: %#v", submission)
	}
	if err := app.syncIdentity(context.Background(), User{ID: "mobile-author", Email: "author@example.com", Role: "author"}); err != nil {
		t.Fatal(err)
	}
	submission, err = app.submissionByID(context.Background(), "sub_legacy")
	if err != nil {
		t.Fatal(err)
	}
	if submission.UserID != "mobile-author" {
		t.Fatalf("legacy submission owner = %q, want mobile-author", submission.UserID)
	}
}

// TestMigrateDropsLegacyPayoutReportsTable 旧结构的 payout_reports（有 status /
// generated_at、主键 (month, game_id)）从未上线生产，迁移时应直接删掉重建，
// 且不影响其他数据。
func TestMigrateDropsLegacyPayoutReportsTable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "game-platform.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	legacy := []string{
		`CREATE TABLE payout_reports (
			month TEXT NOT NULL,
			game_id TEXT NOT NULL,
			author_id TEXT NOT NULL DEFAULT '',
			author_name TEXT NOT NULL DEFAULT '',
			valid_plays INTEGER NOT NULL DEFAULT 0,
			unique_devices INTEGER NOT NULL DEFAULT 0,
			total_minutes REAL NOT NULL DEFAULT 0,
			amount_cny INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL,
			paid_at INTEGER NOT NULL DEFAULT 0,
			paid_by TEXT NOT NULL DEFAULT '',
			note TEXT NOT NULL DEFAULT '',
			generated_at INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (month, game_id)
		)`,
		`INSERT INTO payout_reports(month, game_id, status) VALUES('2026-09', 'game-a', 'draft')`,
	}
	for _, statement := range legacy {
		if _, err := db.Exec(statement); err != nil {
			db.Close()
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	app, err := newApp(testConfig(dir))
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	var hasID, hasStatus int
	if err := app.db.QueryRow(`SELECT 1 FROM pragma_table_info('payout_reports') WHERE name = 'id'`).Scan(&hasID); err != nil {
		t.Fatalf("rebuilt payout_reports is missing the id column: %v", err)
	}
	err = app.db.QueryRow(`SELECT 1 FROM pragma_table_info('payout_reports') WHERE name = 'status'`).Scan(&hasStatus)
	if err == nil {
		t.Fatal("legacy status column survived the migration")
	}
	// 老行不会迁移过来，新表是空的。
	records, err := app.listPayoutRecords(context.Background(), "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 0 {
		t.Fatalf("legacy rows must not survive: %#v", records)
	}
}
