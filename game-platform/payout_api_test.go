package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// payoutTestApp 起一个分成测试用的 App；发钱数据全靠手工录入，不再需要 OpenPanel。
func payoutTestApp(t *testing.T) *App {
	t.Helper()
	app, err := newApp(testConfig(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.close() })
	return app
}

func TestValidPayoutMonth(t *testing.T) {
	for _, good := range []string{"2026-09", "2026-10", "2025-12"} {
		if !validPayoutMonth(good) {
			t.Fatalf("month %q was rejected", good)
		}
	}
	for _, bad := range []string{"2026-9", "202609", "2026-13", "", "2026-09-01", "2026-00"} {
		if validPayoutMonth(bad) {
			t.Fatalf("month %q was accepted", bad)
		}
	}
}

func TestCreatePayoutRecordUsesGameOwner(t *testing.T) {
	app := payoutTestApp(t)
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	publishTestGame(t, app, author, admin, "game-a", "1.0.0")
	publishTestGame(t, app, author, admin, "game-b", "1.0.0")

	plays := 12
	record, err := app.createPayoutRecord(ctx, "2026-09", "game-a", 88, &plays, "商城已发", admin.Email)
	if err != nil {
		t.Fatal(err)
	}
	if record.AuthorID != author.ID || record.AuthorName != "Author mobile-author" || record.AuthorEmail != "author@example.com" {
		t.Fatalf("unexpected author on record: %#v", record)
	}
	if record.ValidPlays == nil || *record.ValidPlays != 12 || record.AmountCNY != 88 || record.PaidBy != admin.Email || record.PaidAt == 0 {
		t.Fatalf("unexpected record: %#v", record)
	}

	// 参考数据可以不填。
	plain, err := app.createPayoutRecord(ctx, "2026-09", "game-b", 5, nil, "", admin.Email)
	if err != nil {
		t.Fatal(err)
	}
	if plain.ValidPlays != nil {
		t.Fatalf("valid plays should stay empty: %#v", plain)
	}
}

func TestCreatePayoutRecordRejectsBadInput(t *testing.T) {
	app := payoutTestApp(t)
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	publishTestGame(t, app, author, admin, "game-a", "1.0.0")
	// 官方游戏（没有归属作者）不能录入分成。
	insertOfficialRelease(t, app, "official-game", "1.0.0")

	if _, err := app.createPayoutRecord(ctx, "2026-9", "game-a", 10, nil, "", admin.Email); err != errInvalidPayoutMonth {
		t.Fatalf("bad month error = %v", err)
	}
	if _, err := app.createPayoutRecord(ctx, "2026-09", "game-a", 0, nil, "", admin.Email); err != errPayoutAmount {
		t.Fatalf("zero amount error = %v", err)
	}
	if _, err := app.createPayoutRecord(ctx, "2026-09", "game-a", 10, nil, strings.Repeat("字", 501), admin.Email); err != errPayoutNoteTooLong {
		t.Fatalf("long note error = %v", err)
	}
	if _, err := app.createPayoutRecord(ctx, "2026-09", "official-game", 10, nil, "", admin.Email); err != errPayoutGameMissing {
		t.Fatalf("official game error = %v, want errPayoutGameMissing", err)
	}
	if _, err := app.createPayoutRecord(ctx, "2026-09", "missing-game", 10, nil, "", admin.Email); err != errPayoutGameMissing {
		t.Fatalf("unknown game error = %v, want errPayoutGameMissing", err)
	}
	if _, err := app.createPayoutRecord(ctx, "2026-09", "game-a", 10, nil, "", admin.Email); err != nil {
		t.Fatal(err)
	}
	if _, err := app.createPayoutRecord(ctx, "2026-09", "game-a", 20, nil, "", admin.Email); err != errPayoutDuplicate {
		t.Fatalf("duplicate error = %v, want errPayoutDuplicate", err)
	}
	// 不同月份可以再录一条。
	if _, err := app.createPayoutRecord(ctx, "2026-10", "game-a", 20, nil, "", admin.Email); err != nil {
		t.Fatal(err)
	}
}

