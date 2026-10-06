package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Environment         string
	ListenAddr          string
	DatabasePath        string
	StorageDriver       string
	LocalStorageDir     string
	PublicSiteOrigins   []string
	IdentityAPIBaseURL  string
	IdentityTimeout     time.Duration
	MaxUploadBytes      int64
	MaxUnpackedBytes    int64
	MaxArchiveFiles     int
	UploadExpiry        time.Duration
	GitTimeout          time.Duration
	OSS                 OSSConfig
	ExistingRegistryURL string
	SubmissionPrefix    string
	Payout              PayoutConfig
}

// PayoutConfig 是创作者月度分成的全部可调参数。奖金池与门槛留到正式发钱时
// 再定，这里只给占位默认值；生成报表时请求体可以逐项覆盖。
type PayoutConfig struct {
	Timezone         string
	BonusPoolCNY     int64
	MinDurationMS    int64
	MinDeviceCount   int
	MinValidPlays    int
	ExcludedMACs     []string
	ExcludedProfiles []string
	OpenPanel        OpenPanelConfig
}

// OpenPanelConfig 描述自建 OpenPanel 的读取端点与多组 read client。
type OpenPanelConfig struct {
	BaseURL string
	Clients []OpenPanelClientConfig
}

// OpenPanelClientConfig 一组 read client；Secret 只能来自环境变量。
type OpenPanelClientConfig struct {
	Name         string
	ProjectID    string
	ClientID     string
	ClientSecret string
	Events       []string
}

func (c OpenPanelConfig) configured() bool {
	for _, client := range c.Clients {
		if client.ClientSecret != "" && client.ProjectID != "" && client.ClientID != "" {
			return true
		}
	}
	return false
}

type OSSConfig struct {
	Endpoint         string
	Bucket           string
	SubmissionBucket string
	AccessKeyID      string
	AccessKeySecret  string
}

