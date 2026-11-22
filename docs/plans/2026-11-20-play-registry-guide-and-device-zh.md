# 玩法库（游戏站）导购补齐与设备页中文化 — 实施计划

> 本计划已按评审意见修订。**阶段 0 已由主代理完成**（QTZ / PJ01 已上架商城），阶段 1~4 待实施。
> 拆成两个独立 PR：**PR-A 导购**（阶段 1~3）与 **PR-B 中文化**（阶段 4），两者无依赖，可并行或分别合并。

## 进度表

| 日期 | 阶段 | 状态 | 说明 |
| :--- | :--- | :--- | :--- |
| 2026-11-20 | 现状调研与初版方案 | 已完成 | `control-panel`、`ezs-docs`、`shop` 三仓盘点 |
| 2026-11-20 | 评审修订 | 已完成 | 见下「评审结论」6 条 |
| 2026-11-20 | 阶段 0：QTZ / PJ01 上架商城 | **已完成** | `distance-sensor`、`reciprocating-motor` 已上线，三方对账通过 |
| 2026-11-20 | 阶段 1：站点级硬件映射数据 | 已上线（#15） | 新增 `game-hardware.json` + 商品快照同步脚本 |
| 2026-11-20 | 阶段 2：游戏 Manifest 补 `howTo` | 已合并（#15、#16）；线上 registry 仍是旧版，需经投稿平台重新发布内置游戏才生效 | 9 个玩法 + `device-control` 的中英 `howTo`，递增版本号 |
| 2026-11-20 | 阶段 3：游戏站导购与缺设备引导 | 已上线（#15） | 介绍页、列表页、启动弹窗、顶栏页脚 |
| 2026-11-20 | 阶段 4：游戏站设备页补中文 | 站点已上线（#16）；控制面板侧随下个客户端版本发布 | `devices.html`、`control.html`、`games/device-control` |

---

## 评审结论（本次修订依据）

1. **QTZ / PJ01 改为商城上架，不走淘宝**。原方案让游戏站跳 `ezs-docs` 设备页再跳淘宝，会丢掉商城的推广来源与分成链路：`?ref=` 是由 `shop/src/middleware.ts` 写进 `shop_promo_ref` cookie、结算时按优惠码归因的；docs 站是静态 Docusaurus，不消费 `?ref=`，跳淘宝后 cookie 和归因全部归零。**已上架，见阶段 0。**
2. **`hardware` 不进游戏 manifest**。游戏包带版本号、指纹、打 zip 分发给 PC/手机端；商城 slug 写进 manifest 意味着商品改名就要动 10 个游戏、递增 10 个版本、重打 10 个包。商业目录与游戏内容的变更频率不是一个量级。改为站点级数据文件。`howTo` 仍留 manifest（游戏内容，要走 i18n）。
3. **商品快照不手抄**。`ezs-docs` 已有 `tool/sync-shop-products.mjs`（拉 `/api/products`）+ `check-shop-products.mjs` CI 校验；play-registry 照搬同一套，不要第三份手抄且无人看守的数据。
4. **遥测字段字典已存在**。`backend/devices/monitorSpec.js` 已有中文名**带单位**（`pressure` 压力 kPa、`pressure1` 踮脚压力、`weight` 重量 g、`distance` 距离 mm、`button0` 脚踏1、`heart_rate` 心率 bpm、`battery` 电量 %）。不要另造一套叫法，也不要丢掉单位。
5. **`devices.html` 不做整页双语**。`docs/` 下 5 个开发文档都只有导航栏 13~15 个 `data-i18n`、正文全中文；只给它接正文双语会成为唯一的双语开发文档，而 `sphincterPressure` 这类是开发者要照抄的标识符，不是该翻译的文案。
6. **拆 PR、截图取样**。阶段 4 与阶段 1~3 无依赖；9 个玩法 × 中英 + 设备页共 20 多页截图太重，改为代表性取样 + 单测断言。

### 对原方案的事实修正

