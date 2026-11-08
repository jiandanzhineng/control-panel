# 游戏库页面（PC）

- 页面 `frontend/src/views/PlayLibraryView.vue`，合并/排序/筛选/设备 chips 纯逻辑在 `frontend/src/play/library.ts`（单测 `frontend/tests/library.test.ts`）。卡片样式是 `style.css` 里的全局 `lib-*`，`LocalAppCard.vue` 共用。
- 数据源：`/api/games`（本机）、`/api/game-registry`（在线库，失败时响应带 `error`）、`/api/plugins`、`/api/local-apps`、`/api/game-runtime/games`（远程无延迟标签）。在线库异步合并，不阻塞首屏。
- registry 条目的 i18n 在 `entry.manifest.i18n`，后端 `gameRegistryService.i18nSourceOf` 负责取；manifest 没写 `i18n.en` 的游戏在英文界面仍显示中文。
- 筛选「本机」= 有本机副本，「在线」= 在线库里有，两者可重叠。
- 游戏站（`BrowserView.vue`）：`?url=` 打开指定页；`dom-ready` 时把站点 `localStorage['site-locale']` 同步为客户端语言（仅游戏站 origin）。
- 游戏站能力名翻译：`play-registry/assets/js/i18n.js` 的 `SiteI18n.capLabel`，改站点后需按 [game-platform-deploy](game-platform-deploy.md) 发版才生效。
- 测试游戏：`library.ts` 的 `isTestGame`（manifest `test`/`category:'test'`/`tags` 含 test、`TEST_GAME_IDS`、id 前缀 `qa-`/`zz-`、标题含 联调/测试/QA），只进「测试」tab，不进全部/本机/在线和「继续上次」。
- 页头「投稿游戏」→ 站内游戏站 `submit.html`；「玩法建议」→ 系统浏览器打开商城工单 `https://shop.undersilicon.cn/{zh|en}/profile/feedback/new`（客服页反馈入口同此）。埋点 `library_submit_click` / `library_suggest_click`。
