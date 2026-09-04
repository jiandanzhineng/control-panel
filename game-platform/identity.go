package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var errIdentityUnauthenticated = errors.New("mobile authentication is required")

type identityClient struct {
	meURL  string
	client *http.Client
}

func newIdentityClient(baseURL string, timeout time.Duration) (*identityClient, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("GAME_PLATFORM_IDENTITY_API_BASE_URL must be an HTTP(S) origin")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/me"
	return &identityClient{meURL: parsed.String(), client: &http.Client{Timeout: timeout}}, nil
}

func (c *identityClient) currentUser(ctx context.Context, authorization string) (User, error) {
	if !strings.HasPrefix(authorization, "Bearer ") || len(strings.TrimSpace(strings.TrimPrefix(authorization, "Bearer "))) == 0 {
		return User{}, errIdentityUnauthenticated
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.meURL, nil)
	if err != nil {
		return User{}, err
	}
	req.Header.Set("Authorization", authorization)
	resp, err := c.client.Do(req)
	if err != nil {
		return User{}, fmt.Errorf("mobile identity service request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return User{}, errIdentityUnauthenticated
	}
	if resp.StatusCode != http.StatusOK {
		return User{}, fmt.Errorf("mobile identity service returned HTTP %d", resp.StatusCode)
	}
	var payload struct {
		User struct {
			ID       string  `json:"id"`
			Email    *string `json:"email"`
			Provider string  `json:"provider"`
			IsAdmin  bool    `json:"isAdmin"`
		} `json:"user"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 32*1024)).Decode(&payload); err != nil {
		return User{}, fmt.Errorf("invalid mobile identity response: %w", err)
	}
	if payload.User.ID == "" || payload.User.Email == nil || payload.User.Provider != "email" {
		return User{}, errIdentityUnauthenticated
	}
	email := normalizeEmail(*payload.User.Email)
	if !strings.Contains(email, "@") || len(email) > 254 || len(payload.User.ID) > 200 {
		return User{}, errIdentityUnauthenticated
	}
	role := "author"
	if payload.User.IsAdmin {
		role = "admin"
	}
	return User{ID: payload.User.ID, Email: email, Role: role}, nil
}