- `devices.html` 的「能力总表」**已有中文「名称」列**，裸 key 只存在于「设备类型清单」的「能力集」列。
- 缺的设备不只 `DAN01`：`attitude` 能力（monitorSpec 有四元数/加速度/角速度/磁场/温度/高度）与品牌设备的 `vibration`、`suction`、`estim` 都不在表里。

---

## 阶段 0（已完成）：QTZ / PJ01 上架商城

淘宝自家店（简单物联）实读价：两件都是 ¥149 起，加配版 ¥169。

| 商品 | slug | 分类 | 变体 | 价格 | 云仓 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| QTZ 距离感应终端 | `distance-sensor` | smart-equipment | `qtz` 单机 | ¥149 / $29.80 | 编码 `qtz`，已入仓 |
| PJ01 往复电机控制器 | `reciprocating-motor` | smart-equipment | `pj01` 仅主机（不含电源） | ¥149 / $29.80 | 未入仓，同 `dzc01` 先例自发货 |

- 上架脚本：`shop/scripts/list-qtz-pj01.mjs`（复用 `list-supply-skus.mjs` 的 POW+登录+上传流程，凭据运行时读取，不落盘）。
- supply 侧 `skus/sku-11`、`sku-13` 已补 `external.shop` 绑定、`status: active`、PJ01 补 `price_cny: 149`；`verify-sku-coverage.mjs` 三方一致（Shop 变体 21 → 23）。
- `ezs-docs/src/data/shop-products.json` 已 `npm run sync:shop-products`（19 个商品）。
- **未上架的加配档**：QTZ「单机加两个脚踏板」¥169、PJ01「包含电源」¥169。两者无独立云仓编码和本地 SKU，补 SKU 主数据后才能加变体，否则 `verify-sku-coverage.mjs` 第 5 项会报「Shop 变体缺本地绑定」。

---

# PR-A：导购补齐（阶段 1~3，只动 `control-panel/play-registry`）

## 阶段 1：站点级商品与硬件映射数据

1. **商品快照同步脚本** `play-registry/scripts/sync-shop-products.js`：
   - 照搬 `ezs-docs/tool/sync-shop-products.mjs`：拉 `https://shop.undersilicon.cn/api/products?locale=zh` 与 `?locale=en`，只取 `slug` / `nameZh` / `nameEn` / `image`（绝对地址），**不写价格**，输出 `play-registry/assets/data/shop-products.json`。
   - 配套 `scripts/check-shop-products.js`：校验 `game-hardware.json` 引用的每个 slug 都在快照里，有未知 slug 则退出码 1。挂进 `npm run build:site` 前置。
   - 缩略图直接用快照里的 `uploads/` 绝对地址（同 ezs-docs 现状）。**不要**用 `/_next/image?url=...`，商城的 `images.remotePatterns` 未验证允许外站取图。
2. **硬件映射数据** `play-registry/assets/data/game-hardware.json`：
   - 结构 `{ "<gameId>": { summary, summaryEn, docPath, items: [{ slug, role, note, noteEn }] } }`。
   - `role` 取值 `kit`（推荐整机/套装）、`required`（必需）、`optional`（选配）。
   - `docPath` 指向 `ezs-docs` 玩法图文教程（如 `/docs/player/cunzhi3step`）。**附录已逐条核实过真实路由**；`reading-game`、`vocab-game` 文档站没有教程页，`docPath` 留空、不渲染教程链接。渲染时中文站拼 `https://docs.undersilicon.cn<docPath>`、英文站拼 `https://docs.undersilicon.cn/en<docPath>`。
   - 所有 `items[].slug` 都是商城 slug——阶段 0 之后不再需要 `docsPath` 分支。
