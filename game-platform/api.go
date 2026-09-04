package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
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
	writeJSON(w, http.StatusOK, map[string]any{"submissions": submissions})
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
