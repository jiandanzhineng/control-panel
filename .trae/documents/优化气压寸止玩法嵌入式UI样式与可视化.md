## 现状与目标
- 现状：`backend/game/pressureEdgingEmbedded.js` 的嵌入式 HTML 采用黑白基础样式，信息密集、层次感弱。
- 目标：在不引入第三方库的前提下，提升观感与信息表达（主题色、卡片布局、进度条、压力折线图）。

## 改动范围
- 仅改动 `backend/game/pressureEdgingEmbedded.js`：
  - 在 `start()` 首次推送的快照中补充必要阈值，用于前端可视化（见 `backend/game/pressureEdgingEmbedded.js:152`）。
  - 重写 `getHtml()` 的内联样式与结构，保持现有 SSE 事件与按钮动作接口不变（`/api/games/current/stream` 与 `/api/games/current/actions`）。
- 不改动其他玩法文件（如 `demoEmbeddedSse.js`）。

## 设计要点
- 主题与排版：深色主题 + 柔和主色，卡片阴影与圆角，信息分区清晰；自适应一列布局。
- 数据可视化：
  - 压力折线图：使用 `<canvas>` 实时绘制最近 120 点压力；无依赖。
  - 进度条：
    - 压力相对临界值（`currentPressure/criticalPressure`）。
    - 强度相对最大值（`currentIntensity/maxMotorIntensity` 与 `targetIntensity/maxMotorIntensity`）。
- 状态高亮：运行/暂停提示；电击次数醒目；按钮主次分明，手动电击使用警示色。
- 日志：等宽字体、颜色区分等级、固定高度滚动区域。

## 实施步骤
1. 补充快照字段：在首次 `emitState` 中增加 `criticalPressure` 与 `maxMotorIntensity`（用于进度条与折线图刻度）。
2. 重写 `getHtml()`：
   - 使用 CSS 变量定义主题色与状态色；卡片式布局；按钮样式（主按钮、次按钮、警示按钮）。
   - 新增“压力与强度”卡片中的两个进度条与 `<canvas id="pressureChart">`。
   - 保持现有 `data-bind` / `data-action` 协议不变。
3. 前端脚本：
   - 维护 `pressureSeries` 环形数组（最近 120 点），在 `state` 事件中把 `currentPressure` 推入并调用 `drawChart()`。
   - 在 `render()` 中根据 `criticalPressure`、`maxMotorIntensity` 计算进度条宽度；若缺失则使用默认值回退（`criticalPressure=20`、`maxMotorIntensity=200`）。
4. 验证：运行现有寸止玩法，观察折线、进度条与状态、日志是否随 `state/ui/log` 事件实时更新；按钮动作正常。

## 风险与回退
- 若后端不补充阈值字段，前端按默认值绘制，功能不受影响。
- 改动集中于单文件，出现问题可直接回滚 `getHtml()` 内容。

## 交付与测试
- 交付：更新后的 `pressureEdgingEmbedded.js`（仅该文件）。
- 测试：使用现有设备或模拟数据，确认 UI 美观、信息清晰、交互正常；不影响设备控制逻辑。