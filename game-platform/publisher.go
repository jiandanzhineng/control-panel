package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type registryDocument struct {
	SchemaVersion int             `json:"schemaVersion"`
	GeneratedAt   string          `json:"generatedAt"`
	Games         []RegistryEntry `json:"games"`
}

func validateGitURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Port() != "" {
		return nil, errors.New("Git address must be a public HTTPS GitHub or GitLab repository URL")
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "github.com" && host != "gitlab.com" {
		return nil, errors.New("Git address must use github.com or gitlab.com")
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" || strings.Contains(parsed.Path, "..") {
		return nil, errors.New("Git address must identify a public repository")
	}
	if host == "github.com" && len(parts) != 2 {
		return nil, errors.New("GitHub address must identify one public repository")
	}
	for _, part := range parts {
		if part == "." || part == ".." || strings.TrimSpace(part) == "" {
			return nil, errors.New("Git address must identify a public repository")
		}
	}
	return parsed, nil
}

func (a *App) publishSubmission(ctx context.Context, submission Submission, reviewer User) (RegistryEntry, error) {
	if reviewer.Role != "admin" {
		return RegistryEntry{}, errors.New("admin role required")
	}
	if submission.Status != "pending" {
		return RegistryEntry{}, errors.New("only pending submissions can be published")
	}
	a.publishMu.Lock()
	defer a.publishMu.Unlock()

	var source []byte
	var err error
	if submission.Kind == "zip" {
		source, err = a.store.Get(ctx, submission.ZipKey, a.config.MaxUploadBytes)
	} else {
		source, err = a.downloadGitArchive(ctx, submission.GitURL)
	}
	if err != nil {
		return RegistryEntry{}, err
	}
	game, err := prepareGameArchive(source, a.config)
	if err != nil {
		return RegistryEntry{}, err
	}
	hashPrefix := game.PackageHash[:8]
	gamePrefix := fmt.Sprintf("games/%s/%s-%s", game.ID, game.Version, hashPrefix)
	for _, file := range game.Files {
		if err := a.store.Put(ctx, gamePrefix+"/"+file.Path, file.Body, contentTypeFor(file.Path)); err != nil {
			return RegistryEntry{}, fmt.Errorf("publish game file: %w", err)
		}
	}
	packageKey := fmt.Sprintf("packages/%s-%s-%s.zip", game.ID, game.Version, hashPrefix)
	if err := a.store.Put(ctx, packageKey, game.Package, "application/zip"); err != nil {
		return RegistryEntry{}, fmt.Errorf("publish package: %w", err)
	}
	entry := RegistryEntry{
		ID:             game.ID,
		Title:          game.Title,
		Description:    game.Description,
		Version:        game.Version,
		Source:         "community",
		Devices:        game.Devices,
		Params:         game.Params,
		Permissions:    game.Permissions,
		AllowedOrigins: game.AllowedOrigins,
		Manifest:       game.Manifest,
		Path:           gamePrefix + "/index.html",
		SHA256:         game.DirectoryHash,
		Size:           game.TotalSize,
		FileCount:      len(game.RegistryFiles),
		Files:          game.RegistryFiles,
		PackageURL:     packageKey,
		PackageSHA256:  game.PackageHash,
		PackageSize:    int64(len(game.Package)),
		Cacheable:      true,
	}
	entryJSON, err := json.Marshal(entry)
	if err != nil {
		return RegistryEntry{}, err
	}
	releaseID, err := randomID("rel_")
	if err != nil {
		return RegistryEntry{}, err
	}
	transaction, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return RegistryEntry{}, err
	}
	defer transaction.Rollback()
	if _, err := transaction.ExecContext(ctx, `UPDATE releases SET status = 'superseded' WHERE game_id = ? AND status = 'active'`, entry.ID); err != nil {
		return RegistryEntry{}, err
	}
	if _, err := transaction.ExecContext(ctx, `INSERT INTO releases(id, submission_id, game_id, version, entry_json, source_hash, status, created_at) VALUES(?, ?, ?, ?, ?, ?, 'active', ?)`, releaseID, submission.ID, entry.ID, entry.Version, string(entryJSON), entry.PackageSHA256, nowUnix()); err != nil {
		return RegistryEntry{}, err
	}
	if _, err := transaction.ExecContext(ctx, `UPDATE submissions SET status = 'published', review_note = '', reviewed_by = ?, release_id = ?, updated_at = ? WHERE id = ?`, reviewer.ID, releaseID, nowUnix(), submission.ID); err != nil {
		return RegistryEntry{}, err
	}
	if err := transaction.Commit(); err != nil {
		return RegistryEntry{}, err
	}
	if err := a.rebuildRegistry(ctx); err != nil {
		return RegistryEntry{}, fmt.Errorf("release recorded but registry update failed: %w", err)
	}
	return entry, nil
}

