package main

import (
	"context"
	"database/sql"
	"errors"
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

// gameIDOwnership 汇总某个 game_id 的归属：是否为官方保留 ID、归属作者、当前最新版本。
type gameIDOwnership struct {
	Official        bool
	OwnerAuthorID   string
	OwnerAuthorName string
	LatestVersion   string
	// Assigned 表示归属来自 game_owners 的手工指定（优先级最高）。
	Assigned bool
}

// exists 表示该 game_id 已经存在（有 release 或已被指定归属）。
func (o gameIDOwnership) exists() bool {
	return o.LatestVersion != "" || o.OwnerAuthorID != ""
}

const (
	gameIDStatusNew      = "new"
	gameIDStatusOwn      = "own"
	gameIDStatusOfficial = "official"
	gameIDStatusConflict = "conflict"
	// gameIDStatusAdmin 表示管理员更新他人/官方的 game_id：允许发布，但归属不变。
	gameIDStatusAdmin = "admin"
)

// loadGameIDOwnership 判定归属，优先级：game_owners 手工指定 > 最早的社区 release 作者 > 官方保留。
// release 按发布时间从早到晚读取（含已下架）；最早一条是官方 release（submission_id 为空）时该 ID 保留。
func loadGameIDOwnership(ctx context.Context, q queryer, gameID string) (gameIDOwnership, error) {
	rows, err := q.QueryContext(ctx, `SELECT COALESCE(r.submission_id, ''), COALESCE(s.author_id, ''), COALESCE(s.author_name, ''), r.version, r.created_at
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
		var submissionID, authorID, authorName, version string
		var createdAt int64
		if err := rows.Scan(&submissionID, &authorID, &authorName, &version, &createdAt); err != nil {
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
			state.OwnerAuthorID, state.OwnerAuthorName, communityAt = authorID, authorName, createdAt
		}
	}
	if err := rows.Err(); err != nil {
		return gameIDOwnership{}, err
	}
	if hasOfficial && (state.OwnerAuthorID == "" || communityAt > officialAt) {
		state.Official = true
		state.OwnerAuthorID = ""
		state.OwnerAuthorName = ""
	}
	assigned, err := loadAssignedOwner(ctx, q, gameID)
	if err != nil {
		return gameIDOwnership{}, err
	}
	if assigned.AuthorID != "" {
		// 被指定的游戏视为社区游戏：官方保留标记取消，归属以指定为准。
		state.Official = false
		state.OwnerAuthorID = assigned.AuthorID
		state.OwnerAuthorName = assigned.AuthorName
		state.Assigned = true
	}
	return state, nil
}

// assignedOwner 是 game_owners 的一行。
type assignedOwner struct {
	GameID     string `json:"gameId"`
	AuthorID   string `json:"authorId"`
	AuthorName string `json:"authorName"`
	Email      string `json:"email"`
	SetBy      string `json:"setBy"`
	SetAt      int64  `json:"setAt"`
}

// loadAssignedOwner 读 game_owners 里该 game_id 的指定归属；没有则返回零值。
func loadAssignedOwner(ctx context.Context, q queryer, gameID string) (assignedOwner, error) {
	var owner assignedOwner
	err := q.QueryRowContext(ctx, `SELECT game_id, author_id, author_name, set_by, set_at FROM game_owners WHERE game_id = ?`, gameID).
		Scan(&owner.GameID, &owner.AuthorID, &owner.AuthorName, &owner.SetBy, &owner.SetAt)
	if errors.Is(err, sql.ErrNoRows) {
		return assignedOwner{}, nil
	}
	if err != nil {
		return assignedOwner{}, err
	}
	return owner, nil
}

// listAssignedOwners 列出全部手工指定的归属，附作者邮箱。
func (a *App) listAssignedOwners(ctx context.Context) ([]assignedOwner, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT o.game_id, o.author_id, o.author_name, o.set_by, o.set_at, COALESCE(i.email, '')
		FROM game_owners o LEFT JOIN identities i ON i.id = o.author_id
		ORDER BY o.game_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []assignedOwner{}
	for rows.Next() {
		var owner assignedOwner
		if err := rows.Scan(&owner.GameID, &owner.AuthorID, &owner.AuthorName, &owner.SetBy, &owner.SetAt, &owner.Email); err != nil {
			return nil, err
		}
		out = append(out, owner)
	}
	return out, rows.Err()
}

// gameOwner 返回某个 game_id 的归属作者（含邮箱）；没有归属作者时 AuthorID 为空。
// 与发布校验共用同一份判定，避免两处规则漂移。
func (a *App) gameOwner(ctx context.Context, q queryer, gameID string) (assignedOwner, error) {
	ownership, err := loadGameIDOwnership(ctx, q, gameID)
	if err != nil {
		return assignedOwner{}, err
	}
	if ownership.OwnerAuthorID == "" {
		return assignedOwner{}, nil
	}
	owner := assignedOwner{GameID: gameID, AuthorID: ownership.OwnerAuthorID, AuthorName: ownership.OwnerAuthorName}
	// 邮箱只用于展示与商城定位，查不到也不影响归属。
	_ = q.QueryRowContext(ctx, `SELECT email FROM identities WHERE id = ?`, owner.AuthorID).Scan(&owner.Email)
	return owner, nil
}

// requireHigherVersion 校验版本严格升高；该 game_id 还没有 release 时直接通过。
func requireHigherVersion(version string, ownership gameIDOwnership) error {
	if ownership.LatestVersion == "" {
		return nil
	}
	comparison, err := compareVersions(version, ownership.LatestVersion)
	if err != nil {
		return err
	}
	if comparison <= 0 {
		return fmt.Errorf("版本号 %s 必须高于该游戏 ID 当前最新版本 %s", version, ownership.LatestVersion)
	}
	return nil
}

// checkGameIDOwnership 决定这次投稿能否发布到该 game_id，并在允许时给出提前校验结论。
// 硬校验和提前校验共用同一份判定，避免两处规则漂移。
func (a *App) checkGameIDOwnership(ctx context.Context, q queryer, authorID string, authorIsAdmin bool, gameID, version string) (gameIDOwnership, error) {
	ownership, err := loadGameIDOwnership(ctx, q, gameID)
	if err != nil {
		return ownership, fmt.Errorf("could not verify game id ownership: %w", err)
	}
	// 管理员可以给任何已存在的 game_id 发布更新（官方 id、他人的社区游戏、指定归属的
	// 游戏都包括），方便维护团队继续维护已上线的社区游戏；归属不变，版本仍须升高。
	if authorIsAdmin && ownership.exists() {
		return ownership, requireHigherVersion(version, ownership)
	}
	switch {
	case ownership.Official:
		return ownership, fmt.Errorf("游戏 ID %q 为官方游戏保留，只有管理员可以更新", gameID)
	case ownership.OwnerAuthorID == "":
		// 首次发布该 game_id：归当前投稿作者所有。
	case ownership.OwnerAuthorID != authorID:
		return ownership, fmt.Errorf("该游戏 ID 已被占用，请改用其他 id（%s）", gameID)
	default:
		if err := requireHigherVersion(version, ownership); err != nil {
			return ownership, err
		}
	}
	return ownership, nil
}

// gameIDStatus 给审核后台用：新游戏、本人更新、管理员更新、ID 冲突、官方保留。
func (a *App) gameIDStatus(ctx context.Context, q queryer, authorID string, authorIsAdmin bool, gameID, version string) string {
	ownership, err := loadGameIDOwnership(ctx, q, gameID)
	if err != nil {
		return gameIDStatusNew
	}
	if authorIsAdmin && ownership.exists() {
		if ownership.LatestVersion != "" {
			if comparison, err := compareVersions(version, ownership.LatestVersion); err == nil && comparison <= 0 {
				return gameIDStatusConflict
			}
		}
		return gameIDStatusAdmin
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
