package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

type ObjectMeta struct {
	Size int64
}

type UploadInstruction struct {
	Mode   string            `json:"mode"`
	Action string            `json:"action,omitempty"`
	Fields map[string]string `json:"fields,omitempty"`
}

type ObjectStore interface {
	DirectUpload(key string, maxBytes int64, expiresAt time.Time) (UploadInstruction, error)
	Head(ctx context.Context, key string) (ObjectMeta, error)
	Get(ctx context.Context, key string, maxBytes int64) ([]byte, error)
	Put(ctx context.Context, key string, body []byte, contentType string) error
}

func newObjectStore(config Config) (ObjectStore, error) {
	if config.StorageDriver == "filesystem" {
		if err := os.MkdirAll(config.LocalStorageDir, 0o750); err != nil {
			return nil, err
		}
		return &fileStore{root: config.LocalStorageDir}, nil
	}
	publicStore, err := newOSSStore(config.OSS, config.OSS.Bucket)
	if err != nil {
		return nil, err
	}
	submissionStore, err := newOSSStore(config.OSS, config.OSS.SubmissionBucket)
	if err != nil {
		return nil, err
	}
	return &routedStore{public: publicStore, submissions: submissionStore, submissionPrefix: config.SubmissionPrefix + "/"}, nil
}

type routedStore struct {
	public           *ossStore
	submissions      *ossStore
	submissionPrefix string
}

func (s *routedStore) forKey(key string) *ossStore {
	if strings.HasPrefix(key, s.submissionPrefix) {
		return s.submissions
	}
	return s.public
}

func (s *routedStore) DirectUpload(key string, maxBytes int64, expiresAt time.Time) (UploadInstruction, error) {
	return s.forKey(key).DirectUpload(key, maxBytes, expiresAt)
}

func (s *routedStore) Head(ctx context.Context, key string) (ObjectMeta, error) {
	return s.forKey(key).Head(ctx, key)
}

func (s *routedStore) Get(ctx context.Context, key string, maxBytes int64) ([]byte, error) {
	return s.forKey(key).Get(ctx, key, maxBytes)
}

func (s *routedStore) Put(ctx context.Context, key string, body []byte, contentType string) error {
	return s.forKey(key).Put(ctx, key, body, contentType)
}

type fileStore struct{ root string }

func (s *fileStore) objectPath(key string) (string, error) {
	clean := path.Clean("/" + strings.ReplaceAll(key, "\\", "/"))
	if clean == "/" || strings.Contains(clean, "..") {
		return "", errors.New("unsafe object key")
	}
	full := filepath.Join(s.root, filepath.FromSlash(strings.TrimPrefix(clean, "/")))
	root := filepath.Clean(s.root)
	if full != root && !strings.HasPrefix(full, root+string(os.PathSeparator)) {
		return "", errors.New("unsafe object key")
	}
	return full, nil
}

func (s *fileStore) DirectUpload(string, int64, time.Time) (UploadInstruction, error) {
	return UploadInstruction{Mode: "local"}, nil
}

func (s *fileStore) Head(_ context.Context, key string) (ObjectMeta, error) {
	filePath, err := s.objectPath(key)
	if err != nil {
		return ObjectMeta{}, err
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return ObjectMeta{}, err
	}
	return ObjectMeta{Size: info.Size()}, nil
}

func (s *fileStore) Get(_ context.Context, key string, maxBytes int64) ([]byte, error) {
	meta, err := s.Head(context.Background(), key)
	if err != nil {
		return nil, err
	}
	if maxBytes > 0 && meta.Size > maxBytes {
		return nil, fmt.Errorf("object exceeds maximum size")
	}
	filePath, err := s.objectPath(key)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(filePath)
}

func (s *fileStore) Put(_ context.Context, key string, body []byte, _ string) error {
	filePath, err := s.objectPath(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o750); err != nil {
		return err
	}
	return os.WriteFile(filePath, body, 0o640)
}

type ossStore struct {
	endpoint        *url.URL
	bucket          string
	accessKeyID     string
	accessKeySecret string
	client          *http.Client
}

func newOSSStore(config OSSConfig, bucket string) (*ossStore, error) {
	endpoint := config.Endpoint
	if !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("invalid OSS endpoint")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return nil, fmt.Errorf("OSS endpoint must use http(s)")
	}
	return &ossStore{
		endpoint:        parsed,
		bucket:          bucket,
		accessKeyID:     config.AccessKeyID,
		accessKeySecret: config.AccessKeySecret,
		client:          &http.Client{Timeout: 45 * time.Second},
	}, nil
}

