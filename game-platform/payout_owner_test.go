package main

import (
	"context"
	"testing"
	"time"
)

func TestEventTimeParsesClickHouseTimestamps(t *testing.T) {
	want := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	for _, value := range []string{"2026-09-10 12:00:00.000", "2026-09-10 12:00:00", "2026-09-10T12:00:00.000Z"} {
		if got := eventTime(map[string]any{}, value); !got.Equal(want) {
			t.Fatalf("eventTime(%q) = %v, want %v", value, got, want)
		}
	}
}

func TestPayoutFollowsGameIDOwnership(t *testing.T) {
	rows := append(playRows("game-revoked", 3), playRows("official-game", 3)...)
	server := openPanelFixture(t, rows)
	app, _ := payoutTestApp(t, server.URL)
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")

	// 月中下架的社区游戏，当月游玩仍应结算给原作者。
	publishTestGame(t, app, author, admin, "game-revoked", "1.0.0")
	if err := app.revokeRelease(ctx, "game-revoked"); err != nil {
		t.Fatal(err)
	}
	// 官方 id 由管理员投稿更新后，仍不参与分成。
	if _, err := app.db.ExecContext(ctx, `INSERT INTO releases(id, submission_id, game_id, version, entry_json, source_hash, status, created_at)
		VALUES('official-release', NULL, 'official-game', '1.0.0', '{}', 'hash', 'active', 1)`); err != nil {
		t.Fatal(err)
	}
	publishTestGame(t, app, admin, admin, "official-game", "1.1.0")

	thresholds := defaultThresholds()
	thresholds.MinValidPlays = 1
	reports, err := app.generatePayoutReports(ctx, "2026-09", 100, thresholds)
	if err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || reports[0].GameID != "game-revoked" || reports[0].AuthorID != author.ID || reports[0].AmountCNY != 100 {
		t.Fatalf("unexpected reports: %#v", reports)
	}
}
