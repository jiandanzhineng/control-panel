package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// handleAdminPayoutList 列出发放记录：带 month 只看该月，不带返回全部（按月份倒序）。
func (a *App) handleAdminPayoutList(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	month := strings.TrimSpace(r.URL.Query().Get("month"))
	if month != "" && !validPayoutMonth(month) {
		writeError(w, http.StatusBadRequest, "PAYOUT_MONTH_INVALID", "月份格式必须是 YYYY-MM")
		return
	}
	records, err := a.listPayoutRecords(r.Context(), month, "")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PAYOUT_LIST_FAILED", "读取发放记录失败")
		return
	}
	records, err = a.attachAuthorEmails(r.Context(), records)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PAYOUT_LIST_FAILED", "读取作者邮箱失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"month": month, "records": records})
}

// handleAdminPayoutCreate 录入一条发放记录。作者按 game_id 归属自动带出。
func (a *App) handleAdminPayoutCreate(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	var input struct {
		Month      string `json:"month"`
		GameID     string `json:"gameId"`
		AmountCNY  int64  `json:"amountCny"`
		ValidPlays *int   `json:"validPlays"`
		Note       string `json:"note"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	input.Month = strings.TrimSpace(input.Month)
	input.GameID = strings.TrimSpace(input.GameID)
	if input.GameID == "" {
		writeError(w, http.StatusBadRequest, "PAYOUT_GAME_REQUIRED", "请选择要发放的游戏")
		return
	}
	record, err := a.createPayoutRecord(r.Context(), input.Month, input.GameID, input.AmountCNY, input.ValidPlays, input.Note, user.Email)
	if err != nil {
		writePayoutError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"record": record})
}

// writePayoutError 把分成相关的领域错误翻译成中文提示与合适的 HTTP 状态码。
func writePayoutError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errInvalidPayoutMonth):
		writeError(w, http.StatusBadRequest, "PAYOUT_MONTH_INVALID", "月份格式必须是 YYYY-MM")
	case errors.Is(err, errPayoutAmount):
		writeError(w, http.StatusBadRequest, "PAYOUT_AMOUNT_INVALID", "金额必须大于 0 元")
	case errors.Is(err, errPayoutNoteTooLong):
		writeError(w, http.StatusBadRequest, "PAYOUT_NOTE_TOO_LONG", "备注最多 500 字")
	case errors.Is(err, errPayoutGameMissing):
		writeError(w, http.StatusBadRequest, "PAYOUT_GAME_NOT_COMMUNITY", "该游戏 ID 不是社区游戏（没有归属作者），不能录入分成；如果确实是社区作者的导入游戏，请先在「归属指定」里指定作者")
	case errors.Is(err, errPayoutDuplicate):
		writeError(w, http.StatusConflict, "PAYOUT_DUPLICATE", "该游戏这个月已经录入过发放记录，如需修改请先删除原记录")
	case errors.Is(err, errPayoutRecordGone):
		writeError(w, http.StatusNotFound, "PAYOUT_RECORD_NOT_FOUND", "找不到这条发放记录")
	case errors.Is(err, errGameOwnerEmailMissing):
		writeError(w, http.StatusBadRequest, "GAME_OWNER_EMAIL_UNKNOWN", "该邮箱尚未登录过投稿平台，请让作者先用这个邮箱登录一次")
	case errors.Is(err, errGameOwnerGone):
		writeError(w, http.StatusNotFound, "GAME_OWNER_NOT_FOUND", "该游戏没有手工指定的归属")
	default:
		writeError(w, http.StatusInternalServerError, "PAYOUT_FAILED", err.Error())
	}
}

// handleAdminPayoutAction 处理删除：POST /api/admin/payouts/{id}/delete。
func (a *App) handleAdminPayoutAction(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	parts := pathParts(r.URL.Path, "/api/admin/payouts/")
	if len(parts) != 2 || parts[1] != "delete" {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
		return
	}
	id, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
		return
	}
	if err := a.deletePayoutRecord(r.Context(), id); err != nil {
		writePayoutError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleMyPayouts 只返回当前账号自己的发放记录。
func (a *App) handleMyPayouts(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	records, err := a.listPayoutRecords(r.Context(), "", user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PAYOUT_LIST_FAILED", "读取分成记录失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"records": records})
}

// communityGame 是审核后台「月度分成」tab 里的一行社区游戏。
type communityGame struct {
	GameID      string `json:"gameId"`
	Title       string `json:"title"`
	Version     string `json:"version"`
	AuthorID    string `json:"authorId"`
	AuthorName  string `json:"authorName"`
	AuthorEmail string `json:"email"`
	Status      string `json:"status"`
}

// handleAdminCommunityGames 列出所有社区游戏（含已下架），供管理员找人发钱和录入时选择。
// 官方游戏（没有归属作者）不在列表里。
func (a *App) handleAdminCommunityGames(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	games, err := a.listCommunityGames(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "COMMUNITY_GAMES_FAILED", "读取社区游戏失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"games": games})
}

// listCommunityGames 汇总每个 game_id 的最新版本、标题与归属作者。
func (a *App) listCommunityGames(ctx context.Context) ([]communityGame, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT r.game_id, r.version, r.entry_json, r.status,
		COALESCE(s.author_id, ''), COALESCE(s.author_name, '')
		FROM releases r LEFT JOIN submissions s ON s.id = r.submission_id
		ORDER BY r.created_at ASC, r.rowid ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type gameState struct {
		communityGame
		hasActive bool
	}
	states := map[string]*gameState{}
	order := []string{}
	for rows.Next() {
		var gameID, version, entryJSON, status, authorID, authorName string
		if err := rows.Scan(&gameID, &version, &entryJSON, &status, &authorID, &authorName); err != nil {
			return nil, err
		}
		state := states[gameID]
		if state == nil {
			state = &gameState{}
			states[gameID] = state
			order = append(order, gameID)
		}
		// 标题、版本取当前 active release；没有 active（全部下架）时取最后一条并标记已下架。
		if status == "active" {
			state.Version, state.Status, state.hasActive = version, status, true
			state.Title = entryTitle(entryJSON, state.Title)
		} else if !state.hasActive {
			state.Version, state.Status = version, status
			state.Title = entryTitle(entryJSON, state.Title)
		}
		if authorID != "" {
			state.AuthorID, state.AuthorName = authorID, authorName
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 归属以 ownership 判定为准（含 game_owners 手工指定），覆盖上面按 release 得到的作者。
	out := []communityGame{}
	for _, gameID := range order {
		state := states[gameID]
		owner, err := a.gameOwner(ctx, a.db, gameID)
		if err != nil {
			return nil, err
		}
		if owner.AuthorID == "" {
			continue
		}
		game := communityGame{
			GameID:      gameID,
			Title:       state.Title,
			Version:     state.Version,
			AuthorID:    owner.AuthorID,
			AuthorName:  owner.AuthorName,
			AuthorEmail: owner.Email,
			Status:      "revoked",
		}
		if state.hasActive {
			game.Status = "active"
		}
		if game.Title == "" {
			game.Title = gameID
		}
		out = append(out, game)
	}
	return out, nil
}

// entryTitle 读 release 的 entry_json 取标题；读不出或为空时沿用 fallback。
func entryTitle(entryJSON, fallback string) string {
	var entry RegistryEntry
	if err := json.Unmarshal([]byte(entryJSON), &entry); err != nil || strings.TrimSpace(entry.Title) == "" {
		return fallback
	}
	return entry.Title
}

// handleAdminGameOwners 列出管理员手工指定的归属。
func (a *App) handleAdminGameOwners(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	owners, err := a.listAssignedOwners(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "GAME_OWNERS_FAILED", "读取归属指定失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"owners": owners})
}

// handleAdminGameOwnerAction 处理撤销归属：POST /api/admin/game-owners/{gameId}/delete。
// 与发放记录的删除路由同一风格。
func (a *App) handleAdminGameOwnerAction(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	parts := pathParts(r.URL.Path, "/api/admin/game-owners/")
	if len(parts) != 2 || parts[1] != "delete" {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
		return
	}
	gameID := strings.TrimSpace(parts[0])
	if gameID == "" {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
		return
	}
	if err := a.removeGameOwner(r.Context(), gameID); err != nil {
		writePayoutError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleAdminSetGameOwner 指定某个 game_id 的归属作者：gameId + 作者邮箱 + 署名。
func (a *App) handleAdminSetGameOwner(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	var input struct {
		GameID     string `json:"gameId"`
		Email      string `json:"email"`
		AuthorName string `json:"authorName"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	owner, err := a.setGameOwner(r.Context(), strings.TrimSpace(input.GameID), input.Email, input.AuthorName, user.Email)
	if err != nil {
		writePayoutError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"owner": owner})
}