func TestDeletePayoutRecord(t *testing.T) {
	app := payoutTestApp(t)
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	publishTestGame(t, app, author, admin, "game-a", "1.0.0")
	record, err := app.createPayoutRecord(ctx, "2026-09", "game-a", 30, nil, "", admin.Email)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.deletePayoutRecord(ctx, record.ID); err != nil {
		t.Fatal(err)
	}
	if err := app.deletePayoutRecord(ctx, record.ID); err != errPayoutRecordGone {
		t.Fatalf("second delete error = %v, want errPayoutRecordGone", err)
	}
	records, err := app.listPayoutRecords(ctx, "2026-09", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 0 {
		t.Fatalf("records after delete = %#v", records)
	}
}

func TestListPayoutRecordsScopesAuthorAndMonth(t *testing.T) {
	app := payoutTestApp(t)
	ctx := context.Background()
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	other := testIdentity(t, app, "mobile-other", "other@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	publishTestGame(t, app, author, admin, "game-a", "1.0.0")
	publishTestGame(t, app, other, admin, "game-b", "1.0.0")
	if _, err := app.createPayoutRecord(ctx, "2026-09", "game-a", 10, nil, "", admin.Email); err != nil {
		t.Fatal(err)
	}
	if _, err := app.createPayoutRecord(ctx, "2026-10", "game-a", 20, nil, "", admin.Email); err != nil {
		t.Fatal(err)
	}
	if _, err := app.createPayoutRecord(ctx, "2026-09", "game-b", 30, nil, "", admin.Email); err != nil {
		t.Fatal(err)
	}

	september, err := app.listPayoutRecords(ctx, "2026-09", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(september) != 2 {
		t.Fatalf("september rows = %d", len(september))
	}
	all, err := app.listPayoutRecords(ctx, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 || all[0].Month != "2026-10" {
		t.Fatalf("all rows must be month-descending: %#v", all)
	}
	mine, err := app.listPayoutRecords(ctx, "", author.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(mine) != 2 {
		t.Fatalf("author rows = %d", len(mine))
	}
	for _, record := range mine {
		if record.AuthorID != author.ID {
			t.Fatalf("author saw someone else's row: %#v", record)
		}
	}
	stranger, err := app.listPayoutRecords(ctx, "", "someone-else")
	if err != nil || len(stranger) != 0 {
		t.Fatalf("stranger rows = %d, err = %v", len(stranger), err)
	}
}

func TestSetGameOwnerRequiresKnownEmail(t *testing.T) {
	app := payoutTestApp(t)
	ctx := context.Background()
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	if _, err := app.setGameOwner(ctx, "imported-game", "nobody@example.com", "DK", admin.Email); err != errGameOwnerEmailMissing {
		t.Fatalf("unknown email error = %v, want errGameOwnerEmailMissing", err)
	}
	if _, err := app.setGameOwner(ctx, "imported-game", "not-an-email", "DK", admin.Email); err != errGameOwnerEmailMissing {
		t.Fatalf("invalid email error = %v, want errGameOwnerEmailMissing", err)
	}
	if _, err := app.setGameOwner(ctx, "imported-game", "admin@example.com", "", admin.Email); err == nil {
		t.Fatal("empty author name must be rejected")
	}
}

// payoutRoutesFixture 起一个假 mobile /me，并返回带两条身份的路由。
func payoutRoutesFixture(t *testing.T) (*App, http.Handler, User, User) {
	t.Helper()
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
	t.Cleanup(identity.Close)
	config := testConfig(t.TempDir())
	config.IdentityAPIBaseURL = identity.URL
	app, err := newApp(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.close() })
	author := testIdentity(t, app, "mobile-author", "author@example.com", "author")
	admin := testIdentity(t, app, "mobile-admin", "admin@example.com", "admin")
	return app, app.routes(), author, admin
}

func payoutCall(handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestPayoutRoutesRequireAdminAndScopeAuthors(t *testing.T) {
	app, handler, author, admin := payoutRoutesFixture(t)
	publishTestGame(t, app, author, admin, "game-a", "1.0.0")

	if response := payoutCall(handler, http.MethodGet, "/api/admin/payouts", "author-token", ""); response.Code != http.StatusForbidden {
		t.Fatalf("author admin list = %d", response.Code)
	}
	if response := payoutCall(handler, http.MethodPost, "/api/admin/payouts", "author-token", `{"month":"2026-09","gameId":"game-a","amountCny":10}`); response.Code != http.StatusForbidden {
		t.Fatalf("author create = %d", response.Code)
	}
	if response := payoutCall(handler, http.MethodGet, "/api/admin/community-games", "author-token", ""); response.Code != http.StatusForbidden {
		t.Fatalf("author community games = %d", response.Code)
	}
	if response := payoutCall(handler, http.MethodGet, "/api/admin/payouts", "", ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous list = %d", response.Code)
	}

	response := payoutCall(handler, http.MethodPost, "/api/admin/payouts", "admin-token", `{"month":"2026-09","gameId":"game-a","amountCny":66,"validPlays":9,"note":"商城已发"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("create = %d, body=%s", response.Code, response.Body.String())
	}
	var created struct {
		Record PayoutRecord `json:"record"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Record.AuthorEmail != "author@example.com" || created.Record.AmountCNY != 66 {
		t.Fatalf("unexpected created record: %#v", created.Record)
	}

	// 同月同游戏重复录入返回冲突。
	if response := payoutCall(handler, http.MethodPost, "/api/admin/payouts", "admin-token", `{"month":"2026-09","gameId":"game-a","amountCny":10}`); response.Code != http.StatusConflict {
		t.Fatalf("duplicate = %d, body=%s", response.Code, response.Body.String())
	}
	// 非社区游戏（没有归属作者）被拒。
	if response := payoutCall(handler, http.MethodPost, "/api/admin/payouts", "admin-token", `{"month":"2026-09","gameId":"missing-game","amountCny":10}`); response.Code != http.StatusBadRequest {
		t.Fatalf("missing game = %d", response.Code)
	}
	// 坏月份、坏金额。
	if response := payoutCall(handler, http.MethodPost, "/api/admin/payouts", "admin-token", `{"month":"2026-9","gameId":"game-a","amountCny":10}`); response.Code != http.StatusBadRequest {
		t.Fatalf("bad month = %d", response.Code)
	}
	if response := payoutCall(handler, http.MethodPost, "/api/admin/payouts", "admin-token", `{"month":"2026-09","gameId":"game-a","amountCny":0}`); response.Code != http.StatusBadRequest {
		t.Fatalf("bad amount = %d", response.Code)
	}

	response = payoutCall(handler, http.MethodGet, "/api/admin/payouts?month=2026-09", "admin-token", "")
	if response.Code != http.StatusOK {
		t.Fatalf("admin list = %d, body=%s", response.Code, response.Body.String())
	}
	var listed struct {
		Records []PayoutRecord `json:"records"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Records) != 1 || listed.Records[0].AuthorEmail != "author@example.com" {
		t.Fatalf("unexpected admin list: %#v", listed.Records)
	}
	if response := payoutCall(handler, http.MethodGet, "/api/admin/payouts?month=2026-9", "admin-token", ""); response.Code != http.StatusBadRequest {
		t.Fatalf("bad month list = %d", response.Code)
	}
	if response := payoutCall(handler, http.MethodGet, "/api/admin/payouts?month=2026-08", "admin-token", ""); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"records":[]`) {
		t.Fatalf("empty month list = %d, body=%s", response.Code, response.Body.String())
	}

	// 作者只看自己。
	response = payoutCall(handler, http.MethodGet, "/api/payouts/mine", "author-token", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "game-a") {
		t.Fatalf("author mine = %d, body=%s", response.Code, response.Body.String())
	}
	response = payoutCall(handler, http.MethodGet, "/api/payouts/mine", "admin-token", "")
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "game-a") {
		t.Fatalf("admin must not see author rows in mine: %s", response.Body.String())
	}

	// 删除录错的记录。
	id := created.Record.ID
	response = payoutCall(handler, http.MethodPost, "/api/admin/payouts/"+itoa(id)+"/delete", "admin-token", `{}`)
	if response.Code != http.StatusOK {
		t.Fatalf("delete = %d, body=%s", response.Code, response.Body.String())
	}
	if response := payoutCall(handler, http.MethodPost, "/api/admin/payouts/"+itoa(id)+"/delete", "admin-token", `{}`); response.Code != http.StatusNotFound {
		t.Fatalf("second delete = %d", response.Code)
	}
	if response := payoutCall(handler, http.MethodPost, "/api/admin/payouts/abc/delete", "admin-token", `{}`); response.Code != http.StatusNotFound {
		t.Fatalf("bad id delete = %d", response.Code)
	}
	if response := payoutCall(handler, http.MethodPost, "/api/admin/payouts/"+itoa(id)+"/delete", "author-token", `{}`); response.Code != http.StatusForbidden {
		t.Fatalf("author delete = %d", response.Code)
	}
}

func TestAdminCommunityGamesList(t *testing.T) {
	app, handler, author, admin := payoutRoutesFixture(t)
	ctx := context.Background()
	publishTestGame(t, app, author, admin, "game-active", "1.0.0")
	publishTestGame(t, app, author, admin, "game-revoked", "1.0.0")
	if err := app.revokeRelease(ctx, "game-revoked"); err != nil {
		t.Fatal(err)
	}
	insertOfficialRelease(t, app, "official-game", "1.0.0")
	// 导入的社区游戏：只有官方 release，靠归属指定认领。
	insertOfficialRelease(t, app, "imported-game", "2.0.0")
	if _, err := app.setGameOwner(ctx, "imported-game", "author@example.com", "DK", admin.Email); err != nil {
		t.Fatal(err)
	}

	response := payoutCall(handler, http.MethodGet, "/api/admin/community-games", "admin-token", "")
	if response.Code != http.StatusOK {
		t.Fatalf("community games = %d, body=%s", response.Code, response.Body.String())
	}
	var listed struct {
		Games []communityGame `json:"games"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	got := map[string]communityGame{}
	for _, game := range listed.Games {
		got[game.GameID] = game
	}
	if _, ok := got["official-game"]; ok {
		t.Fatalf("official game must not be listed: %#v", listed.Games)
	}
	if len(got) != 3 {
		t.Fatalf("community games = %#v", listed.Games)
	}
	if got["game-active"].Status != "active" || got["game-active"].AuthorEmail != "author@example.com" || got["game-active"].Title != "Test Game" {
		t.Fatalf("unexpected active row: %#v", got["game-active"])
	}
	if got["game-revoked"].Status != "revoked" {
		t.Fatalf("revoked row status = %q", got["game-revoked"].Status)
	}
	if got["imported-game"].AuthorID != author.ID || got["imported-game"].AuthorName != "DK" {
		t.Fatalf("imported game was not claimed: %#v", got["imported-game"])
	}
}

func TestAdminGameOwnerRoutes(t *testing.T) {
	_, handler, author, _ := payoutRoutesFixture(t)
	response := payoutCall(handler, http.MethodPost, "/api/admin/game-owners", "admin-token", `{"gameId":"imported-game","email":"author@example.com","authorName":"DK"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("set owner = %d, body=%s", response.Code, response.Body.String())
	}
	response = payoutCall(handler, http.MethodPost, "/api/admin/game-owners", "admin-token", `{"gameId":"other-game","email":"nobody@example.com","authorName":"DK"}`)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "尚未登录") {
		t.Fatalf("unknown email = %d, body=%s", response.Code, response.Body.String())
	}
	response = payoutCall(handler, http.MethodGet, "/api/admin/game-owners", "admin-token", "")
	if response.Code != http.StatusOK {
		t.Fatalf("list owners = %d", response.Code)
	}
	var listed struct {
		Owners []assignedOwner `json:"owners"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Owners) != 1 || listed.Owners[0].GameID != "imported-game" || listed.Owners[0].Email != "author@example.com" {
		t.Fatalf("unexpected owners: %#v", listed.Owners)
	}
	if listed.Owners[0].AuthorID != author.ID {
		t.Fatalf("owner author = %#v", listed.Owners[0])
	}
	if response := payoutCall(handler, http.MethodGet, "/api/admin/game-owners", "author-token", ""); response.Code != http.StatusForbidden {
		t.Fatalf("author list owners = %d", response.Code)
	}
}

func itoa(value int64) string {
	return strconv.FormatInt(value, 10)
}
