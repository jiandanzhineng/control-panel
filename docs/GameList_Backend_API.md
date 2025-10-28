# 游戏列表后端路由 PRD（/api/games）

版本：v1.0  
最近更新：2025-10-27

## 背景与目标
- 与前端《游戏列表（GameList.vue）PRD》对齐，提供后端管理“游戏/玩法”的基础路由：列表、详情、上传、删除、刷新。
- 游戏文件保存在 `backend/game/` 目录（仅保存 JS 文件，不执行）。
- 游戏列表持久化采用 `backend/utils/fileStorage.js`，键名为 `games`（JSON 数组）。

## 范围（Scope）
- 包含：
  - 列出所有游戏（含默认与已上传）
  - 查询单个游戏详情
  - 上传游戏（JS 文件）
  - 删除某个游戏
  - 重新加载（从 `backend/game` 目录重新扫描）
  - 启动游戏（接口占位，暂不实现）
  - 停止当前运行的游戏（接口占位，暂不实现）
- 不含：游戏运行时引擎、设备联动、停止/推送等运行期能力。

## 响应约定
- 成功：直接返回业务数据（对象/数组）。
- 失败：使用统一错误结构（由 `utils/http.sendError` 生成）：
  ```json
  { "error": { "code": "SOME_ERROR_CODE", "message": "描述信息" } }
  ```

## 数据模型
- Game（列表项/详情项）：
  - `id`: string（唯一标识，后端生成，如 `game_<ts>_<rand>`）
  - `name`: string（玩法名称；上传时若无法解析则使用文件名）
  - `description`: string（玩法描述；可空）
  - `status`: string（`stopped | running | finished | idle | error`；默认 `idle`）
  - `arguments`: string（可选启动参数；可空）
  - `configPath`: string（玩法 JS 文件相对路径，如 `backend/game/foo.js`）
  - `requiredDevices`: array（如 `{ logicalId, required, name }`；可空）
  - `version`: string（可空）
  - `author`: string（可空）
  - `createdAt`: number（ms 时间戳；上传/首次发现时间）
  - `lastPlayed`: number（ms 时间戳；启动时更新；当前占位）

- 存储：
  - `fileStorage` 键：`games`
  - 结构：JSON 数组，每项为 `Game`。
  - 刷新（reload）后覆盖写入最新列表。

## 路由定义（基础路径 `/api/games`）

1) 列出所有游戏
- `GET /api/games`
- 行为：
  - 读取 `fileStorage.getItem('games')`。
  - 若为空：返回空数组 `[]`。
- 响应 `200`：`Game[]`
- 错误码：`GAMES_LIST_FAILED`（异常时）。

2) 查询单个游戏
- `GET /api/games/:id`
- 行为：
  - 读取 `games` 列表并按 `id` 查找；不存在则 404。
- 响应 `200`：`Game`
- 错误：
  - `404` + `{ error: { code: 'GAME_NOT_FOUND', message: '游戏不存在' } }`
  - 其他异常：`GAME_DETAIL_FAILED`

3) 启动游戏（占位，待实现）
- `POST /api/games/:id/start`
- 当前行为：
  - 不执行实际启动逻辑，直接返回未实现错误。
- 响应：
  - `501` + `{ error: { code: 'GAME_START_NOT_IMPLEMENTED', message: '启动接口待实现' } }`
- 后续：绑定运行时引擎与设备校验后更新 `status`/`lastPlayed`。

4) 上传游戏（上传一个 JS 文件）
- `POST /api/games/upload`
- 请求：`multipart/form-data`
  - 字段：`file`（必填，单个 `.js` 文件）
- 行为：
  - 校验：仅允许扩展名 `.js`；大小限制与语法校验可后续扩展。
  - 保存：
    - 将文件复制到 `backend/game/`。
    - 若已存在同名文件：覆盖并视为“更新”。
  - 元信息解析（轻量约定）：
    - 尝试从 JS 中读取 `title`。
    - 失败则解析失败。
  - 持久化：
    - 若存在同 `configPath` 或同名 `name` 的游戏项，则更新原条目；否则新增。
    - 更新/新增后写回 `fileStorage('games')`。
