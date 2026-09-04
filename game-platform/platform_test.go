package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func testConfig(dir string) Config {
	return Config{
		Environment:      "test",
		DatabasePath:     filepath.Join(dir, "game-platform.db"),
		StorageDriver:    "filesystem",
		LocalStorageDir:  filepath.Join(dir, "objects"),
		AuthSecret:       "test-secret",
		AdminEmails:      map[string]bool{"admin@example.com": true},
		MaxUploadBytes:   256 * 1024,
		MaxUnpackedBytes: 1024 * 1024,
		MaxArchiveFiles:  20,
		SubmissionPrefix: "submissions",
	}
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
	author, err := app.createUser(ctx, "author@example.com", "Author", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	admin, err := app.createUser(ctx, "admin@example.com", "Admin", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	submission, err := app.createSubmission(ctx, author, "Test Game", "description", "zip", "")
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
	author, err := app.createUser(ctx, "author@example.com", "Author", "correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	submission, err := app.createSubmission(ctx, author, "Bad ZIP", "", "zip", "")
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
