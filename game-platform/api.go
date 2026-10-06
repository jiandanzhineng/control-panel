package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.handleHealth)
	mux.HandleFunc("GET /api/auth/me", a.handleMe)
	mux.HandleFunc("GET /api/submissions", a.handleSubmissions)
	mux.HandleFunc("POST /api/submissions", a.handleCreateSubmission)
	mux.HandleFunc("POST /api/submissions/", a.handleSubmissionAction)
	mux.HandleFunc("POST /api/admin/submissions/", a.handleAdminSubmissionAction)
	mux.HandleFunc("GET /api/admin/submissions/", a.handleAdminSubmissionSource)
	mux.HandleFunc("GET /api/admin/submissions", a.handleAdminSubmissions)
	mux.HandleFunc("POST /api/admin/registry/import", a.handleAdminImportRegistry)
	mux.HandleFunc("POST /api/admin/registry/rebuild", a.handleAdminRebuildRegistry)
	mux.HandleFunc("GET /api/admin/releases", a.handleAdminReleases)
	mux.HandleFunc("POST /api/admin/releases/", a.handleAdminReleaseAction)
	mux.HandleFunc("GET /api/admin/payouts/", a.handleAdminPayouts)
	mux.HandleFunc("POST /api/admin/payouts/", a.handleAdminPayoutAction)
	mux.HandleFunc("GET /api/payouts/mine", a.handleMyPayouts)
	return a.withCORS(mux)
}

func (a *App) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		allowed := origin != "" && a.isAllowedOrigin(origin)
		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			if !allowed {
				writeError(w, http.StatusForbidden, "ORIGIN_NOT_ALLOWED", "origin is not allowed")
				return
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions && origin != "" && !allowed {
			writeError(w, http.StatusForbidden, "ORIGIN_NOT_ALLOWED", "origin is not allowed")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) isAllowedOrigin(origin string) bool {
	for _, allowed := range a.config.PublicSiteOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}

func (a *App) currentUser(r *http.Request) (User, error) {
	user, err := a.identity.currentUser(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		return User{}, err
	}
	if err := a.syncIdentity(r.Context(), user); err != nil {
		return User{}, fmt.Errorf("sync mobile identity: %w", err)
	}
	return user, nil
}

func (a *App) requireUser(w http.ResponseWriter, r *http.Request) (User, bool) {
	user, err := a.currentUser(r)
	if err != nil {
		if errors.Is(err, errIdentityUnauthenticated) {
			writeError(w, http.StatusUnauthorized, "AUTH_REQUIRED", "please sign in with your mobile account")
		} else {
			writeError(w, http.StatusServiceUnavailable, "IDENTITY_UNAVAILABLE", "mobile identity service is unavailable")
		}
		return User{}, false
	}
	return user, true
}

func requireAdmin(w http.ResponseWriter, user User) bool {
	if user.Role != "admin" {
		writeError(w, http.StatusForbidden, "ADMIN_REQUIRED", "admin role required")
		return false
	}
	return true
}

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := a.db.PingContext(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "DATABASE_UNAVAILABLE", "database is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *App) handleMe(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (a *App) handleSubmissions(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	submissions, err := a.listSubmissions(r.Context(), user.ID, "", false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "SUBMISSIONS_FAILED", "could not list submissions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"submissions": submissions})
}

func (a *App) handleCreateSubmission(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var input struct {
		AuthorName  string `json:"authorName"`
		Title       string `json:"title"`
		Description string `json:"description"`
		Kind        string `json:"kind"`
		GitURL      string `json:"gitUrl"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	submission, err := a.createSubmission(r.Context(), user, input.AuthorName, input.Title, input.Description, input.Kind, input.GitURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, "SUBMISSION_INVALID", err.Error())
		return
	}
	response := map[string]any{"submission": submission}
	if submission.Kind == "zip" {
		upload, err := a.store.DirectUpload(submission.ZipKey, a.config.MaxUploadBytes, time.Now().Add(a.config.UploadExpiry))
		if err != nil {
			writeError(w, http.StatusInternalServerError, "UPLOAD_AUTH_FAILED", "could not create upload authorization")
			return
		}
		response["upload"] = upload
	}
	writeJSON(w, http.StatusCreated, response)
}

func (a *App) handleSubmissionAction(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	parts := pathParts(r.URL.Path, "/api/submissions/")
	if len(parts) != 2 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
		return
	}
	submission, err := a.submissionByID(r.Context(), parts[0])
	if err != nil || a.assertSubmissionOwner(submission, user) != nil {
		writeError(w, http.StatusNotFound, "SUBMISSION_NOT_FOUND", "submission not found")
		return
	}
	switch parts[1] {
	case "update":
		var input struct {
			AuthorName  string `json:"authorName"`
			Title       string `json:"title"`
			Description string `json:"description"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		if strings.TrimSpace(input.Title) == "" || len([]rune(input.Title)) > 100 {
			writeError(w, http.StatusBadRequest, "SUBMISSION_INVALID", "title is required")
			return
		}
		_, err = a.db.ExecContext(r.Context(), `UPDATE submissions SET author_name = ?, title = ?, description = ?, status = 'pending', review_note = '', reviewed_by = NULL, updated_at = ? WHERE id = ? AND author_id = ? AND status IN ('published','changes_requested','rejected')`, strings.TrimSpace(input.AuthorName), strings.TrimSpace(input.Title), strings.TrimSpace(input.Description), nowUnix(), submission.ID, user.ID)
		if err != nil {
			writeError(w, http.StatusBadRequest, "UPDATE_FAILED", "could not update submission")
			return
		}
		submission, err = a.submissionByID(r.Context(), submission.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "UPDATE_FAILED", "could not read submission")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"submission": submission})
	case "complete":
		submission, err = a.completeZipSubmission(r.Context(), submission)
		if err != nil {
			writeError(w, http.StatusBadRequest, "COMPLETE_FAILED", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"submission": submission})
	case "local-upload":
		if a.config.StorageDriver != "filesystem" || submission.Kind != "zip" || submission.Status != "draft" {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
			return
		}
		a.handleLocalUpload(w, r, submission)
	default:
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
	}
}

