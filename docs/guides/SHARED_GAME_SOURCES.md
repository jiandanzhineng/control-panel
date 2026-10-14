# 两端内置游戏同步

移动端现有 7 款同名内置游戏按 PC 当前实现同步。页面、交互、国际化和媒体保持同源；平台只适配设备连接、命令执行、资源加载和生命周期。

| 游戏 | 当前版本 | PC 页面与资源来源 |
| --- | --- | --- |
| 喝尿解锁 `drink-pee-unlock` | 2.3.5 | `backend/games/drink-pee-unlock/` |
| 女仆偷懒惩罚 `maid-punishment` | 2.2.2 | `backend/games/maid-punishment/` |
| 盆底肌训练 `pelvic-training` | 2.1.3 | `backend/games/pelvic-training/` |
| 气压寸止 `pressure-edging` | 2.1.3 | `backend/games/pressure-edging/` |
| 寸止升级版 `pressure-edging-v2` | 2.2.2 | `backend/games/pressure-edging-v2/` |
| 气压突变寸止 `surge-edging` | 1.4.2 | `play-registry/games/surge-edging/` |
| 俯卧撑 `pushup-detection` | 2.1.5 | `backend/games/pushup-detection/` |

## 规则与渲染

三款宿主游戏的移动 `game-core.js` 自动生成，禁止直接修改：

- 寸止升级版：`backend/game-runtime/cores/pressure-edging-v2-core.js`。
- 气压突变寸止：`backend/game-runtime/cores/surge-edging-core.js`。
- 女仆惩罚：`backend/games/maid-punishment/game-core.js`。

移动 WebView 加载这三款的 PC 原托管 renderer，动作发送到原生宿主，不运行页面设备循环。原阈值图、拖动、按钮、阶段语音和突变寸止倒计时语音均保留。`_shared/game-host-manifests.json` 从完整 HTML manifest 生成，远控主机列表与兜底配置读取该文件；`game-host-renderers.json` 指定原脚本和全部语音资源，避免另写配置或简化界面。

与移动最新主干合并后，普通配置仍进入 `GameRunPage`，本地、远程观看及附着模式走现有 `HostGamePort` / `core/game_host`。自动生成 Core 同时导出 CommonJS 构造函数，并将 PC 的两个内置兜底 Core/manifest 同步到移动 `assets/games/cores/`。独立 `/games/remote` 工作区继续使用生成的 `GameCore.create/dispatch` 接口和 `_shared` 配置。按键开始、远程投影、版本校验和 iOS 资源落地采用主干实现。

其他四款使用原 PC 自驱动页面。移动资源加载器内联 PC 共享国际化脚本并注入当前语言，设备 Bridge 仍由 Flutter 提供。

移动宿主接入与 PC 事件契约一致：压力游戏读取映射传感器；女仆转发已映射设备的属性变化及锁按键，开局按钮带 `seed:true`，同值重报不触发违规，换映射和销毁时取消监听。女仆电击时限、TD01 延时及递增、手动开始和解锁来自 PC Core。所有本地宿主页面保持常亮，切后台或离页停止设备，结束保留最后统计快照。远控观看页不因离页停止远端主机。

配置保留 PC 参数默认值、边界、步长、枚举标签和设备数量元数据；非法数值阻止本地启动。小数编辑态保留，不因父页回填丢失小数点。

## 修改流程

先在 PC 修改源文件并递增游戏版本，然后同步：

```powershell
node scripts/sync-mobile-games.js E:/develop/smart/control_panel_mobile
node scripts/sync-mobile-games.js E:/develop/smart/control_panel_mobile --check
npm --prefix backend test -- --runInBand tests/mobileSharedGameCore.test.js tests/pressureEdgingV2Core.test.js tests/surgeEdgingCore.test.js tests/maidPunishmentCore.test.js tests/pushup-detection-output.test.js
```

移动验证：

```powershell
node --test test/game-js/*.test.cjs
node tools/game_core_golden/harness.js --pc-root E:/smart/project/control-panel
flutter test test/features/games test/core/game_host test/core/remote test/core/remote_session
flutter analyze --no-fatal-infos
flutter build apk --debug --flavor direct --dart-define=APP_DISTRIBUTION=direct
```

同步后分别提交两个仓库。移动 CI 校验 SHA256 并运行真实 JS Core、renderer 操作、语音和授权测试；PC 对照测试直接运行实际 PC Core 与生成的移动 bundle。

## 范围与验收

当前同名内置版本同源。PC 专属设备控制工具不新增到手机；移动独有斗地主保留。缓存和在线包按自己的来源加载，不将任意同 ID 下载版本冒充当前内置宿主版本。远控主机只公布实际登记的三款内置宿主游戏。

突变寸止 1.4.2 同时修复托管 renderer 阶段语音在更新阶段前验证、导致不能播放的问题。网站 registry 和发布包需要另行发布，本次没有发布网站或客户端。

自动测试验证确定输入下的规则、交互、输出命令和生命周期。真实设备执行、Android/iOS 实机声音与视觉仍需实机验收。

## 2026-10-14 全部同名游戏同步验证

- PC `npm run check`：后端 118 套件、1005 项通过（另有既有跳过），前端 72 项通过，类型检查与生产构建通过。
- PC 三款 Core 对照、突变与女仆行为测试共 75 项通过；换行归一化后再跑生成 Core 对照 7 项通过。
- 移动游戏与远控 243 项通过，相关接入与表单最终回归 12 项通过，原 JS Core/renderer 7 项通过。
- 相关 Dart 模块静态分析无问题，改动文件格式检查通过，Android debug APK 构建成功。
- 同源 `--check` 无差异；规则快照、原按钮、图表动作、阶段及倒计时语音、授权收回、按钮 seed/去重、锁按键与本地生命周期有自动验证。