- 响应 `200`：`{ ok: true, game: Game }`
- 错误码：
  - `GAME_UPLOAD_FAILED`（保存或解析失败）
  - `GAME_FILE_INVALID`（文件缺失/类型错误）

5) 删除某个游戏
- `DELETE /api/games/:id`
- 行为：
  - 从持久化列表移除该游戏项。
  - 同步处理文件：出于安全与可回滚考虑，默认不删除物理文件，仅移除列表；可选参数 `?removeFile=1` 时同时删除对应 `configPath` 文件。
- 响应 `200`：`{ ok: true }`
- 错误码：
  - `GAME_NOT_FOUND`（不存在）
  - `GAME_DELETE_FAILED`（持久化更新或文件删除失败）

6) 重新加载游戏列表（从目录扫描）
- `POST /api/games/reload`
- 行为：
  - 清空内存中的当前列表（不影响物理文件）。
  - 扫描 `backend/game/*.js`，为每个文件生成 `Game` 条目：
    - `id`: 新生成（或基于文件名的稳定映射）
    - `name`: 从内容尝试解析标题，否则取文件名（不含扩展）
    - `configPath`: 该文件相对路径
    - 其他字段：占位为默认值（`status='idle'`、`createdAt=now`）
  - 将结果覆盖写入 `fileStorage('games')`。
- 响应 `200`：`{ ok: true, count: number }`
- 错误码：`GAMES_RELOAD_FAILED`

7) 停止当前运行的游戏（占位，待实现）
- `POST /api/games/stop-current`
- 行为：
  - 当前不接入运行时引擎；接口作为占位直接返回未实现错误。
  - 后续实现中：如果存在标记为 `status='running'` 的游戏则停止之并更新状态；若无则返回 `NO_GAME_RUNNING`。
- 响应：
  - `501` + `{ error: { code: 'GAME_STOP_NOT_IMPLEMENTED', message: '停止接口待实现' } }`
- 错误码：
  - `NO_GAME_RUNNING`（未来实现时，当没有正在运行的游戏）

## 文件与目录约定
- 游戏文件目录：`backend/game/`
  - 仅 JS 文件；后端不执行脚本（避免安全风险）。
  - JS文件也可以在二级目录中，官方发布的游戏会带有readme文件
- 持久化文件：`backend/data/games.json`（由 `fileStorage('games')` 维护）。

## 错误码约定
- `GAMES_LIST_FAILED`：列表读取失败
- `GAME_DETAIL_FAILED`：详情读取失败
- `GAME_NOT_FOUND`：游戏不存在
- `GAME_UPLOAD_FAILED`：上传或保存失败
- `GAME_FILE_INVALID`：上传文件不合法
- `GAME_DELETE_FAILED`：删除失败
- `GAMES_RELOAD_FAILED`：刷新失败
- `GAME_START_NOT_IMPLEMENTED`：启动接口占位，未实现
- `GAME_STOP_NOT_IMPLEMENTED`：停止当前运行游戏接口占位，未实现
- `NO_GAME_RUNNING`：没有找到正在运行的游戏（未来实现时使用）

## 安全与后续
- 上传的 JS 会在需要时在后端执行。
- 后续若需执行，不考虑安全性、直接加载到后端执行。

## 验收标准（与前端 PRD 对齐）
- 列表接口 `GET /api/games` 能返回空数组或已保存项。
- 详情接口能正确返回或在不存在时返回 404 错误结构。
- 上传接口在提供合法 `.js` 时返回 `ok: true`，持久化更新生效；非法文件返回统一错误结构。
- 删除接口能移除持久化条目；可选删除文件时物理文件被移除（有权限前提）。
- 重新加载接口能统计 `backend/game` 中文件数量并覆盖持久化列表。
- 启动接口当前返回 `501` 未实现错误，供前端占位处理。
- 停止接口当前返回 `501` 未实现错误，供前端占位处理。