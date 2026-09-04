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
	if entry.ID != "test-game" || entry.PackageURL == "" || entry.Path == "" {
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
	if document.SchemaVersion != 2 || len(document.Games) != 1 || document.Games[0].ID != entry.ID {
		t.Fatalf("unexpected registry: %#v", document)
	}
	if _, err := app.store.Get(ctx, entry.Path, 128*1024); err != nil {
		t.Fatalf("published index is missing: %v", err)
	}
	if _, err := app.store.Get(ctx, entry.PackageURL, 128*1024); err != nil {
		t.Fatalf("published package is missing: %v", err)
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