3. **URL 生成器** `play-registry/assets/js/shop-catalog.js`：
   - 读 `shop-products.json` 与 `game-hardware.json`，输出商城商品 URL `https://shop.undersilicon.cn/{zh|en}/products/<slug>?ref=play-<surface>-<gameId>`（随站点语言切 `/zh` 或 `/en`）。
   - `ref` 必须满足 `^[A-Za-z0-9._-]{1,64}$`——与 `shop/src/lib/promoSource.ts` 的 `REF_PATTERN` 一致，不满足就不拼 `ref`。
   - `surface` 固定三种：`detail`（介绍页）、`list`（列表页）、`modal`（启动弹窗）。

## 阶段 2：游戏 Manifest 补 `howTo`

1. 更新 9 个玩法 + `device-control` 的 `howTo` 与 `i18n.en.howTo`，结构统一为「穿戴准备 → 动作与奖惩规则 → 通关解锁条件」三段。`surge-edging` 需补缺失的 `i18n.en.howTo`。
2. **只改 `howTo`，不加 `hardware` 字段**（评审第 2 条）。
3. 改过的游戏目录递增 `manifest.version`（patch +1），通过 `build-registry.js` 的 `validateVersionDrift`。
4. 文案口径：`drink-pee-unlock` 对外统一称「喝水/液体收集」，只写水瓶/容器放秤上变轻或变重，不写憋尿/排泄，不写人体站上电子秤。

各玩法的 `howTo` 三段内容与硬件推荐清单见本文件末尾附录。

## 阶段 3：游戏站接入导购入口

1. **玩法介绍页** `game-intro.html` + `assets/js/game-detail.js` + `assets/css/site.css`：
   - 「怎么玩」卡片按三段分步展示，底部附「查看完整图文教程 ↗」链到 `docPath`。
   - 新增「需要哪件硬件」卡片：顶部 `summary` 选购提示，下方商品网格（缩略图 + `kit`/`required`/`optional` 角标 + `note` + 「去商城购买 ↗」）。
   - 原有「逻辑设备槽位与能力明细」折叠保留，供多设备进阶玩家核对。
2. **列表页** `assets/js/game-list.js`：每张卡片补一行硬件标签（如 `推荐：寸止一体机`、`必需：QTZ 距离感应终端`），点进详情前就能判断手头设备够不够。
3. **启动弹窗** `assets/js/play-launcher.js`：某个必需逻辑槽位处于「无匹配设备」时，在槽位旁渲染对应硬件名与「去购买硬件 ↗」（`?ref=play-modal-<gameId>`）。
4. **顶栏与页脚**：补「官网商城」外跳 `https://shop.undersilicon.cn/{zh|en}?ref=play-nav`。

## PR-A 验收

- 新增 `play-registry/test/game-hardware.test.js`：断言每个 gameId 的 `items[].slug` 都在商品快照里、`ref` 满足 `REF_PATTERN`、三种 `surface` 都能生成合法 URL、语言切换时 `/zh` 与 `/en` 正确。
- 跑 `npm run build:site && npm test`（play-registry）、`npm run test:backend`（根仓，验证 manifest 提取未漂移）。
- BrowserOS neo 代表性截图（不逐页截 20 多张）：
  1. `pressure-edging` 介绍页中文态（整机型推荐）
  2. `pushup-detection` 介绍页英文态（必需单品型）
  3. 任一玩法启动弹窗「无匹配设备」时的购买引导
  4. 列表页硬件标签
- 报告放 `tmp/`，图片**嵌入**文档、用相对路径（VS Code 预览不加载 `E:/` 绝对路径）。

---

# PR-B：设备页补中文（阶段 4，与 PR-A 无依赖）

1. **`play-registry/docs/devices.html`**：
   - 「设备类型清单」的「能力集」列改为「中文名 + `key`」双显（如 `括约肌压力 sphincterPressure`）。
   - 「能力总表」表头 `Actions / Events` 改为「动作 / 事件」，为动作与事件名补中文释义（`set`、`increase`、`enterLow`、`pushDown` 等）。
   - 补 `DAN01`（姿态传感器，`attitude` 能力）与品牌设备能力（`vibration`、`suction`、`estim`），自研设备名旁附商城/文档链接。
   - **正文保持中文，不接整页 `data-i18n`**（评审第 5 条），与其余 4 个开发文档一致。
   - 中文能力名**从 `assets/js/i18n.js` 的 `CAPS` 字典取**，不要在 HTML 里另手写一份，避免两处漂移。
