# 默认游戏与在线游戏中心目录设计

## 目标

默认游戏只维护一份，同时保留网站后续作为在线游戏中心扩展新游戏的能力。

## 决策

采用双目录合并模型：

```text
backend/games/<game-id>/          # 默认内置游戏，本地安装包直接使用
play-registry/games/<game-id>/    # 网站额外游戏，只随在线游戏中心发布
```

`play-registry` 仍是在线游戏中心网站源码目录，不改名。CI 中出现的 `site/` 只是临时发布产物目录，类似 `dist/`，不作为源码维护。

## 目录职责

`backend/games` 是默认游戏库。当前已有 HTML 游戏迁入这里，Electron 安装包通过现有 `backend/**/*` 打包规则包含这些文件，本地端继续通过 `/games/<id>/index.html` 直接启动。

`play-registry/games` 是网站扩展游戏库。以后在线游戏中心新增但不想内置到客户端的游戏放这里。

两个目录都使用同一套 `game-manifest` 格式。游戏 ID 必须全局唯一；如果两个目录出现相同 ID，构建直接失败。

## 构建

`play-registry/scripts/build-registry.js` 扫描两个源：

```text
backend/games       -> source: builtin
play-registry/games -> source: online
```

输出仍保持：

```text
play-registry/registry.json
play-registry/packages/*.zip
```

registry 中的游戏路径保持线上兼容：

```json
{
  "path": "games/<game-id>/index.html",
  "cacheable": true
}
```

每个游戏包仍从对应游戏目录完整打包，zip 内部以 `index.html` 为根。

## 发布

workflow 组装临时 `site/` 目录：

```text
site/
  index.html
  play.html
  assets/
  docs/
  games/
    <backend 默认游戏>
    <play-registry 网站扩展游戏>
  packages/
  registry.json
```

组装规则按目录复制，不再靠逐个文件白名单维护。上传时继续最后上传 `registry.json`，避免列表先暴露但资源尚未就位。

## 运行兼容

本地“本地游戏”只扫描 `backend/games`，所以默认游戏安装后离线可玩。

在线游戏中心读取合并后的 registry，默认游戏和网站扩展游戏在同一个列表里展示。默认游戏如果本地已经存在，启动时优先走本地 `/games/<id>/index.html`；网站扩展游戏如果被缓存，则走 `/games/cache/<id>/<version>/index.html`。

已玩记录、设备映射、参数和缓存状态继续按 `id` 合并。默认游戏迁到 `backend/games` 后，旧记录不会产生第二个同名游戏。

## 迁移

当前 `play-registry/games` 中的已有默认游戏迁到 `backend/games`。

迁移后 `play-registry/games` 保留为空目录或只放网站扩展游戏。默认游戏后续只改 `backend/games`。

## 测试

后端：

- `gameService.scanHtmlGames()` 能扫到 `backend/games`。
- `/api/games` 返回默认游戏，`source` 为 `builtin`。

play-registry：

- build 同时扫描 `backend/games` 和 `play-registry/games`。
- 两边游戏 ID 冲突时构建失败。
- registry 路径保持 `games/<id>/index.html`。
- `packages/*.zip` 包含对应游戏目录的完整文件。

workflow：

- `site/` 包含网站壳、默认游戏、网站扩展游戏、packages 和 registry。
- `registry.json` 仍最后上传。

最终验证命令：

```text
npm --prefix backend test -- --runInBand
npm --prefix play-registry run build
npm --prefix play-registry test
npm run build:frontend
```

## 非目标

本设计不把网站项目从 `play-registry` 改名。

本设计不迁移 `backend/game` 下的旧文档或参考材料。

本设计不改变在线游戏缓存的落盘目录和安装逻辑。
