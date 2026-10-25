package main

import "encoding/json"

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Role  string `json:"role"`
}

type Submission struct {
	ID          string `json:"id"`
	UserID      string `json:"userId"`
	AuthorName  string `json:"authorName"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Kind        string `json:"kind"`
	GitURL      string `json:"gitUrl,omitempty"`
	ZipKey      string `json:"zipKey,omitempty"`
	Status      string `json:"status"`
	ReviewNote  string `json:"reviewNote,omitempty"`
	ReviewedBy  string `json:"reviewedBy,omitempty"`
	ReleaseID   string `json:"releaseId,omitempty"`
	// AuthorIsAdmin 记录投稿人身份，发布事务按它判断能否更新官方保留的 game_id。
	AuthorIsAdmin bool `json:"authorIsAdmin,omitempty"`
	// GameID / GameIDStatus 只在审核后台列表里填充，用于显示「新游戏 / 更新（原作者）/ ID 冲突」。
	GameID       string `json:"gameId,omitempty"`
	GameIDStatus string `json:"gameIdStatus,omitempty"`
	CreatedAt    int64  `json:"createdAt"`
	UpdatedAt    int64  `json:"updatedAt"`
}

type RegistryFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type RegistryEntry struct {
	ID             string         `json:"id"`
	Title          string         `json:"title"`
	Description    string         `json:"description"`
	AuthorName     string         `json:"authorName,omitempty"`
	Version        string         `json:"version"`
	Source         string         `json:"source"`
	Devices        []any          `json:"devices"`
	Params         []any          `json:"params"`
	Permissions    []any          `json:"permissions"`
	AllowedOrigins []string       `json:"allowedOrigins"`
	Manifest       map[string]any `json:"manifest"`
	Path           string         `json:"path"`
	SHA256         string         `json:"sha256"`
	Size           int64          `json:"size"`
	FileCount      int            `json:"fileCount"`
	Files          []RegistryFile `json:"files"`
	PackageURL     string         `json:"packageUrl"`
	PackageSHA256  string         `json:"packageSha256"`
	PackageSize    int64          `json:"packageSize"`
	Cacheable      bool           `json:"cacheable"`
}

type Release struct {
	ID        string          `json:"id"`
	GameID    string          `json:"gameId"`
	Version   string          `json:"version"`
	EntryJSON json.RawMessage `json:"entryJson"`
	Status    string          `json:"status"`
	CreatedAt int64           `json:"createdAt"`
}
