package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// payoutTestApp 在测试配置上补好分成参数，并指向假 OpenPanel。
func payoutTestApp(t *testing.T, serverURL string) (*App, Config) {
	t.Helper()
	config := testConfig(t.TempDir())
	config.Payout = PayoutConfig{
		Timezone:       "Asia/Shanghai",
		BonusPoolCNY:   0,
		MinDurationMS:  5 * 60 * 1000,
		MinDeviceCount: 1,
		MinValidPlays:  20,
		OpenPanel: OpenPanelConfig{
			BaseURL: serverURL,
			Clients: []OpenPanelClientConfig{{Name: "pc", ProjectID: "project-1", ClientID: "client-1", ClientSecret: "secret-1", Events: []string{"game_stop"}}},
		},
	}
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.close() })
	return app, config
}

func TestGeneratePayoutReportsSnapshotsAndKeepsPaidRows(t *testing.T) {
	rows := append(playRows("game-a", 25), playRows("game-b", 15)...)
	rows = append(rows, map[string]any{
		"id": "official-1", "name": "game_stop", "createdAt": "2026-09-10T12:00:00Z",
		"properties": map[string]any{"game_id": "official-game", "duration_ms": 600000, "device_count": 1, "device_macs": "AA:99"},
	})
	server := openPanelFixture(t, rows)
	app, _ := payoutTestApp(t, server.URL)
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	publishTestGame(t, app, author, admin, "game-a", "1.0.0")
	publishTestGame(t, app, author, admin, "game-b", "1.0.0")

	reports, err := app.generatePayoutReports(ctx, "2026-09", 100, defaultThresholds())
	if err != nil {
		t.Fatal(err)
	}
	if len(reports) != 2 {
		t.Fatalf("official games must not be paid: %#v", reports)
	}
	for _, report := range reports {
		switch report.GameID {
		case "game-a":
			if report.ValidPlays != 25 || report.AmountCNY != 62 || report.AuthorEmail != "author@example.com" {
				t.Fatalf("unexpected game-a row: %#v", report)
			}
		case "game-b":
			if report.ValidPlays != 15 || report.AmountCNY != 37 {
				t.Fatalf("unexpected game-b row: %#v", report)
			}
		default:
			t.Fatalf("unexpected game id %q", report.GameID)
		}
		if report.Status != "draft" || report.TotalMinutes != float64(report.ValidPlays)*10 {
			t.Fatalf("unexpected row: %#v", report)
		}
	}

	if _, err := app.markPayoutReport(ctx, "2026-09", "game-a", "paid", "已发奖励金", admin.Email); err != nil {
		t.Fatal(err)
	}
	// 重新生成：paid 行保留，draft 行按新奖金池覆盖。
	reports, err = app.generatePayoutReports(ctx, "2026-09", 200, defaultThresholds())
	if err != nil {
		t.Fatal(err)
	}
	for _, report := range reports {
		switch report.GameID {
		case "game-a":
			if report.AmountCNY != 62 || report.Status != "paid" || report.Note != "已发奖励金" || report.PaidAt == 0 {
				t.Fatalf("paid row was overwritten: %#v", report)
			}
		case "game-b":
			// 200 × 15 / (25 + 15) = 75；已发放的行不覆盖，但仍在分配分母里。
			if report.AmountCNY != 75 || report.Status != "draft" {
				t.Fatalf("draft row was not regenerated: %#v", report)
			}
		}
	}

	mine, err := app.listPayoutReports(ctx, "", author.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(mine) != 2 {
		t.Fatalf("author rows = %d", len(mine))
	}
	other, err := app.listPayoutReports(ctx, "", "someone-else")
	if err != nil || len(other) != 0 {
		t.Fatalf("other author rows = %d, err = %v", len(other), err)
	}
}

func TestGeneratePayoutReportsHonoursThresholdAndDedup(t *testing.T) {
	rows := playRows("game-a", 10)
	rows = append(rows, map[string]any{
		"id": "short", "name": "game_stop", "createdAt": "2026-09-11T12:00:00Z",
		"properties": map[string]any{"game_id": "game-a", "duration_ms": 60000, "device_count": 1, "device_macs": "AA:77"},
	})
	rows = append(rows, map[string]any{
		"id": "no-device", "name": "game_stop", "createdAt": "2026-09-11T12:00:00Z",
		"properties": map[string]any{"game_id": "game-a", "duration_ms": 600000, "device_macs": ""},
	})
	server := openPanelFixture(t, rows)
	app, _ := payoutTestApp(t, server.URL)
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	publishTestGame(t, app, author, admin, "game-a", "1.0.0")

	reports, err := app.generatePayoutReports(ctx, "2026-09", 100, PayoutThresholds{MinDurationMS: 5 * 60 * 1000, MinDeviceCount: 1, MinValidPlays: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || reports[0].ValidPlays != 10 || reports[0].AmountCNY != 0 {
		t.Fatalf("games below the threshold must stay at 0: %#v", reports)
	}
	reports, err = app.generatePayoutReports(ctx, "2026-09", 100, PayoutThresholds{MinDurationMS: 5 * 60 * 1000, MinDeviceCount: 1, MinValidPlays: 5})
	if err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || reports[0].AmountCNY != 100 {
		t.Fatalf("unexpected amount: %#v", reports)
	}
}

func TestPayoutRoutesRequireAdminAndScopeAuthors(t *testing.T) {
	server := openPanelFixture(t, playRows("game-a", 3))
	identity := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Header.Get("Authorization") {
		case "Bearer author-token":
			_, _ = w.Write([]byte(`{"user":{"id":"mobile-author","email":"author@example.com","provider":"email","isAdmin":false}}`))
		case "Bearer admin-token":
			_, _ = w.Write([]byte(`{"user":{"id":"mobile-admin","email":"admin@example.com","provider":"email","isAdmin":true}}`))
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer identity.Close()
	config := testConfig(t.TempDir())
	config.IdentityAPIBaseURL = identity.URL
	config.Payout = PayoutConfig{
		Timezone: "Asia/Shanghai", MinDurationMS: 5 * 60 * 1000, MinDeviceCount: 1, MinValidPlays: 1,
		OpenPanel: OpenPanelConfig{BaseURL: server.URL, Clients: []OpenPanelClientConfig{{Name: "pc", ProjectID: "p", ClientID: "c", ClientSecret: "s", Events: []string{"game_stop"}}}},
	}
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	publishTestGame(t, app, author, admin, "game-a", "1.0.0")
	if _, err := app.generatePayoutReports(ctx, "2026-09", 50, defaultThresholds()); err != nil {
		t.Fatal(err)
	}
	handler := app.routes()

	call := func(method, path, token, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+token)
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	if response := call(http.MethodGet, "/api/admin/payouts/2026-09", "author-token", ""); response.Code != http.StatusForbidden {
		t.Fatalf("author admin access = %d", response.Code)
	}
	if response := call(http.MethodGet, "/api/admin/payouts/2026-9", "admin-token", ""); response.Code != http.StatusBadRequest {
		t.Fatalf("bad month = %d, body=%s", response.Code, response.Body.String())
	}
	response := call(http.MethodGet, "/api/admin/payouts/2026-09", "admin-token", "")
	if response.Code != http.StatusOK {
		t.Fatalf("admin list = %d, body=%s", response.Code, response.Body.String())
	}
	var listed struct {
		Reports []PayoutReport `json:"reports"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Reports) != 1 || listed.Reports[0].AuthorEmail != "author@example.com" {
		t.Fatalf("unexpected admin list: %#v", listed.Reports)
	}

	response = call(http.MethodGet, "/api/admin/payouts/2026-09.csv", "admin-token", "")
	if response.Code != http.StatusOK {
		t.Fatalf("csv status = %d", response.Code)
	}
	body := response.Body.String()
	if !strings.HasPrefix(body, "\ufeff") || !strings.Contains(body, "game-a") || !strings.Contains(body, "有效游玩") {
		t.Fatalf("unexpected csv body: %q", body)
	}

	response = call(http.MethodGet, "/api/payouts/mine", "author-token", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "game-a") {
		t.Fatalf("author mine = %d, body=%s", response.Code, response.Body.String())
	}
	response = call(http.MethodGet, "/api/payouts/mine", "admin-token", "")
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "game-a") {
		t.Fatalf("admin must not see author rows in mine: %s", response.Body.String())
	}

	response = call(http.MethodPost, "/api/admin/payouts/2026-09/game-a/mark", "admin-token", `{"status":"skipped","note":"重复投稿"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("mark = %d, body=%s", response.Code, response.Body.String())
	}
	response = call(http.MethodPost, "/api/admin/payouts/2026-09/game-a/mark", "admin-token", `{"status":"unknown"}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid mark status = %d", response.Code)
	}
	response = call(http.MethodPost, "/api/admin/payouts/2026-09/missing/mark", "admin-token", `{"status":"paid"}`)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing row mark = %d", response.Code)
	}
}

func TestGeneratePayoutRequiresOpenPanelClient(t *testing.T) {
	config := testConfig(t.TempDir())
	config.Payout = PayoutConfig{Timezone: "Asia/Shanghai", MinDurationMS: 1000, MinDeviceCount: 1, MinValidPlays: 1}
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	if _, err := app.generatePayoutReports(context.Background(), "2026-09", 10, defaultThresholds()); err == nil {
		t.Fatal("generate without a read client must fail")
	}
}