func (s *ossStore) objectURL(key string) (string, error) {
	if strings.TrimSpace(key) == "" || strings.Contains(key, "..") || strings.HasPrefix(key, "/") {
		return "", errors.New("unsafe object key")
	}
	segments := strings.Split(key, "/")
	for index, segment := range segments {
		if segment == "" {
			return "", errors.New("unsafe object key")
		}
		segments[index] = url.PathEscape(segment)
	}
	endpoint := *s.endpoint
	endpoint.Host = s.bucket + "." + s.endpoint.Host
	endpoint.Path = "/" + strings.Join(segments, "/")
	endpoint.RawPath = endpoint.EscapedPath()
	return endpoint.String(), nil
}

func (s *ossStore) canonicalResource(key string) string {
	return "/" + s.bucket + "/" + key
}

func (s *ossStore) signedRequest(ctx context.Context, method, key, contentType string, body io.Reader) (*http.Request, error) {
	objectURL, err := s.objectURL(key)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, objectURL, body)
	if err != nil {
		return nil, err
	}
	date := time.Now().UTC().Format(http.TimeFormat)
	req.Header.Set("Date", date)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	stringToSign := strings.Join([]string{method, "", contentType, date, s.canonicalResource(key)}, "\n")
	mac := hmac.New(sha1.New, []byte(s.accessKeySecret))
	mac.Write([]byte(stringToSign))
	req.Header.Set("Authorization", "OSS "+s.accessKeyID+":"+base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	return req, nil
}

func (s *ossStore) execute(req *http.Request) (*http.Response, error) {
	response, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return response, nil
	}
	defer response.Body.Close()
	detail, _ := io.ReadAll(io.LimitReader(response.Body, 8*1024))
	return nil, fmt.Errorf("OSS %s %s failed: %s %s", req.Method, req.URL.Path, response.Status, strings.TrimSpace(string(detail)))
}

func (s *ossStore) DirectUpload(key string, maxBytes int64, expiresAt time.Time) (UploadInstruction, error) {
	if _, err := s.objectURL(key); err != nil {
		return UploadInstruction{}, err
	}
	policy := map[string]any{
		"expiration": expiresAt.UTC().Format("2006-01-02T15:04:05Z"),
		"conditions": []any{
			map[string]string{"bucket": s.bucket},
			[]any{"eq", "$key", key},
			[]any{"content-length-range", 1, maxBytes},
			map[string]string{"success_action_status": "204"},
		},
	}
	rawPolicy, err := json.Marshal(policy)
	if err != nil {
		return UploadInstruction{}, err
	}
	encodedPolicy := base64.StdEncoding.EncodeToString(rawPolicy)
	mac := hmac.New(sha1.New, []byte(s.accessKeySecret))
	mac.Write([]byte(encodedPolicy))
	endpoint := *s.endpoint
	endpoint.Host = s.bucket + "." + s.endpoint.Host
	endpoint.Path = "/"
	return UploadInstruction{
		Mode:   "oss-form",
		Action: endpoint.String(),
		Fields: map[string]string{
			"key":                   key,
			"policy":                encodedPolicy,
			"OSSAccessKeyId":        s.accessKeyID,
			"Signature":             base64.StdEncoding.EncodeToString(mac.Sum(nil)),
			"success_action_status": "204",
		},
	}, nil
}

func (s *ossStore) Head(ctx context.Context, key string) (ObjectMeta, error) {
	req, err := s.signedRequest(ctx, http.MethodHead, key, "", nil)
	if err != nil {
		return ObjectMeta{}, err
	}
	response, err := s.execute(req)
	if err != nil {
		return ObjectMeta{}, err
	}
	defer response.Body.Close()
	return ObjectMeta{Size: response.ContentLength}, nil
}

func (s *ossStore) Get(ctx context.Context, key string, maxBytes int64) ([]byte, error) {
	req, err := s.signedRequest(ctx, http.MethodGet, key, "", nil)
	if err != nil {
		return nil, err
	}
	response, err := s.execute(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if maxBytes > 0 && response.ContentLength > maxBytes {
		return nil, fmt.Errorf("object exceeds maximum size")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if maxBytes > 0 && int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("object exceeds maximum size")
	}
	return data, nil
}

func (s *ossStore) Put(ctx context.Context, key string, body []byte, contentType string) error {
	if contentType == "" {
		contentType = contentTypeFor(key)
	}
	req, err := s.signedRequest(ctx, http.MethodPut, key, contentType, bytes.NewReader(body))
	if err != nil {
		return err
	}
	response, err := s.execute(req)
	if err != nil {
		return err
	}
	response.Body.Close()
	return nil
}

func contentTypeFor(fileName string) string {
	if value := mime.TypeByExtension(strings.ToLower(filepath.Ext(fileName))); value != "" {
		return value
	}
	return "application/octet-stream"
}