func (a *App) handleLocalUpload(w http.ResponseWriter, r *http.Request, submission Submission) {
	r.Body = http.MaxBytesReader(w, r.Body, a.config.MaxUploadBytes+1024)
	if err := r.ParseMultipartForm(a.config.MaxUploadBytes + 1024); err != nil {
		writeError(w, http.StatusBadRequest, "UPLOAD_INVALID", "zip exceeds maximum size")
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "UPLOAD_INVALID", "zip file is required")
		return
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, a.config.MaxUploadBytes+1))
	if err != nil || int64(len(body)) > a.config.MaxUploadBytes {
		writeError(w, http.StatusBadRequest, "UPLOAD_INVALID", "zip exceeds maximum size")
		return
	}
	if err := a.store.Put(r.Context(), submission.ZipKey, body, "application/zip"); err != nil {
		writeError(w, http.StatusInternalServerError, "UPLOAD_FAILED", "could not save zip")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *App) handleAdminSubmissions(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	submissions, err := a.listSubmissions(r.Context(), "", strings.TrimSpace(r.URL.Query().Get("status")), true)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "SUBMISSIONS_FAILED", "could not list submissions")
		return
	}
	a.annotateGameID(r.Context(), submissions)
	writeJSON(w, http.StatusOK, map[string]any{"submissions": submissions})
}

// annotateGameID 给待审投稿补上 manifest 里的 game_id 与归属状态，供审核后台显示标记。
// 只读 ZIP 投稿：源包在私有桶里，读取便宜；Git 投稿要现场克隆，不在这里做。
func (a *App) annotateGameID(ctx context.Context, submissions []Submission) {
	for index := range submissions {
		if submissions[index].Status != "pending" || submissions[index].Kind != "zip" || submissions[index].ZipKey == "" {
			continue
		}
		source, err := a.store.Get(ctx, submissions[index].ZipKey, a.config.MaxUploadBytes)
		if err != nil {
			continue
		}
		game, err := prepareGameArchive(source, a.config)
		if err != nil {
			continue
		}
		submissions[index].GameID = game.ID
		submissions[index].GameIDStatus = a.gameIDStatus(ctx, a.db, submissions[index].UserID, game.ID, game.Version)
	}
}

