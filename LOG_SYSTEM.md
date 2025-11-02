# 日志系统说明

## 日志保存路径

日志系统会根据运行环境自动选择合适的保存路径：

### 1. Electron 打包环境
- **Windows**: `%USERPROFILE%\AppData\Local\control-panel\logs\`
- **macOS**: `~/Library/Application Support/control-panel/logs/`
- **Linux**: `~/.local/share/control-panel/logs/`

### 2. 开发环境 (NODE_ENV=development)
- 使用项目目录: `backend/logs/`

### 3. 环境变量指定
- 如果设置了 `LOG_DIR` 环境变量，将使用指定路径

### 4. 生产环境 (非Electron)
- **Windows**: `%USERPROFILE%\AppData\Local\control-panel\logs\`
- **macOS**: `~/Library/Application Support/control-panel/logs/`
- **Linux**: `~/.local/share/control-panel/logs/`

## 功能特性

- ✅ 自动创建日志目录
- ✅ 按日期分割日志文件 (YYYY-MM-DD.log)
- ✅ 多级别日志 (ERROR, WARN, INFO, DEBUG)
- ✅ 实时日志流 (Server-Sent Events)
- ✅ 历史日志文件查看和下载
- ✅ 自动清理旧日志文件 (默认保留7天)
- ✅ API请求自动记录

## Electron 打包注意事项

1. **权限**: 用户数据目录具有写入权限，避免了安装目录只读的问题
2. **路径**: 使用 `app.getPath('userData')` 获取标准用户数据目录
3. **兼容性**: 支持 Windows、macOS、Linux 三大平台
4. **持久化**: 应用卸载重装后日志仍然保留

## 测试验证

运行测试脚本验证当前环境的日志路径：
```bash
node backend/test-log-path.js
```