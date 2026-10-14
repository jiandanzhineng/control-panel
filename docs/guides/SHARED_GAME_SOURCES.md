# 两端内置游戏同步

本次纳入同源管理的游戏：寸止升级版 `pressure-edging-v2` 2.2.2、俯卧撑 `pushup-detection` 2.1.5。

PC 的 `backend/games/<id>/` 是页面、交互、国际化和媒体资产的源。寸止升级版的两端宿主规则来自 `backend/game-runtime/cores/pressure-edging-v2-core.js`。移动端 `game-core.js` 自动生成，只适配同步调用接口；禁止在生成文件里另写玩法。设备连接和命令执行仍由各平台适配。

## 修改流程

在 PC 仓库修改源文件，递增游戏版本，然后同步到移动仓库：

```powershell
node scripts/sync-mobile-games.js E:/develop/smart/control_panel_mobile
node scripts/sync-mobile-games.js E:/develop/smart/control_panel_mobile --check
npm --prefix backend test -- --runInBand tests/mobileSharedGameCore.test.js tests/pressureEdgingV2Core.test.js tests/pushup-detection-output.test.js
```

在移动仓库验证：

```powershell
node --test test/game-js/*.test.cjs
flutter test test/features/games test/core/remote
```

移动 CI 校验同步资产 SHA256，并执行真实 JS 核心与渲染脚本测试。PC 对照测试运行实际 PC Core 和生成的移动 Core，核对阶段、快照、输出与操作结果。同步后分别提交两个仓库。

## 本次兼容性修复

- 俯卧撑恢复 `vibrator` 奖励与 `pj01` 捶背惩罚的独立设备槽、状态和定时器。奖励用配置强度，惩罚保持旧版强度 255；同一物理设备重复映射时保留奖励保护。
- 寸止保留原压力/强度阈值图、触摸拖动和阶段语音。移动 WebView 使用 PC 原托管 renderer，动作转发给宿主，不启动页面设备循环。
- 暂停不顺延结束时间、不清空内部爬升强度、不中断已下发的电击。暂停态保留手动操作；`+10` 只改变当前目标；拖动和阈值微调支持原规则。
- 移动端恢复寸止本地页面常亮，切后台/离页停止宿主，避免后续 tick 再次输出；启动未完成时离页也会补停。开局读取映射传感器当前缓存压力。其他宿主游戏保留原启动和生命周期策略。
- 修复配置表单逐字符小数输入被父页回填覆盖的问题；外部参数更新仍同步。
- 修复托管 renderer 在更新阶段前验证语音、导致阶段语音不能播放的问题。

## 范围

气压突变寸止、女仆惩罚保持当前内容。其他游戏仍是独立历史副本，不能据此宣称所有游戏都已统一。

本次统一的是上述两款当前内置版本。已有按 ID 将缓存/在线包路由到固定内置宿主的机制未在本次改造，不能把任意下载包版本当作已通过同源核对。

自动测试验证确定输入下的玩法、交互、输出命令和生命周期调用；真实设备执行、Android/iOS 实机声音和浏览器视觉仍需实机验收。游戏网站发布包需另行发布，本次不发布网站或客户端。

## 2026-10-14 修复验证

- PC `npm run check`：后端 118 套件 / 1001 项通过，1 项既有跳过；前端 72 项通过，类型检查和生产构建成功。
- 移动游戏与远控测试 236 项通过，真实 JS 测试 5 项通过；相关模块静态分析无问题，改动 Dart 文件格式检查通过，Android debug APK 构建成功。
- 同源 `--check` 无差异。旧 PC/移动自驱动页面与当前核心暂停探针均得到内部强度 `10 → 10 → 14`，结束时间仍为 61000 毫秒。
