# play-registry 升级方案（registry v2 / lint 加强 / 发布可靠性）

## 背景

移动端（control_panel_mobile）正在接入在线游戏列表与离线缓存，方案见
`control_panel_mobile/docs/mobile-online-game-registry-plan.md`。
移动端评审过程中对本仓库做了一轮核查，确认了以下现状：

- registry `schemaVersion: 1`，6 个游戏，均为 `index.html + game.js` 两文件结构。
- 每个条目已有 `packageUrl` / `packageSha256` / `packageSize` / `cacheable`，
  桌面端 `backend/services/gameCacheService.js` 用 zip 整包 + `packageSha256`
  做离线缓存，链路可靠，移动端将照抄该做法。
- 条目里的目录指纹 `sha256`（`fingerprintGame`：逐文件哈希→排序拼接→再哈希）
  实际没有任何消费方用于校验，且算法难以跨端复现。

在此前提下，本仓库存在几个影响客户端（尤其离线场景）可靠性的问题，
需要一轮升级。zip 整包缓存**不依赖**本升级，以下皆为增强项。

## 问题清单

### P0-1 lint 覆盖不全，离线完整性约定形同虚设

`scripts/build-registry.js` 的 `lintResourceRefs` 只用正则
`\b(?:src|href)\s*=\s*"([^"]+)"` 扫描 HTML：

- 只匹配双引号写法，单引号 `src='...'`、无引号 `src=...` 漏检。
- 完全不扫描 game.js：`fetch()`、动态 `import()`、`new Image().src`、
  动态 createElement 拼 URL、CSS `url()` 等运行时引用不受任何约束。

后果：某个游戏在 JS 里动态拉外部资源时，zip 包不含该资源、
`packageSha256` 也覆盖不到，客户端离线缓存后运行会静默网络失败。
当前 6 个游戏恰好无外部依赖，但约定没有强制力。

### P0-2 version 手动维护，存在内容漂移

`version` 写在各游戏 `index.html` 内嵌 manifest 里，构建只校验 semver
合法性，不校验"内容变了必须改 version"。当前 6 个游戏全部是 `2.0.0`。
内容变更但忘改 version 时：`packageUrl`（`<id>-<version>.zip`）不变、
URL 相同但内容不同，叠加 CDN 缓存造成客户端校验失败或反复重装。

### P1-1 zip 包名非内容寻址 + CDN 缓存窗口

部署时 zip 的缓存头是 `public, max-age=300`，包名 `<id>-<version>.zip`。
重新发布同 version 的包后，300 秒窗口内客户端可能拉到旧 zip，
与 registry 里新的 `packageSha256` 不匹配，下载校验失败。

### P1-2 缺少 files[] 逐文件清单

registry 只有聚合的 `size` / `fileCount`，客户端无法做增量下载、
单文件校验或损坏定位。当前两文件结构下影响小，游戏变大后会放大。

### P2-1 目录指纹 sha256 无消费方

条目里的 `sha256`（目录指纹）没有任何客户端使用，算法依赖 Node 的
遍历顺序和路径归一化，跨端复现成本高。保留会误导新客户端拿它做校验。

## 改造方案

### 一、lint 加强（P0）

`lintResourceRefs` 扩展为三层检查，任一命中即构建失败：

1. HTML 属性：正则改为兼容单引号/无引号：
   `\b(?:src|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"'=]+))`，
   规则不变（放行相对路径、`/bridge-api/`、`data:`/`blob:`/`mailto:`）。
2. CSS：扫描 HTML 内 `<style>` 与独立 css 文件中的 `url(...)`，同规则。
3. JS 静态扫描：对 game.js 全文扫描绝对 URL 字面量
   （`https?://`、`//` 开头、`/` 开头且非 `/bridge-api/` 的字符串）。
   白名单机制：确有合法外部调用的游戏，在 manifest 加
   `allowedOrigins: [...]` 显式声明，lint 放行并写入 registry，
   客户端据此决定是否放行网络请求。

JS 扫描是启发式的（拼接构造的 URL 测不出来），定位是"抬高门槛 +
显式声明"，不承诺完备；完备性由客户端运行时兜底监控。

### 二、version 漂移防护（P0）

构建时把每个游戏的目录指纹与"上一次发布的 registry"对比
（CI 里从线上拉 `https://game.undersilicon.cn/registry.json`）：

- 内容指纹变了而 version 没变 → 构建失败，提示先 bump version。
- version 变了而内容没变 → 警告（允许，用于纯元数据修订）。

本地构建无网络时跳过该检查，仅 CI 强制。

### 三、zip 包名内容寻址（P1）

包名改为 `<id>-<version>-<packageSha256 前 8 位>.zip`，
部署缓存头可放宽为 `public, max-age=31536000, immutable`。
registry.json 仍是唯一入口（no-cache），指到哪个包就下哪个包，
彻底消除 300 秒窗口问题。旧命名的包保留一个发布周期后清理。

### 四、schema v2：files[] 逐文件清单（P1）

`schemaVersion` 升到 2，条目新增 `files[]`，v1 字段全部保留：

```json
{
  "schemaVersion": 2,
  "games": [
    {
      "id": "pressure-edging",
      "path": "games/pressure-edging/index.html",
      "packageUrl": "packages/pressure-edging-2.0.0-7ab4f48c.zip",
      "packageSha256": "...",
      "files": [
        { "path": "index.html", "sha256": "...", "size": 1234 },
        { "path": "game.js", "sha256": "...", "size": 5678 }
      ]
    }
  ]
}
```

- `files[].path` 与 zip 内条目一致（以 index.html 为根的相对路径）。
- 数据来源就是 `fingerprintGame` 已经算出的逐文件哈希，改动很小：
  把中间结果输出，而不是只输出聚合值。
- 客户端用途：解压后逐文件校验、损坏定位、未来增量下载。

### 五、目录指纹 sha256 字段处置（P2）

`files[]` 落地后，聚合目录指纹 `sha256` 降级为派生字段：
在 README/schema 注释中明确「校验一律用 packageSha256 或 files[].sha256，
顶层 sha256 仅作变更检测展示」。暂不删除字段，保持 v1 消费方兼容。

## 兼容性

- v1 客户端（现有桌面端、移动端阶段 1-2）只读 v1 字段，
  `schemaVersion` 变为 2 后不受影响（消费方应按"字段存在性"而非
  版本号严格匹配来解析；桌面端 gameRegistryService 需确认这一点）。
- `allowedOrigins` 为新增可选字段，缺省为空数组（禁止外部请求）。
- zip 包名变更对客户端透明（客户端始终从 registry 读 `packageUrl`）。

## 实施排期

1. lint 加强 + version 漂移防护（P0）：0.5-1 天，先行合入。
2. zip 内容寻址 + 缓存头调整（P1）：0.5 天，改 build 脚本 + deploy workflow。
3. schema v2 files[]（P1）：0.5 天，改 build 脚本 + extract.test.js。
4. 文档同步（P2）：docs/contribute.html 补充游戏资源引用规范与
   `allowedOrigins` 用法。

## 测试清单

- 单引号/无引号的根绝对路径引用被 lint 拦截。
- game.js 含 `https://` 字面量且未声明 allowedOrigins 时构建失败。
- 内容变更未 bump version 时 CI 构建失败。
- 生成的 registry 同时含 v1 聚合字段与 files[]，extract.test.js 断言
  files[].path 与 zip entries 一一对应。
- 新包名格式的 packageUrl 可下载且 packageSha256 校验通过。
- 桌面端对 schemaVersion: 2 的 registry 正常加载与缓存安装。