func (a *App) handleAdminSubmissionAction(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	parts := pathParts(r.URL.Path, "/api/admin/submissions/")
	if len(parts) != 2 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
		return
	}
	submission, err := a.submissionByID(r.Context(), parts[0])
	if err != nil {
		writeError(w, http.StatusNotFound, "SUBMISSION_NOT_FOUND", "submission not found")
		return
	}
	switch parts[1] {
	case "review":
		var input struct {
			Status string `json:"status"`
			Note   string `json:"note"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		submission, err = a.reviewSubmission(r.Context(), submission, user, input.Status, input.Note)
		if err != nil {
			writeError(w, http.StatusBadRequest, "REVIEW_FAILED", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"submission": submission})
	case "publish":
		entry, err := a.publishSubmission(r.Context(), submission, user)
		if err != nil {
			writeError(w, http.StatusBadRequest, "PUBLISH_FAILED", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"entry": entry})
	default:
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
	}
}

func (a *App) handleAdminSubmissionSource(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	parts := pathParts(r.URL.Path, "/api/admin/submissions/")
	if len(parts) != 2 || parts[1] != "source" {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
		return
	}
	submission, err := a.submissionByID(r.Context(), parts[0])
	if err != nil || submission.Kind != "zip" || submission.ZipKey == "" {
		writeError(w, http.StatusNotFound, "SUBMISSION_NOT_FOUND", "submission not found")
		return
	}
	body, err := a.store.Get(r.Context(), submission.ZipKey, a.config.MaxUploadBytes)
	if err != nil {
		writeError(w, http.StatusNotFound, "SOURCE_NOT_FOUND", "source archive was not found")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+submission.ID+".zip\"")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (a *App) handleAdminImportRegistry(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	count, err := a.importExistingRegistry(r.Context())
	if err != nil {
		writeError(w, http.StatusBadRequest, "IMPORT_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"imported": count})
}

func (a *App) handleAdminRebuildRegistry(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	if err := a.rebuildRegistry(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "REGISTRY_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *App) handleAdminReleases(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	releases, err := a.listActiveReleases(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "RELEASES_FAILED", "could not list published games")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"releases": releases})
}

func (a *App) handleAdminReleaseAction(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	parts := pathParts(r.URL.Path, "/api/admin/releases/")
	if len(parts) != 2 || parts[1] != "revoke" {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
		return
	}
	if err := a.revokeRelease(r.Context(), parts[0]); err != nil {
		writeError(w, http.StatusBadRequest, "REVOKE_FAILED", "game is not published")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// payoutPathParts 解析 /api/admin/payouts/ 之后的部分：
// ["2026-09"], ["2026-09", "game-id"], ["2026-09.csv"], ["2026-09", "game-id", "mark"]。
func payoutPathParts(path string) []string {
	rest := strings.Trim(strings.TrimPrefix(path, "/api/admin/payouts/"), "/")
	if rest == "" || strings.Contains(rest, "//") {
		return nil
	}
	parts := strings.Split(rest, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil
		}
	}
	return parts
}

// handleAdminPayouts 处理报表查询与 CSV 导出。
func (a *App) handleAdminPayouts(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	parts := payoutPathParts(r.URL.Path)
	if len(parts) != 1 {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
		return
	}
	month, csvExport := strings.TrimSuffix(parts[0], ".csv"), strings.HasSuffix(parts[0], ".csv")
	if _, _, err := payoutMonthRange(month, time.UTC); err != nil {
		writeError(w, http.StatusBadRequest, "PAYOUT_MONTH_INVALID", "month must use the YYYY-MM format")
		return
	}
	reports, err := a.listPayoutReports(r.Context(), month, "")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PAYOUT_LIST_FAILED", "could not load payout reports")
		return
	}
	if csvExport {
		reports, err = a.attachAuthorEmails(r.Context(), reports)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "PAYOUT_LIST_FAILED", "could not load author emails")
			return
		}
		a.writePayoutCSV(w, reports)
		return
	}
	reports, err = a.attachAuthorEmails(r.Context(), reports)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PAYOUT_LIST_FAILED", "could not load author emails")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"month":   month,
		"reports": reports,
		"thresholds": PayoutThresholds{
			MinDurationMS:  a.config.Payout.MinDurationMS,
			MinDeviceCount: a.config.Payout.MinDeviceCount,
			MinValidPlays:  a.config.Payout.MinValidPlays,
		},
		"openpanelConfigured": a.openpanel.configured(),
	})
}

// handleAdminPayoutAction 处理生成报表与逐行标记。
func (a *App) handleAdminPayoutAction(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok || !requireAdmin(w, user) {
		return
	}
	parts := payoutPathParts(r.URL.Path)
	if len(parts) == 2 && parts[1] == "generate" {
		a.handleGeneratePayouts(w, r, parts[0])
		return
	}
	if len(parts) == 3 && parts[2] == "mark" {
		a.handleMarkPayout(w, r, parts[0], parts[1], user)
		return
	}
	writeError(w, http.StatusNotFound, "NOT_FOUND", "not found")
}

func (a *App) handleGeneratePayouts(w http.ResponseWriter, r *http.Request, month string) {
	location, err := time.LoadLocation(a.config.Payout.Timezone)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PAYOUT_TIMEZONE_INVALID", "payout time zone is invalid")
		return
	}
	if _, _, err := payoutMonthRange(month, location); err != nil {
		writeError(w, http.StatusBadRequest, "PAYOUT_MONTH_INVALID", "month must use the YYYY-MM format")
		return
	}
	var input struct {
		BonusPoolCNY   *int64 `json:"bonusPoolCny"`
		MinDurationMS  *int64 `json:"minDurationMs"`
		MinDeviceCount *int   `json:"minDeviceCount"`
		MinValidPlays  *int   `json:"minValidPlays"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	pool := a.config.Payout.BonusPoolCNY
	if input.BonusPoolCNY != nil {
		pool = *input.BonusPoolCNY
	}
	if pool < 0 || pool > 100000000 {
		writeError(w, http.StatusBadRequest, "PAYOUT_POOL_INVALID", "bonus pool must be between 0 and 100000000 CNY")
		return
	}
	thresholds := PayoutThresholds{
		MinDurationMS:  a.config.Payout.MinDurationMS,
		MinDeviceCount: a.config.Payout.MinDeviceCount,
		MinValidPlays:  a.config.Payout.MinValidPlays,
	}
	if input.MinDurationMS != nil {
		thresholds.MinDurationMS = *input.MinDurationMS
	}
	if input.MinDeviceCount != nil {
		thresholds.MinDeviceCount = *input.MinDeviceCount
	}
	if input.MinValidPlays != nil {
		thresholds.MinValidPlays = *input.MinValidPlays
	}
	if thresholds.MinDurationMS < 0 || thresholds.MinDeviceCount < 0 || thresholds.MinValidPlays < 0 {
		writeError(w, http.StatusBadRequest, "PAYOUT_THRESHOLD_INVALID", "thresholds cannot be negative")
		return
	}
	if !a.openpanel.configured() {
		writeError(w, http.StatusServiceUnavailable, "OPENPANEL_NOT_CONFIGURED", "OpenPanel read client is not configured; set GAME_PLATFORM_OPENPANEL_*_CLIENT_SECRET")
		return
	}
	reports, err := a.generatePayoutReports(r.Context(), month, pool, thresholds)
	if err != nil {
		writeError(w, http.StatusBadGateway, "PAYOUT_GENERATE_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"month": month, "reports": reports})
}

func (a *App) handleMarkPayout(w http.ResponseWriter, r *http.Request, month, gameID string, user User) {
	if _, _, err := payoutMonthRange(month, time.UTC); err != nil {
		writeError(w, http.StatusBadRequest, "PAYOUT_MONTH_INVALID", "month must use the YYYY-MM format")
		return
	}
	var input struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	report, err := a.markPayoutReport(r.Context(), month, gameID, strings.TrimSpace(input.Status), input.Note, user.Email)
	if err != nil {
		if errors.Is(err, errPayoutRowMissing) {
			writeError(w, http.StatusNotFound, "PAYOUT_ROW_NOT_FOUND", "payout row not found")
			return
		}
		writeError(w, http.StatusBadRequest, "PAYOUT_MARK_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"report": report})
}

// handleMyPayouts 只返回当前账号自己游戏的报表行。
func (a *App) handleMyPayouts(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	month := strings.TrimSpace(r.URL.Query().Get("month"))
	if month != "" {
		if _, _, err := payoutMonthRange(month, time.UTC); err != nil {
			writeError(w, http.StatusBadRequest, "PAYOUT_MONTH_INVALID", "month must use the YYYY-MM format")
			return
		}
	}
	reports, err := a.listPayoutReports(r.Context(), month, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "PAYOUT_LIST_FAILED", "could not load payout reports")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reports": reports})
}

// writePayoutCSV 导出报表。带 UTF-8 BOM，Excel 打开中文不乱码。
func (a *App) writePayoutCSV(w http.ResponseWriter, reports []PayoutReport) {
	records := [][]string{{"月份", "游戏 ID", "作者", "作者账号 ID", "作者邮箱", "有效游玩", "独立设备", "总时长(分钟)", "金额(元)", "状态", "标记时间", "操作人", "备注"}}
	statusNames := map[string]string{"draft": "待发放", "paid": "已发放", "skipped": "已跳过"}
	for _, report := range reports {
		markedAt := ""
		if report.PaidAt > 0 {
			markedAt = time.Unix(report.PaidAt, 0).In(time.FixedZone("CST", 8*3600)).Format("2006-01-02 15:04")
		}
		records = append(records, []string{
			report.Month, report.GameID, report.AuthorName, report.AuthorID, report.AuthorEmail,
			strconv.Itoa(report.ValidPlays), strconv.Itoa(report.UniqueDevices),
			strconv.FormatFloat(report.TotalMinutes, 'f', 1, 64), strconv.FormatInt(report.AmountCNY, 10),
			statusNames[report.Status], markedAt, report.PaidBy, report.Note,
		})
	}
	var buffer strings.Builder
	buffer.WriteString("\ufeff")
	writer := csv.NewWriter(&buffer)
	_ = writer.WriteAll(records)
	writer.Flush()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=\"payouts.csv\"")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(buffer.String()))
}

func pathParts(value, prefix string) []string {
	rest := strings.Trim(strings.TrimPrefix(value, prefix), "/")
	if rest == "" || strings.Contains(rest, "//") {
		return nil
	}
	return strings.Split(rest, "/")
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 128*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "request body is invalid")
		return false
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", "request body must contain one object")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