2. **`play-registry/assets/js/device-control.js`**（`control.html`）：
   - `capLabel()` 优先读 `capabilityConfig` 本地化标题，缺失时回落 `SiteI18n.capLabel()`（现在纯上行传感器能力会直接显示裸英文 key）。参照 `game-detail.js:30` 与 `game-list.js:49` 已有的同名实现。
   - 设备未设自定义昵称（名称等于固件型号或默认 ID）时，卡片主标题显示「中文设备类型名 · 短 ID」（如 `寸止玩法设备 · CUNZHI01`）。
3. **`backend/games/device-control/{game.js,i18n.js}`**：
   - 实时数据区现在把 `device.data` 的英文属性键原样上屏（`game.js:66` 的 `dataHtml`）。
   - 字段中文名与单位**以 `backend/devices/monitorSpec.js` 为准，逐字对齐**（评审第 4 条），显示成「中文名 + 单位」。monitorSpec 未覆盖的字段（`report_delay_ms` 上报间隔 ms、`voltage` 电击电压、`shock` 电击状态、`power` 电机强度、`open` 锁状态、`low_band` 近阈值 mm、`high_band` 远阈值 mm）再在 `i18n.js` 补，命名风格与 monitorSpec 保持一致。
   - 优先方案：把 monitorSpec 随设备载荷下发给游戏（`bridgeService.js:596` 已在下发 `capabilityConfig`，同理加 `monitorSpec`），游戏侧直接用，避免第二份字典。做不到再退回在 `i18n.js` 照抄。
   - 递增 `device-control` 的 `manifest.version`。

## PR-B 验收

- 截图：中文化后的 `docs/devices.html`、`control.html` 设备卡片、`games/device-control` 实时数据区。
- 跑 `npm run build:site && npm test`、`npm run test:backend`。

---

# 分支与收尾

