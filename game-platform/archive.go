package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	manifestPattern = regexp.MustCompile(`(?is)<script[^>]*\bid\s*=\s*["']game-manifest["'][^>]*>(.*?)</script>`)
	gameIDPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)
	semverPattern   = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
	resourcePattern = regexp.MustCompile(`(?is)\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'=]+))`)
)

type archiveFile struct {
	Path string
	Body []byte
}

type preparedGame struct {
	Manifest       map[string]any
	ID             string
	Title          string
	Description    string
	Version        string
	Devices        []any
	Params         []any
	Permissions    []any
	AllowedOrigins []string
	Files          []archiveFile
	RegistryFiles  []RegistryFile
	DirectoryHash  string
	TotalSize      int64
	Package        []byte
	PackageHash    string
}

func prepareGameArchive(source []byte, config Config) (*preparedGame, error) {
	if int64(len(source)) == 0 || int64(len(source)) > config.MaxUploadBytes {
		return nil, fmt.Errorf("archive exceeds maximum upload size")
	}
	reader, err := zip.NewReader(bytes.NewReader(source), int64(len(source)))
	if err != nil {
		return nil, fmt.Errorf("invalid zip archive: %w", err)
	}
	if len(reader.File) == 0 || len(reader.File) > config.MaxArchiveFiles {
		return nil, fmt.Errorf("archive file count is invalid")
	}
	game := &preparedGame{}
	seen := make(map[string]bool)
	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		name, err := safeArchivePath(file.Name)
		if err != nil {
			return nil, err
		}
		if seen[name] {
			return nil, fmt.Errorf("archive contains duplicate file %q", name)
		}
		seen[name] = true
		if file.Mode()&0o170000 == 0o120000 {
			return nil, fmt.Errorf("archive contains symbolic link %q", name)
		}
		if file.UncompressedSize64 > uint64(config.MaxUnpackedBytes) || game.TotalSize+int64(file.UncompressedSize64) > config.MaxUnpackedBytes {
			return nil, fmt.Errorf("archive uncompressed size exceeds maximum")
		}
		stream, err := file.Open()
		if err != nil {
			return nil, err
		}
		body, readErr := io.ReadAll(io.LimitReader(stream, int64(file.UncompressedSize64)+1))
		stream.Close()
		if readErr != nil {
			return nil, readErr
		}
		if uint64(len(body)) != file.UncompressedSize64 {
			return nil, fmt.Errorf("archive entry size mismatch for %q", name)
		}
		game.Files = append(game.Files, archiveFile{Path: name, Body: body})
		game.TotalSize += int64(len(body))
	}
	if len(game.Files) == 0 || len(game.Files) > config.MaxArchiveFiles {
		return nil, fmt.Errorf("archive contains no files")
	}
	sort.Slice(game.Files, func(i, j int) bool { return game.Files[i].Path < game.Files[j].Path })
	indexHTML := fileBody(game.Files, "index.html")
	if indexHTML == nil {
		return nil, fmt.Errorf("archive root must contain index.html")
	}
	manifest, err := extractManifest(indexHTML)
	if err != nil {
		return nil, err
	}
	game.Manifest = manifest
	if game.ID, _ = manifest["id"].(string); !gameIDPattern.MatchString(game.ID) {
		return nil, fmt.Errorf("manifest id must be 2-63 lowercase letters, digits or hyphens")
	}
	if game.Version, _ = manifest["version"].(string); !semverPattern.MatchString(game.Version) {
		return nil, fmt.Errorf("manifest version is not valid semver")
	}
	game.Title, _ = manifest["title"].(string)
	if strings.TrimSpace(game.Title) == "" {
		game.Title = game.ID
		manifest["title"] = game.Title
	}
	game.Description, _ = manifest["description"].(string)
	game.Devices = anySlice(manifest["devices"])
	game.Params = anySlice(manifest["params"])
	game.Permissions = anySlice(manifest["permissions"])
	game.AllowedOrigins, err = normalizeAllowedOrigins(manifest["allowedOrigins"])
	if err != nil {
		return nil, err
	}
	manifest["devices"] = game.Devices
	manifest["params"] = game.Params
	manifest["permissions"] = game.Permissions
	manifest["allowedOrigins"] = game.AllowedOrigins
	if err := validateHTMLResources(indexHTML, game.AllowedOrigins); err != nil {
		return nil, err
	}
	parts := make([]string, 0, len(game.Files))
	for _, file := range game.Files {
		hash := sha256Hex(file.Body)
		game.RegistryFiles = append(game.RegistryFiles, RegistryFile{Path: file.Path, SHA256: hash, Size: int64(len(file.Body))})
		parts = append(parts, file.Path+":"+hash)
	}
	game.DirectoryHash = sha256Hex([]byte(strings.Join(parts, "\n")))
	game.Package, err = writeDeterministicZip(game.Files)
	if err != nil {
		return nil, err
	}
	game.PackageHash = sha256Hex(game.Package)
	return game, nil
}

