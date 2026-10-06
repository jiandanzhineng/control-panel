package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

var shanghai = mustLoad("Asia/Shanghai")

func mustLoad(name string) *time.Location {
	location, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return location
}

func at(month string, day, hour, minute int) time.Time {
	return time.Date(2026, monthIndex(month), day, hour, minute, 0, 0, shanghai)
}

func monthIndex(month string) time.Month {
	switch month {
	case "09":
		return time.September
	case "10":
		return time.October
	default:
		return time.January
	}
}

func payoutEventFor(gameID, macs string, durationMS int64, when time.Time) payoutEvent {
	return payoutEvent{
		GameID:      gameID,
		Source:      "community",
		DurationMS:  durationMS,
		DeviceCount: len(splitList(macs)),
		DeviceMACs:  splitList(macs),
		ProfileID:   "profile-1",
		OccurredAt:  when,
	}
}

func defaultThresholds() PayoutThresholds {
	return PayoutThresholds{MinDurationMS: 5 * 60 * 1000, MinDeviceCount: 1, MinValidPlays: 1}
}

func TestPayoutMonthRangeUsesShanghaiBoundaries(t *testing.T) {
	start, end, err := payoutMonthRange("2026-09", shanghai)
	if err != nil {
		t.Fatal(err)
	}
	if start.UTC().Format(time.RFC3339) != "2026-08-31T16:00:00Z" {
		t.Fatalf("month start = %s", start.UTC().Format(time.RFC3339))
	}
	if end.UTC().Format(time.RFC3339) != "2026-09-30T16:00:00Z" {
		t.Fatalf("month end = %s", end.UTC().Format(time.RFC3339))
	}
	for _, bad := range []string{"2026-9", "202609", "2026-13", "", "2026-09-01"} {
		if _, _, err := payoutMonthRange(bad, shanghai); err == nil {
			t.Fatalf("month %q was accepted", bad)
		}
	}
}

func TestAggregatePayoutEventsFiltersAndDeduplicates(t *testing.T) {
	events := []payoutEvent{
		payoutEventFor("game-a", "AA:01", 10*60*1000, at("09", 1, 20, 0)),
		payoutEventFor("game-a", "AA:01", 10*60*1000, at("09", 1, 22, 0)),
		payoutEventFor("game-a", "AA:01", 10*60*1000, at("09", 2, 20, 0)),
		payoutEventFor("game-a", "BB:02", 10*60*1000, at("09", 1, 23, 0)),
		payoutEventFor("game-a", "CC:03", 4*60*1000, at("09", 3, 20, 0)),
		payoutEventFor("game-a", "DD:04,EE:05", 6*60*1000, at("09", 4, 20, 0)),
		payoutEventFor("game-a", "", 10*60*1000, at("09", 5, 20, 0)),
	}
	got := aggregatePayoutEvents(events, shanghai, defaultThresholds(), map[string]bool{}, map[string]bool{})
	entry := got["game-a"]
	if entry == nil {
		t.Fatal("game-a was dropped")
	}
	// 7 条事件：同日同设备的第 2 条、时长不足的 1 条、没有设备的 1 条都不计入。
	if entry.ValidPlays != 4 {
		t.Fatalf("valid plays = %d, want 4", entry.ValidPlays)
	}
	if entry.UniqueDevices != 4 {
		t.Fatalf("unique devices = %d, want 4", entry.UniqueDevices)
	}
	if entry.TotalMS != 36*60*1000 {
		t.Fatalf("total ms = %d", entry.TotalMS)
	}
}

