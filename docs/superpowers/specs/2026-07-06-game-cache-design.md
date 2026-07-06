# 在线游戏本体缓存设计

## 背景

当前在线玩法只缓存两类数据：

- `game-registry-cache.json`: 在线游戏列表。
- `games.json`: 玩过的游戏记录、设备映射、参数。

游戏本体仍通过 `/games/proxy/...` 实时从线上加载。目标是把真正的游戏文件缓存到本机，安装后可从本地启动。

## 决策

采用“完整 zip 包缓存”。

- 只有提供完整包的在线玩法才允许缓存。
- 普通外部 URL 玩法仍可在线玩，但不做离线缓存。
- 客户端只下载包，不爬网页资源。

## 发布端

`play-registry/scripts/build-registry.js` 生成：

```text
registry.json
packages/<id>-<version>.zip
```

zip 内容是单个游戏目录的完整文件，zip 内部直接以 `index.html` 为根：

```text
index.html
game.js
assets/...
```

`registry.json` 条目新增字段：

```json
{
  "packageUrl": "packages/pressure-edging-v2-2.0.0.zip",
  "packageSha256": "...",
  "packageSize": 12345,
  "cacheable": true
}
```

workflow 发布 `play-registry/` 静态产物时包含 `packages/**`，并继续排除 `scripts/**`、`test/**`、`node_modules/**`、包管理文件和 README。

## 客户端缓存

新增后端模块 `gameCacheService`，作为游戏本体缓存的唯一入口。

落盘路径：

```text
%APPDATA%\UnderSilicon\data\game-cache\<gameId>\<version>\
```

临时路径：

```text
%APPDATA%\UnderSilicon\data\game-cache-tmp\<installId>\
```

缓存命中条件：

```text
gameId + version + packageSha256 全部一致
```

缓存目录包含：

```text
index.html
game.js
...
.cache-meta.json
```

`.cache-meta.json` 记录 `id`、`version`、`packageSha256`、`packageUrl`、`installedAt`。

## 路由

新增接口：

```text
GET    /api/game-cache/status/:id
POST   /api/game-cache/install/:id
DELETE /api/game-cache/:id/:version
```

`POST /api/game-cache/install/:id` 流程：

1. 从 `gameRegistryService.getGameById(id)` 读取条目。
2. 要求存在 `packageUrl` 和 `packageSha256`。
3. 已命中缓存时直接返回。
4. 下载 zip 到临时目录。
5. 校验 zip sha256。
6. 安全解压，禁止路径穿越。
7. 校验 `index.html` 和 `game-manifest`。
8. 校验 manifest 的 `id`、`version` 与 registry 一致。
9. 写 `.cache-meta.json`。
10. 原子移动到缓存目录。
11. 返回 `localGamePath`。

新增静态路由：

```text
/games/cache/:id/:version/index.html
```

用于 serve 已安装缓存游戏。

## 前端流程

在线游戏列表显示缓存状态：

- `可缓存`
- `已缓存`
- `有更新`
- `仅在线`

启动在线游戏时：

1. 若 `cacheable=true`，先调用 `POST /api/game-cache/install/:id`。
2. 安装成功后把 `gamePath` 替换为 `localGamePath`。
3. 继续走现有设备选择、设备映射和启动流程。
4. 若 `cacheable=false`，继续走远程代理路径，不显示离线能力。

已玩记录继续写 `/api/games/played`，但保存本地路径：

```json
{
  "gamePath": "/games/cache/foo/1.0.0/index.html",
  "externalUrl": "https://game.undersilicon.cn/games/foo/index.html",
  "origin": "remote",
  "cached": true
}
```

如果缓存被删除，详情页回退到 registry 并重新安装。

## 失败处理

- 下载失败：保留旧缓存，提示可继续在线玩。
- sha256 不匹配：删除临时目录，禁止使用该包。
- zip 路径穿越：删除临时目录，禁止安装。
- manifest 不匹配：删除临时目录，禁止安装。
- 磁盘空间不足：删除临时目录，提示清理空间。
- 新版本安装失败：旧版本继续可用。

## 测试

后端测试：

- 已缓存命中不重复下载。
- sha256 不匹配失败。
- zip 路径穿越失败。
- 缺少 `index.html` 失败。
- manifest id/version 不匹配失败。
- 安装成功返回 `/games/cache/<id>/<version>/index.html`。
- 删除缓存后状态变为未安装。

发布端测试：

- build 生成 `packages/*.zip`。
- registry 包含 `packageUrl`、`packageSha256`、`packageSize`、`cacheable`。
- zip 解开后包含完整游戏文件。
- 新增任意资源文件会自动进 zip。

前端验证：

- 在线列表显示缓存状态。
- 首次启动下载安装到本地。
- 二次启动直接命中本地缓存。
- 断网时已缓存游戏可启动。
- 未提供包的外部玩法只能在线玩。