func safeArchivePath(name string) (string, error) {
	name = strings.ReplaceAll(name, "\\", "/")
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "\x00") {
		return "", fmt.Errorf("unsafe archive path")
	}
	clean := path.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || clean != name {
		return "", fmt.Errorf("unsafe archive path %q", name)
	}
	return clean, nil
}

func fileBody(files []archiveFile, target string) []byte {
	for _, file := range files {
		if file.Path == target {
			return file.Body
		}
	}
	return nil
}

func extractManifest(html []byte) (map[string]any, error) {
	match := manifestPattern.FindSubmatch(html)
	if len(match) != 2 {
		return nil, fmt.Errorf("index.html is missing game-manifest")
	}
	var manifest map[string]any
	if err := json.Unmarshal(match[1], &manifest); err != nil {
		return nil, fmt.Errorf("game-manifest is invalid JSON: %w", err)
	}
	return manifest, nil
}

func anySlice(value any) []any {
	if list, ok := value.([]any); ok {
		return list
	}
	return []any{}
}

func normalizeAllowedOrigins(value any) ([]string, error) {
	if value == nil {
		return []string{}, nil
	}
	list, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("manifest allowedOrigins must be an array")
	}
	seen := make(map[string]bool)
	out := make([]string, 0, len(list))
	for _, item := range list {
		raw, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("manifest allowedOrigins entries must be strings")
		}
		parsed, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.Path != "" && parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
			return nil, fmt.Errorf("manifest allowedOrigins contains invalid origin")
		}
		origin := parsed.Scheme + "://" + parsed.Host
		if !seen[origin] {
			seen[origin] = true
			out = append(out, origin)
		}
	}
	sort.Strings(out)
	return out, nil
}

func validateHTMLResources(html []byte, allowedOrigins []string) error {
	allowed := make(map[string]bool, len(allowedOrigins))
	for _, origin := range allowedOrigins {
		allowed[origin] = true
	}
	for _, match := range resourcePattern.FindAllSubmatch(html, -1) {
		ref := ""
		for _, candidate := range match[1:] {
			if len(candidate) > 0 {
				ref = strings.TrimSpace(string(candidate))
				break
			}
		}
		if ref == "" || strings.HasPrefix(ref, "#") || strings.HasPrefix(ref, "data:") || strings.HasPrefix(ref, "blob:") || strings.HasPrefix(ref, "mailto:") {
			continue
		}
		if strings.HasPrefix(ref, "/bridge-api/") {
			continue
		}
		if strings.HasPrefix(ref, "/") {
			return fmt.Errorf("root-absolute resource %q is not allowed", ref)
		}
		if strings.HasPrefix(ref, "//") {
			ref = "https:" + ref
		}
		if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") {
			parsed, err := url.Parse(ref)
			if err != nil || !allowed[parsed.Scheme+"://"+parsed.Host] {
				return fmt.Errorf("external resource %q is not declared in allowedOrigins", ref)
			}
		}
	}
	return nil
}

func writeDeterministicZip(files []archiveFile) ([]byte, error) {
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	modified := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, file := range files {
		header := &zip.FileHeader{Name: file.Path, Method: zip.Deflate, Modified: modified}
		header.SetMode(0o644)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			return nil, err
		}
		if _, err := entry.Write(file.Body); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func sha256Hex(body []byte) string {
	hash := sha256.Sum256(body)
	return hex.EncodeToString(hash[:])
}