func TestOpenPanelClientReadsEventsWithReadHeaders(t *testing.T) {
	var seenPath, seenClientID, seenSecret string
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		seenPath = r.URL.Path
		seenClientID = r.Header.Get("openpanel-client-id")
		seenSecret = r.Header.Get("openpanel-client-secret")
		if r.URL.Query().Get("projectId") != "project-1" {
			t.Errorf("projectId = %q", r.URL.Query().Get("projectId"))
		}
		if r.URL.Query().Get("start") != "2026-08-31T16:00:00Z" {
			t.Errorf("start = %q", r.URL.Query().Get("start"))
		}
		page := r.URL.Query().Get("offset")
		rows := []map[string]any{}
		if page == "0" {
			rows = append(rows, map[string]any{
				"id": "evt_1", "name": "game_stop", "createdAt": "2026-09-01T12:00:00Z",
				"properties": map[string]any{"game_id": "game-a", "source": "community", "duration_ms": 600000, "device_count": 1, "device_macs": "AA:01"},
			})
			for index := 0; index < openPanelPageSize; index++ {
				rows = append(rows, map[string]any{
					"id": "evt_fill", "name": "game_stop", "createdAt": "2026-09-01T12:00:00Z",
					"properties": map[string]any{"game_id": "game-fill", "duration_ms": 600000, "device_macs": "FF:FF"},
				})
			}
		} else {
			rows = append(rows, map[string]any{
				"id": "evt_2", "name": "game_exit", "createdAt": "2026-09-02T12:00:00Z",
				"properties": map[string]any{"game_id": "game-b", "session_duration_ms": 300000, "device_macs": "BB:02"},
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": rows})
	}))
	defer server.Close()

	client := newOpenPanelClient(OpenPanelConfig{
		BaseURL: server.URL,
		Clients: []OpenPanelClientConfig{{
			Name: "pc", ProjectID: "project-1", ClientID: "client-1", ClientSecret: "secret-1", Events: []string{"game_stop", "game_exit"},
		}},
	}, 5*time.Second)
	events, err := client.events(context.Background(), at("09", 1, 0, 0), at("10", 1, 0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2 (paged)", requests)
	}
	if seenPath != "/export/events" || seenClientID != "client-1" || seenSecret != "secret-1" {
		t.Fatalf("unexpected request: path=%q id=%q secret=%q", seenPath, seenClientID, seenSecret)
	}
	if len(events) != openPanelPageSize+2 {
		t.Fatalf("events = %d", len(events))
	}
	if events[0].GameID != "game-a" || events[0].DurationMS != 600000 || len(events[0].DeviceMACs) != 1 {
		t.Fatalf("first event = %#v", events[0])
	}
	last := events[len(events)-1]
	if last.GameID != "game-b" || last.DurationMS != 300000 {
		t.Fatalf("fallback duration was not used: %#v", last)
	}
}

func TestOpenPanelClientRequiresReadClient(t *testing.T) {
	client := newOpenPanelClient(OpenPanelConfig{BaseURL: "https://op.invalid/api"}, time.Second)
	if client.configured() {
		t.Fatal("client without secret must not be configured")
	}
	if _, err := client.events(context.Background(), time.Now(), time.Now()); err == nil {
		t.Fatal("unconfigured client must return an error")
	}
}

func TestSplitPoolRoundsDownAndHonoursThreshold(t *testing.T) {
	aggregates := map[string]*payoutAggregate{
		"game-a": {ValidPlays: 30},
		"game-b": {ValidPlays: 20},
		"game-c": {ValidPlays: 5},
	}
	amounts := splitPool(101, aggregates, 20)
	if amounts["game-a"] != 60 || amounts["game-b"] != 40 {
		t.Fatalf("unexpected amounts: %#v", amounts)
	}
	if amounts["game-c"] != 0 {
		t.Fatalf("game below the threshold must get 0, got %d", amounts["game-c"])
	}
	amounts = splitPool(101, aggregates, 5)
	if amounts["game-a"] != 55 || amounts["game-b"] != 36 || amounts["game-c"] != 9 {
		t.Fatalf("unexpected amounts after rounding down: %#v", amounts)
	}
}

func publishTestGame(t *testing.T, app *App, author, admin User, gameID, version string) {
	t.Helper()
	ctx := context.Background()
	submission, err := app.createSubmission(ctx, author, "Author "+author.ID, "Game "+gameID, "", "zip", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := app.store.Put(ctx, submission.ZipKey, gameZIP(t, gameID, version), "application/zip"); err != nil {
		t.Fatal(err)
	}
	submission, err = app.completeZipSubmission(ctx, submission)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.publishSubmission(ctx, submission, admin); err != nil {
		t.Fatal(err)
	}
}

// openPanelFixture 起一个假 OpenPanel，返回给定事件。
func openPanelFixture(t *testing.T, rows []map[string]any) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/export/events" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": rows})
	}))
	t.Cleanup(server.Close)
	return server
}

func playRows(gameID string, count int) []map[string]any {
	rows := []map[string]any{}
	for index := 0; index < count; index++ {
		rows = append(rows, map[string]any{
			"id":         gameID + "-" + strconv.Itoa(index),
			"name":       "game_stop",
			"createdAt":  "2026-09-10T12:00:00Z",
			"profileId":  "profile-" + strconv.Itoa(index),
			"properties": map[string]any{"game_id": gameID, "source": "community", "duration_ms": 600000, "device_count": 1, "device_macs": "AA:" + strconv.Itoa(index)},
		})
	}
	return rows
}