func (a *App) downloadGitArchive(ctx context.Context, rawURL string) ([]byte, error) {
	parsed, err := validateGitURL(rawURL)
	if err != nil {
		return nil, err
	}
	cloneContext, cancel := context.WithTimeout(ctx, a.config.GitTimeout)
	defer cancel()
	tmpDir, err := os.MkdirTemp("", "game-platform-git-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpDir)
	repoDir := filepath.Join(tmpDir, "repo")
	clone := exec.CommandContext(cloneContext, "git", "-c", "protocol.file.allow=never", "clone", "--depth=1", "--no-tags", "--", parsed.String(), repoDir)
	clone.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1")
	if output, err := clone.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("could not read public Git repository: %s", strings.TrimSpace(string(output)))
	}
	archivePath := filepath.Join(tmpDir, "source.zip")
	archive := exec.CommandContext(cloneContext, "git", "-C", repoDir, "archive", "--format=zip", "-o", archivePath, "HEAD")
	archive.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	if output, err := archive.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("could not archive Git repository: %s", strings.TrimSpace(string(output)))
	}
	info, err := os.Stat(archivePath)
	if err != nil {
		return nil, err
	}
	if info.Size() <= 0 || info.Size() > a.config.MaxUploadBytes {
		return nil, errors.New("Git repository archive exceeds maximum size")
	}
	return os.ReadFile(archivePath)
}

func (a *App) rebuildRegistry(ctx context.Context) error {
	entries, err := a.activeEntries(ctx)
	if err != nil {
		return err
	}
	document := registryDocument{SchemaVersion: 2, GeneratedAt: time.Now().UTC().Format(time.RFC3339), Games: entries}
	body, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	return a.store.Put(ctx, "registry.json", body, "application/json; charset=utf-8")
}

func (a *App) activeEntries(ctx context.Context) ([]RegistryEntry, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT entry_json FROM releases WHERE status = 'active' ORDER BY game_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []RegistryEntry{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var entry RegistryEntry
		if err := json.Unmarshal([]byte(raw), &entry); err != nil {
			return nil, fmt.Errorf("stored registry entry is invalid: %w", err)
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].ID < entries[j].ID })
	return entries, nil
}

func (a *App) listActiveReleases(ctx context.Context) ([]Release, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT id, game_id, version, status, created_at FROM releases WHERE status = 'active' ORDER BY game_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	releases := []Release{}
	for rows.Next() {
		var release Release
		if err := rows.Scan(&release.ID, &release.GameID, &release.Version, &release.Status, &release.CreatedAt); err != nil {
			return nil, err
		}
		releases = append(releases, release)
	}
	return releases, rows.Err()
}

func (a *App) importExistingRegistry(ctx context.Context) (int, error) {
	a.publishMu.Lock()
	defer a.publishMu.Unlock()
	if a.config.ExistingRegistryURL == "" {
		return 0, errors.New("GAME_PLATFORM_EXISTING_REGISTRY_URL is not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.config.ExistingRegistryURL, nil)
	if err != nil {
		return 0, err
	}
	client := &http.Client{Timeout: 20 * time.Second}
	response, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("existing registry returned %s", response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 5*1024*1024+1))
	if err != nil || len(body) > 5*1024*1024 {
		return 0, errors.New("existing registry is too large")
	}
	var document registryDocument
	if err := json.Unmarshal(body, &document); err != nil || document.SchemaVersion < 1 {
		return 0, errors.New("existing registry is invalid")
	}
	transaction, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer transaction.Rollback()
	count := 0
	for _, entry := range document.Games {
		if entry.ID == "" || entry.Version == "" || entry.Path == "" || len(entry.PackageSHA256) < 8 {
			return 0, errors.New("existing registry contains invalid entry")
		}
		body, err := json.Marshal(entry)
		if err != nil {
			return 0, err
		}
		if _, err := transaction.ExecContext(ctx, `UPDATE releases SET status = 'superseded' WHERE game_id = ? AND status = 'active'`, entry.ID); err != nil {
			return 0, err
		}
		id := "import_" + entry.ID + "_" + entry.Version + "_" + entry.PackageSHA256[:8]
		_, err = transaction.ExecContext(ctx, `INSERT INTO releases(id, submission_id, game_id, version, entry_json, source_hash, status, created_at) VALUES(?, NULL, ?, ?, ?, ?, 'active', ?)
			ON CONFLICT(id) DO UPDATE SET game_id = excluded.game_id, version = excluded.version, entry_json = excluded.entry_json, source_hash = excluded.source_hash, status = 'active', created_at = excluded.created_at`, id, entry.ID, entry.Version, string(body), entry.PackageSHA256, nowUnix())
		if err != nil {
			return 0, err
		}
		count++
	}
	if err := transaction.Commit(); err != nil {
		return 0, err
	}
	if err := a.rebuildRegistry(ctx); err != nil {
		return 0, fmt.Errorf("registry update failed after import: %w", err)
	}
	return count, nil
}

func (a *App) revokeRelease(ctx context.Context, gameID string) error {
	a.publishMu.Lock()
	defer a.publishMu.Unlock()
	result, err := a.db.ExecContext(ctx, `UPDATE releases SET status = 'revoked' WHERE game_id = ? AND status = 'active'`, gameID)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed == 0 {
		return sql.ErrNoRows
	}
	return a.rebuildRegistry(ctx)
}
