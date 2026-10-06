package main

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
)

// queryer 由 *sql.DB 和 *sql.Tx 同时满足：归属校验既能在发布事务里跑（硬保证），
// 也能在事务外跑（提前校验、审核后台标记）。
type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// gameIDOwnership 汇总某个 game_id 的归属：是否为官方保留 ID、首位社区作者、当前最新版本。
type gameIDOwnership struct {
	Official      bool
	OwnerAuthorID string
	LatestVersion string
}

const (
	gameIDStatusNew      = "new"
	gameIDStatusOwn      = "own"
	gameIDStatusOfficial = "official"
	gameIDStatusConflict = "conflict"
)

// loadGameIDOwnership 按发布时间从早到晚读取该 game_id 的全部 release（含已下架）。
// 首位带投稿的 release 决定归属；官方 release（submission_id 为空）早于任何社区 release 时该 ID 保留。
func loadGameIDOwnership(ctx context.Context, q queryer, gameID string) (gameIDOwnership, error) {
	rows, err := q.QueryContext(ctx, `SELECT COALESCE(r.submission_id, ''), COALESCE(s.author_id, ''), r.version, r.created_at
		FROM releases r LEFT JOIN submissions s ON s.id = r.submission_id
		WHERE r.game_id = ? ORDER BY r.created_at ASC, r.rowid ASC`, gameID)
	if err != nil {
		return gameIDOwnership{}, err
	}
	defer rows.Close()
	var state gameIDOwnership
	var officialAt, communityAt int64
	hasOfficial := false
	for rows.Next() {
		var submissionID, authorID, version string
		var createdAt int64
		if err := rows.Scan(&submissionID, &authorID, &version, &createdAt); err != nil {
			return gameIDOwnership{}, err
		}
		state.LatestVersion = version
		if submissionID == "" {
			if !hasOfficial {
				hasOfficial, officialAt = true, createdAt
			}
			continue
		}
		if state.OwnerAuthorID == "" {
			state.OwnerAuthorID, communityAt = authorID, createdAt
		}
	}
	if err := rows.Err(); err != nil {
		return gameIDOwnership{}, err
	}
	if hasOfficial && (state.OwnerAuthorID == "" || communityAt > officialAt) {
		state.Official = true
		state.OwnerAuthorID = ""
	}
	return state, nil
}

// checkGameIDOwnership 决定这次投稿能否发布到该 game_id，并在允许时给出提前校验结论。
// 硬校验和提前校验共用同一份判定，避免两处规则漂移。
func (a *App) checkGameIDOwnership(ctx context.Context, q queryer, authorID string, authorIsAdmin bool, gameID, version string) (gameIDOwnership, error) {
	ownership, err := loadGameIDOwnership(ctx, q, gameID)
	if err != nil {
		return ownership, fmt.Errorf("could not verify game id ownership: %w", err)
	}
	switch {
	case ownership.Official:
		if !authorIsAdmin {
			return ownership, fmt.Errorf("游戏 ID %q 为官方游戏保留，只有管理员可以更新", gameID)
		}
	case ownership.OwnerAuthorID == "":
		// 首次发布该 game_id：归当前投稿作者所有。
	case ownership.OwnerAuthorID != authorID:
		return ownership, fmt.Errorf("该游戏 ID 已被占用，请改用其他 id（%s）", gameID)
	default:
		comparison, err := compareVersions(version, ownership.LatestVersion)
		if err != nil {
			return ownership, err
		}
		if comparison <= 0 {
			return ownership, fmt.Errorf("版本号 %s 必须高于该游戏 ID 当前最新版本 %s", version, ownership.LatestVersion)
		}
	}
	return ownership, nil
}

// gameIDStatus 给审核后台用：新游戏、本人更新、ID 冲突、官方保留。
func (a *App) gameIDStatus(ctx context.Context, q queryer, authorID, gameID, version string) string {
	ownership, err := loadGameIDOwnership(ctx, q, gameID)
	if err != nil {
		return gameIDStatusNew
	}
	switch {
	case ownership.Official:
		return gameIDStatusOfficial
	case ownership.OwnerAuthorID == "":
		return gameIDStatusNew
	case ownership.OwnerAuthorID == authorID:
		if ownership.LatestVersion != "" {
			if comparison, err := compareVersions(version, ownership.LatestVersion); err == nil && comparison <= 0 {
				return gameIDStatusConflict
			}
		}
		return gameIDStatusOwn
	default:
		return gameIDStatusConflict
	}
}

// compareVersions 比较 manifest 里的语义化版本；构建元数据（+）按 semver 规范不参与比较。
func compareVersions(left, right string) (int, error) {
	leftParts, err := splitVersion(left)
	if err != nil {
		return 0, err
	}
	rightParts, err := splitVersion(right)
	if err != nil {
		return 0, err
	}
	for index := 0; index < len(leftParts.core); index++ {
		if leftParts.core[index] != rightParts.core[index] {
			if leftParts.core[index] > rightParts.core[index] {
				return 1, nil
			}
			return -1, nil
		}
	}
	if leftParts.pre == rightParts.pre {
		return 0, nil
	}
	if leftParts.pre == "" {
		return 1, nil
	}
	if rightParts.pre == "" {
		return -1, nil
	}
	leftPre, rightPre := strings.Split(leftParts.pre, "."), strings.Split(rightParts.pre, ".")
	for index := 0; index < len(leftPre) && index < len(rightPre); index++ {
		comparison := comparePrereleaseIdentifiers(leftPre[index], rightPre[index])
		if comparison != 0 {
			return comparison, nil
		}
	}
	switch {
	case len(leftPre) > len(rightPre):
		return 1, nil
	case len(leftPre) < len(rightPre):
		return -1, nil
	}
	return 0, nil
}

type versionParts struct {
	core []int64
	pre  string
}

func splitVersion(value string) (versionParts, error) {
	if !semverPattern.MatchString(value) {
		return versionParts{}, fmt.Errorf("version %q is not valid semver", value)
	}
	value = strings.TrimPrefix(value, "v")
	if index := strings.Index(value, "+"); index >= 0 {
		value = value[:index]
	}
	core, prerelease, _ := strings.Cut(value, "-")
	numbers := strings.Split(core, ".")
	parts := versionParts{core: make([]int64, 0, len(numbers))}
	for _, number := range numbers {
		parsed, err := strconv.ParseInt(number, 10, 64)
		if err != nil {
			return versionParts{}, fmt.Errorf("version %q is not valid semver", value)
		}
		parts.core = append(parts.core, parsed)
	}
	parts.pre = prerelease
	return parts, nil
}

func comparePrereleaseIdentifiers(left, right string) int {
	leftNumber, leftErr := strconv.ParseInt(left, 10, 64)
	rightNumber, rightErr := strconv.ParseInt(right, 10, 64)
	switch {
	case leftErr == nil && rightErr == nil:
		if leftNumber == rightNumber {
			return 0
		}
		if leftNumber > rightNumber {
			return 1
		}
		return -1
	case leftErr == nil:
		return -1
	case rightErr == nil:
		return 1
	}
	return strings.Compare(left, right)
}

// submissionArchive 读取投稿源包：ZIP 取私有桶对象，Git 克隆公开仓库。
func (a *App) submissionArchive(ctx context.Context, submission Submission) ([]byte, error) {
	if submission.Kind == "zip" {
		return a.store.Get(ctx, submission.ZipKey, a.config.MaxUploadBytes)
	}
	return a.downloadGitArchive(ctx, submission.GitURL)
}
