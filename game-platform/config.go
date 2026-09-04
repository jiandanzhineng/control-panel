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
	AuthSecret          string
	AdminEmails         map[string]bool
	CookieSecure        bool
	MaxUploadBytes      int64
	MaxUnpackedBytes    int64
	MaxArchiveFiles     int
	UploadExpiry        time.Duration
	GitTimeout          time.Duration
	OSS                 OSSConfig
	ExistingRegistryURL string
	SubmissionPrefix    string
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
		PublicSiteOrigins:   csv(envOr("GAME_PLATFORM_PUBLIC_SITE_ORIGINS", "http://127.0.0.1:3000,http://localhost:3000")),
		AuthSecret:          os.Getenv("GAME_PLATFORM_AUTH_SECRET"),
		AdminEmails:         make(map[string]bool),
		CookieSecure:        envBool("GAME_PLATFORM_COOKIE_SECURE", false),
		MaxUploadBytes:      envInt64("GAME_PLATFORM_MAX_UPLOAD_BYTES", 20*1024*1024),
		MaxUnpackedBytes:    envInt64("GAME_PLATFORM_MAX_UNPACKED_BYTES", 80*1024*1024),
		MaxArchiveFiles:     int(envInt64("GAME_PLATFORM_MAX_ARCHIVE_FILES", 200)),
		UploadExpiry:        time.Duration(envInt64("GAME_PLATFORM_UPLOAD_EXPIRY_MINUTES", 15)) * time.Minute,
		GitTimeout:          time.Duration(envInt64("GAME_PLATFORM_GIT_TIMEOUT_SECONDS", 45)) * time.Second,
		ExistingRegistryURL: strings.TrimSpace(os.Getenv("GAME_PLATFORM_EXISTING_REGISTRY_URL")),
		SubmissionPrefix:    strings.Trim(strings.TrimSpace(envOr("GAME_PLATFORM_SUBMISSION_PREFIX", "submissions")), "/"),
		OSS: OSSConfig{
			Endpoint:         strings.TrimSpace(os.Getenv("OSS_ENDPOINT")),
			Bucket:           strings.TrimSpace(os.Getenv("OSS_BUCKET")),
			SubmissionBucket: strings.TrimSpace(os.Getenv("OSS_SUBMISSION_BUCKET")),
			AccessKeyID:      strings.TrimSpace(os.Getenv("OSS_ACCESS_KEY_ID")),
			AccessKeySecret:  strings.TrimSpace(os.Getenv("OSS_ACCESS_KEY_SECRET")),
		},
	}
	for _, email := range csv(os.Getenv("GAME_PLATFORM_ADMIN_EMAILS")) {
		c.AdminEmails[strings.ToLower(email)] = true
	}
	if c.AuthSecret == "" {
		if c.Environment == "production" {
			return Config{}, fmt.Errorf("GAME_PLATFORM_AUTH_SECRET is required in production")
		}
		c.AuthSecret = "development-only-change-me"
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
	return c, nil
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

func envBool(name string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func csv(value string) []string {
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
