const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const os = require('os');

class LogService extends EventEmitter {
  constructor({ logsDir } = {}) {
    super();
    this.logsDir = logsDir || this.getLogsDirectory();
    this.pending = new Map();
    this.flushTimer = null;
    this.flushPromise = null;
    this.ensureLogsDirectory();
  }

  getLogsDirectory() {
    // 检查是否在Electron环境中
    if (process.versions && process.versions.electron) {
      // 在Electron中，使用用户数据目录
      const { app } = require('electron');
      if (app && app.getPath) {
        return path.join(app.getPath('userData'), 'logs');
      }
    }
    
    // 检查是否有环境变量指定日志目录
    if (process.env.LOG_DIR) {
      return path.resolve(process.env.LOG_DIR);
    }
    
    // 开发环境或非Electron环境，使用相对路径
    if (process.env.NODE_ENV === 'development') {
      return path.join(__dirname, '../logs');
    }
    
    // 生产环境，使用用户主目录下的应用数据文件夹
    const appName = 'control-panel';
    if (process.platform === 'win32') {
      return path.join(os.homedir(), 'AppData', 'Local', appName, 'logs');
    } else if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', appName, 'logs');
    } else {
      return path.join(os.homedir(), '.local', 'share', appName, 'logs');
    }
  }

  ensureLogsDirectory() {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  log(level, module, message) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      module,
      message
    };

    const formattedLog = `[${timestamp}] [${level}] [${module}] ${message}\n`;
    
    const today = timestamp.split('T')[0];
    const logFile = path.join(this.logsDir, `${today}.log`);

    const lines = this.pending.get(logFile) || [];
    lines.push(formattedLog);
    this.pending.set(logFile, lines);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush().catch((error) => {
          console.error('Failed to write logs:', error);
        });
      }, 100);
      this.flushTimer.unref?.();
    }
    
    this.emit('newLog', logEntry);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.flushPromise) return this.flushPromise;
    if (!this.pending.size) return Promise.resolve();

    this.flushPromise = (async () => {
      while (this.pending.size) {
        const [file, lines] = this.pending.entries().next().value;
        this.pending.delete(file);
        try {
          await fs.promises.appendFile(file, lines.join(''));
        } catch (error) {
          this.pending.set(file, lines.concat(this.pending.get(file) || []));
          throw error;
        }
      }
    })().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  error(module, message) {
    this.log('ERROR', module, message);
  }

  warn(module, message) {
    this.log('WARN', module, message);
  }

  info(module, message) {
    this.log('INFO', module, message);
  }

  debug(module, message) {
    this.log('DEBUG', module, message);
  }

  getLogFiles() {
    const files = fs.readdirSync(this.logsDir)
      .filter(file => file.endsWith('.log'))
      .map(filename => {
        const filePath = path.join(this.logsDir, filename);
        const stats = fs.statSync(filePath);
        return {
          filename,
          size: stats.size,
          date: filename.replace('.log', ''),
          lastModified: stats.mtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    
    return files;
  }

  getLogFilePath(filename) {
    return path.join(this.logsDir, filename);
  }

  cleanOldLogs(daysToKeep = 7) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    
    const files = fs.readdirSync(this.logsDir);
    files.forEach(filename => {
      if (filename.endsWith('.log')) {
        const fileDate = new Date(filename.replace('.log', ''));
        if (fileDate < cutoffDate) {
          fs.unlinkSync(path.join(this.logsDir, filename));
        }
      }
    });
  }
}

module.exports = new LogService();
module.exports.LogService = LogService;