func loadConfig() (Config, error) {
	c := Config{
		Environment:         envOr("GAME_PLATFORM_ENV", "development"),
		ListenAddr:          envOr("GAME_PLATFORM_LISTEN_ADDR", ":8787"),
		DatabasePath:        envOr("GAME_PLATFORM_DATABASE_PATH", "./data/game-platform.db"),
		StorageDriver:       strings.ToLower(envOr("GAME_PLATFORM_STORAGE_DRIVER", "filesystem")),
		LocalStorageDir:     envOr("GAME_PLATFORM_LOCAL_STORAGE_DIR", "./data/objects"),
		PublicSiteOrigins:   csvList(envOr("GAME_PLATFORM_PUBLIC_SITE_ORIGINS", "http://127.0.0.1:3000,http://localhost:3000")),
		IdentityAPIBaseURL:  strings.TrimRight(strings.TrimSpace(envOr("GAME_PLATFORM_IDENTITY_API_BASE_URL", "http://127.0.0.1:3000")), "/"),
		IdentityTimeout:     time.Duration(envInt64("GAME_PLATFORM_IDENTITY_TIMEOUT_SECONDS", 10)) * time.Second,
		MaxUploadBytes:      envInt64("GAME_PLATFORM_MAX_UPLOAD_BYTES", 20*1024*1024),
		MaxUnpackedBytes:    envInt64("GAME_PLATFORM_MAX_UNPACKED_BYTES", 80*1024*1024),
		MaxArchiveFiles:     int(envInt64("GAME_PLATFORM_MAX_ARCHIVE_FILES", 200)),
		UploadExpiry:        time.Duration(envInt64("GAME_PLATFORM_UPLOAD_EXPIRY_MINUTES", 15)) * time.Minute,
		GitTimeout:          time.Duration(envInt64("GAME_PLATFORM_GIT_TIMEOUT_SECONDS", 45)) * time.Second,
		ExistingRegistryURL: strings.TrimSpace(os.Getenv("GAME_PLATFORM_EXISTING_REGISTRY_URL")),
		SubmissionPrefix:    strings.Trim(strings.TrimSpace(envOr("GAME_PLATFORM_SUBMISSION_PREFIX", "submissions")), "/"),
		Payout: PayoutConfig{
			Timezone:         envOr("GAME_PLATFORM_PAYOUT_TIMEZONE", "Asia/Shanghai"),
			BonusPoolCNY:     envInt64("GAME_PLATFORM_PAYOUT_BONUS_POOL_CNY", 0),
			MinDurationMS:    envInt64("GAME_PLATFORM_PAYOUT_MIN_DURATION_MS", 5*60*1000),
			MinDeviceCount:   int(envInt64("GAME_PLATFORM_PAYOUT_MIN_DEVICE_COUNT", 1)),
			MinValidPlays:    int(envInt64("GAME_PLATFORM_PAYOUT_MIN_VALID_PLAYS", 20)),
			ExcludedMACs:     csvList(os.Getenv("GAME_PLATFORM_PAYOUT_EXCLUDED_MACS")),
			ExcludedProfiles: csvList(os.Getenv("GAME_PLATFORM_PAYOUT_EXCLUDED_PROFILES")),
			OpenPanel:        loadOpenPanelConfig(),
		},
		OSS: OSSConfig{
			Endpoint:         strings.TrimSpace(os.Getenv("OSS_ENDPOINT")),
			Bucket:           strings.TrimSpace(os.Getenv("OSS_BUCKET")),
			SubmissionBucket: strings.TrimSpace(os.Getenv("OSS_SUBMISSION_BUCKET")),
			AccessKeyID:      strings.TrimSpace(os.Getenv("OSS_ACCESS_KEY_ID")),
			AccessKeySecret:  strings.TrimSpace(os.Getenv("OSS_ACCESS_KEY_SECRET")),
		},
	}
	if c.IdentityAPIBaseURL == "" || c.IdentityTimeout <= 0 {
		return Config{}, fmt.Errorf("GAME_PLATFORM_IDENTITY_API_BASE_URL and GAME_PLATFORM_IDENTITY_TIMEOUT_SECONDS must be valid")
	}
	if c.MaxUploadBytes <= 0 || c.MaxUnpackedBytes < c.MaxUploadBytes || c.MaxArchiveFiles <= 0 {
		return Config{}, fmt.Errorf("invalid archive limits")
	}
	if c.StorageDriver != "filesystem" && c.StorageDriver != "oss" {
		return Config{}, fmt.Errorf("GAME_PLATFORM_STORAGE_DRIVER must be filesystem or oss")
	}
	if c.StorageDriver == "oss" {
		if c.OSS.Endpoint == "" || c.OSS.Bucket == "" || c.OSS.AccessKeyID == "" || c.OSS.AccessKeySecret == "" {
			return Config{}, fmt.Errorf("OSS_ENDPOINT, OSS_BUCKET, OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET are required for oss storage")
		}
		if c.OSS.SubmissionBucket == "" {
			if c.Environment == "production" {
				return Config{}, fmt.Errorf("OSS_SUBMISSION_BUCKET is required in production")
			}
			c.OSS.SubmissionBucket = c.OSS.Bucket
		}
		if c.Environment == "production" && c.OSS.SubmissionBucket == c.OSS.Bucket {
			return Config{}, fmt.Errorf("OSS_SUBMISSION_BUCKET must differ from OSS_BUCKET in production")
		}
	}
	if c.SubmissionPrefix == "" {
		return Config{}, fmt.Errorf("GAME_PLATFORM_SUBMISSION_PREFIX cannot be empty")
	}
	if _, err := time.LoadLocation(c.Payout.Timezone); err != nil {
		return Config{}, fmt.Errorf("GAME_PLATFORM_PAYOUT_TIMEZONE must be a valid IANA time zone")
	}
	if c.Payout.MinDurationMS < 0 || c.Payout.MinDeviceCount < 0 || c.Payout.MinValidPlays < 0 {
		return Config{}, fmt.Errorf("payout thresholds cannot be negative")
	}
	return c, nil
}

// loadOpenPanelConfig 读取 OpenPanel 地址与多组 read client。
// Secret 只允许来自环境变量（GAME_PLATFORM_OPENPANEL_<NAME>_CLIENT_SECRET）。
func loadOpenPanelConfig() OpenPanelConfig {
	config := OpenPanelConfig{
		BaseURL: strings.TrimRight(strings.TrimSpace(envOr("GAME_PLATFORM_OPENPANEL_API_URL", "https://op.shiroha.tech/api")), "/"),
	}
	defaults := []OpenPanelClientConfig{
		{Name: "pc", ProjectID: "", ClientID: "", Events: []string{"game_stop"}},
		{Name: "mobile", ProjectID: "", ClientID: "", Events: []string{"game_exit"}},
	}
	for _, client := range defaults {
		prefix := "GAME_PLATFORM_OPENPANEL_" + strings.ToUpper(client.Name) + "_"
		client.ProjectID = envOr(prefix+"PROJECT_ID", client.ProjectID)
		client.ClientID = envOr(prefix+"CLIENT_ID", client.ClientID)
		client.ClientSecret = strings.TrimSpace(os.Getenv(prefix + "CLIENT_SECRET"))
		if events := csvList(os.Getenv(prefix + "EVENTS")); len(events) > 0 {
			client.Events = events
		}
		config.Clients = append(config.Clients, client)
	}
	return config
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envInt64(name string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func csvList(value string) []string {
	items := strings.Split(value, ",")
	out := make([]string, 0, len(items))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item != "" {
			out = append(out, item)
		}
	}
	return out
}

func ensureParentDir(filePath string) error {
	dir := filepath.Dir(filePath)
	if dir == "." || dir == "" {
		return nil
	}
	return os.MkdirAll(dir, 0o750)
}