- 按根 `AGENTS.md`：从远端主干开 worktree，放 `E:\smart\project\worktrees\`。
  - PR-A：`control-panel-play-guide`
  - PR-B：`control-panel-device-zh`
- 删 worktree 只用 `python E:\smart\tools\worktree\safe_remove.py <路径>`（里面的 `node_modules` 常是主仓的目录联接）。
- `ezs-docs` 本次**不需要改动**——阶段 0 已把两件硬件纳入商城，原阶段 1 的 docs 首屏购买框不再是关键路径。若后续仍想补，单独开文档任务（纯文档不开 worktree）。
- 合入后发完工通知（接口见 `E:\smart\docs\user-config.md`「通知」）。

## 暂不纳入本次范围

- PC 客户端原生游戏库/配置页与设备页（`frontend/` 的 `PlayLibraryView.vue`、`PlayConfigView.vue`、`DevicesView.vue`）
- 手机 App 游戏库/配置页与设备页（`control_panel_mobile`）
- 品牌官网产品落地页英文硬编码修复（`undersilicon-server/packages/landing`）
- QTZ 脚踏板档、PJ01 含电源档上架（需先补 supply SKU 主数据）

---

# 附录：各玩法 `howTo` 与硬件清单

所有 slug 均为商城 slug，`distance-sensor`（QTZ）与 `reciprocating-motor`（PJ01）已于阶段 0 上架。

## `pressure-edging` 气压寸止玩法

1. 佩戴气压传感器与震动刺激器（寸止一体机单机全含），贴好可选电极贴并按需上锁。
2. 启动后电机自动输出刺激；兴奋度升高带动气压上升时自动减速，超过临界气压立即停振并触发电击惩罚。
3. 压力回落后恢复刺激，可用屏幕按钮微调强度，倒计时结束自动停机解锁。

- `summary`：一台寸止一体机即可同时满足气压传感、震动刺激与电击惩罚，无需拆买多台分体模块。
- `docPath`：`/docs/player/cunzhi01`
- items：`cunzhi01`(kit)、`zidongsuo-auto-lock`(optional)、`lubricant-60ml`(optional)、`wear-pants`(optional)、`reciprocating-motor`(optional，女用炮机方案)

## `pressure-edging-v2` 气压寸止3阶段升级版

1. 佩戴寸止一体机（或气压传感器 + 刺激器），设定「中间兴奋压」与更高的「临界压」。
2. 平静期逐步加力 → 进入中间压智能控速维持边缘刺激 → 突破临界压停振并电击，冷却回落后进入下一轮。
3. 倒计时临近结束进入「起飞期」冲刺，时间到自动停机解锁。

- `summary`：寸止一体机单机配齐必需传感与刺激；女用可加炮机控制器。
- `docPath`：`/docs/player/cunzhi3step`
- items：`cunzhi01`(kit)、`zidongsuo-auto-lock`(optional)、`lubricant-60ml`(optional)、`reciprocating-motor`(optional)

## `surge-edging` 气压突变寸止

1. 佩戴寸止一体机（或气压传感器 + 刺激器），无需反复校准固定绝对气压，不怕轻微漏气。
2. 平静期震动缓慢增强；系统实时捕捉短时间内的「气压突然抬升」，判定临近边缘立即停振（可选电击）并等待压力回落冷却。
3. 循环多轮直至总倒计时结束，末尾冲刺后自动解锁。

- 需同步补齐 `i18n.en.howTo`（当前缺失）。
- `summary`：寸止一体机单机配齐；按气压变化率判定，不怕轻微漏气。
- `docPath`：`/docs/player/surge-edging`
- items：`cunzhi01`(kit)、`zidongsuo-auto-lock`(optional)、`lubricant-60ml`(optional)

## `pelvic-training` 提肛训练玩法

1. 搭配润滑液佩戴气压传感器（如寸止一体机肛塞组件），可选贴好电极贴与自动锁。
2. 跟随屏幕「放松 ↔ 提肛」节奏交替训练：提肛阶段需在规定秒数内收紧括约肌让气压上升达到目标变化度。
3. 达标计数 +1，未达标触发电击提醒；完成目标次数或训练时长结束即通关解锁。

- `summary`：寸止一体机含气压传感与电击；只想要传感可单买阔约传感器。
- `docPath`：`/docs/player/kegel-training`
- items：`cunzhi01`(kit)、`kuoyue-sensor`(required，分体替代)、`zidongsuo-auto-lock`(optional)、`lubricant-60ml`(optional)、`wear-pants`(optional)

## `drink-pee-unlock` 喝水/液体收集解锁玩法

1. 将装水的水瓶（喝水模式）或空容器（液体收集模式）平稳放在 DZC01 电子秤上，切勿人体站秤；可选配自动锁、电击、振动与提肛/踮脚传感器。
2. 喝水模式通过饮水让秤上水瓶变轻，液体收集模式通过吸管导流让秤上容器变重；若开启提肛/踮脚监测，期间需保持对应姿态，松懈会触发惩罚。
3. 重量变化达到目标克数（或最长时长超时）即挑战成功并自动开锁。

- 命名口径：对外统一称「喝水/液体收集」，不写憋尿/排泄，不写人体站上电子秤。
- `summary`：强制喝水玩法套装一站配齐；单买只需电子秤。
- `docPath`：`/docs/player/drink-pee-unlock`
- items：`force-drink`(kit)、`electronic-scale`(required)、`cunzhi01-host`(optional)、`zidongsuo-auto-lock`(optional)、`niaohu-gag`(optional)

## `maid-punishment` 女仆偷懒惩罚

1. 贴好电击设备电极贴（必需），将踮脚压力传感器垫在脚后跟下（或用 QTZ 双脚踏板），可选配跳蛋与自动锁。
2. 开始后全程保持踮脚站立；一旦脚后跟落地踩下传感器/踏板，立即触发电击惩罚直至重新抬起。
3. 长时间未违规时可选刺激器会逐步增强干扰；坚持到倒计时归零即停机解锁。

- `summary`：踮脚惩罚玩法v2套装一站配齐；也可用寸止一体机完整版（含踮脚传感器）。
- `docPath`：`/docs/player/tiptoe-v2`
- items：`tiptoe-v2`(kit)、`cunzhi01`(kit)、`cunzhi01-host`(required，分体)、`tiptoe-sensor`(required，分体)、`distance-sensor`(optional，双脚踏板方案)、`zidongsuo-auto-lock`(optional)

## `pushup-detection` 俯卧撑检测训练

1. 将 QTZ 距离传感器平放在胸口正下方地面，贴好可选电极贴、跳蛋/往复电机与自动锁。
2. 按身高设好俯身「近距离阈值」与撑起「远距离阈值」：俯身低于近阈值再撑起高于远阈值计 1 次有效俯卧撑。
3. 连续完成可触发振动奖励，超时不动会触发电击惩罚；规定时限内完成目标个数即解锁。

- `summary`：QTZ 距离感应终端是唯一必需件；奖惩设备都可选。
- `docPath`：`/docs/player/pushup-game`
- items：`distance-sensor`(required)、`cunzhi01`(optional)、`beidanci`(optional)、`zidongsuo-auto-lock`(optional)、`mini-vibe-2`(optional)、`reciprocating-motor`(optional)
- 注：俯卧撑玩法的跳蛋与捶背器共用一个电机输出槽（见 ADR `2026-09-29-pushup-single-motor-output`）。

## `reading-game` 朗读游戏

1. 连接电击设备并贴好电极贴（必需），可选配自动锁；准备好麦克风。
2. 选择「反复朗读」或「逐级遮字背诵」（首遍全文显示，后续每遍按比例遮挡字词），填入或使用默认文本。
3. 进入游戏先安静 3 秒校准环境音，随后出声朗读；中途沉默超时或偏离原文会先警告再电击，读完全部遍数且正确率达标即过关解锁。

- `summary`：背单词电击强化器最省事；已有寸止01主机的加一副电极贴即可。
- `docPath`：无（文档站暂无朗读游戏教程页，`docPath` 留空、不渲染教程链接）
- items：`beidanci`(kit)、`cunzhi01-host`(required，替代)、`electrode-pad-wire`(required)、`zidongsuo-auto-lock`(optional)

## `vocab-game` 背单词

1. 连接电击设备并贴好电极贴（必需），可选配自动锁；登录账号可云同步词书学习进度。
2. 在首页选定词书开始学习，屏幕朗读英文单词并给出四个中文释义，可点选或开启离线语音说「第一个」至「第四个」作答。
3. 选错、超时或点「不认识」会立即电击并将该词排回今日队尾；今日计划词全部答对一遍即完成并自动开锁。

- `summary`：同朗读游戏，背单词电击强化器一件即可。
- `docPath`：无（`content/player/old/锥刺股背单词玩法说明.md` 是旧版，不链）
- items：`beidanci`(kit)、`cunzhi01-host`(required，替代)、`electrode-pad-wire`(required)、`zidongsuo-auto-lock`(optional)

## `device-control` 设备控制台（内置工具）

1. 在面板或网页蓝牙中连接任意一台或多台硅基之下支持设备。
2. 进入控制台自动列出全部在线设备的实时读数与滑块/按钮控制项。
3. 可用于正式游玩前测试电机力度、电击输出、传感器压力读数与开关锁状态，退出时自动安全归零。

- `summary`：无需特定套件，连接任意硅基之下自研或已兼容的第三方蓝牙设备即可调试。
- items：空数组。介绍页改为渲染商城总入口 `https://shop.undersilicon.cn/{zh|en}?ref=play-detail-device-control`。
