# 日志系统说明

实现：`backend/services/logService.js`（`getLogsDirectory()`）。

## 日志目录（按优先级）

1. **Electron**：`app.getPath('userData')/logs`。安装包为 `%APPDATA%\undersilicon\logs\`，开发态为 `%APPDATA%\Electron\logs\`；`--user-data-dir=` 参数会改变该位置。用户数据目录可写，卸载重装后日志保留。
2. **`LOG_DIR` 环境变量**：非 Electron 时使用指定路径。
3. **开发环境**（`NODE_ENV=development`）：`backend/logs/`。
4. **非 Electron 生产环境**：
   - Windows：`%USERPROFILE%\AppData\Local\control-panel\logs\`
   - macOS：`~/Library/Application Support/control-panel/logs/`
   - Linux：`~/.local/share/control-panel/logs/`

## 功能

- 自动创建目录，按日期分文件（`YYYY-MM-DD.log`）
- 级别：ERROR / WARN / INFO / DEBUG
- 实时日志流（SSE）、历史文件查看与下载
- 自动清理旧日志（`cleanOldLogs`，默认保留 7 天）
- API 请求自动记录
