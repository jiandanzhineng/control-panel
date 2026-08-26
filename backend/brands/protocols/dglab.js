/**
 * 郊狼（DGLab）设备通信协议实现
 *
 * 协议来源（公开 GitHub 仓库）：
 *   - open-toys-controller/open-DGLAB-controller
 *     https://github.com/open-toys-controller/open-DGLAB-controller
 *   该仓库定义了“娱乐模式”下 DG-Lab App 暴露的本地 WebSocket 控制接口：
 *     ws://<手机IP>:<端口>/<api版本>   （api 版本固定为 1，默认端口 60536）
 *
 * 控制指令（连接后发送 JSON 字符串）：
 *   - 设置波形与强度： { cmd:"set_pattern", pattern_name:"经典", intensity:100, ticks:-1 }
 *       intensity : 0~100，整体强度百分比
 *       ticks     : 0=播放一遍后停止；-1=循环；正整数=持续 0.1*ticks 秒
 *   - 停止波形     ： { cmd:"stop_pattern" }
 *   - 修改强度上限 ： { cmd:"change_max_intensity", delta_intensity:10 }  （需在 App 内允许）
 *   - 背景波形     ： { cmd:"set_background_pattern", pattern_units:[...], intensity, ticks }
 *
 * 说明：娱乐模式为单活动波形模型（App 将波形同时作用于双通道）。如需 A/B 双通道
 * 独立强度与波形，应使用官方 DG-LAB-OPENSOURCE socket 协议（终端起 WS 服务、App 扫码
 * 绑定），本模块在 README 中给出扩展指引。
 */

const DEFAULT_PORT = 60536;
const API_VERSION = 1;

// 常见内置波形名称（App 内可见，缺失时回退“经典”）
const BUILTIN_PATTERNS = [
  '经典', '心跳', '潮汐', '渐强', '随机', '脉冲', '波浪', '电击',
];

function clampIntensity(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clampDelta(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function normalizePattern(name) {
  if (typeof name === 'string' && name.trim().length > 0) return name.trim();
  return '经典';
}

function normalizeTicks(ticks) {
  if (ticks === 0 || ticks === '0') return 0;
  const n = Number(ticks);
  if (!Number.isFinite(n)) return -1;
  return n < 0 ? -1 : Math.round(n);
}

/** 构造 set_pattern 指令 */
function buildSetPattern({ pattern = '经典', intensity = 100, ticks = -1 } = {}) {
  return {
    cmd: 'set_pattern',
    pattern_name: normalizePattern(pattern),
    intensity: clampIntensity(intensity, 100),
    ticks: normalizeTicks(ticks),
  };
}

/** 构造 stop_pattern 指令 */
function buildStopPattern() {
  return { cmd: 'stop_pattern' };
}

/** 构造 change_max_intensity 指令 */
function buildChangeMaxIntensity({ delta = 0 } = {}) {
  return {
    cmd: 'change_max_intensity',
    delta_intensity: clampDelta(delta),
  };
}

/** 构造 set_background_pattern 指令 */
function buildSetBackgroundPattern({ patternUnits = [], intensity = 60, ticks = -1 } = {}) {
  const units = Array.isArray(patternUnits)
    ? patternUnits.map((u) => ({
      pattern_intensity: clampIntensity(u?.pattern_intensity ?? u?.intensity, 0),
      frequency: Math.max(1, Math.min(1000, Math.round(Number(u?.frequency ?? 100)))),
    }))
    : [];
  return {
    cmd: 'set_background_pattern',
    pattern_units: units,
    intensity: clampIntensity(intensity, 60),
    ticks: normalizeTicks(ticks),
  };
}

/** 根据郊狼品牌命令（设备类型层发出）构造 App WebSocket 帧 */
function toWireMessage(brandCommand) {
  const cmd = brandCommand?.cmd;
  switch (cmd) {
    case 'setPattern':
      return buildSetPattern(brandCommand);
    case 'setEstim': {
      const intensity = Math.round((Math.max(0, Math.min(255, Number(brandCommand.intensity) || 0)) / 255) * 100);
      return buildSetPattern({
        pattern: brandCommand.wave || '经典',
        intensity,
        ticks: -1,
      });
    }
    case 'stopPattern':
    case 'stop':
      return buildStopPattern();
    case 'setMaxIntensity':
      return buildChangeMaxIntensity(brandCommand);
    case 'setBackground':
      return buildSetBackgroundPattern(brandCommand);
    default:
      throw new Error(`未知的郊狼指令: ${cmd}`);
  }
}

/**
 * 郊狼 WebSocket 客户端（娱乐模式）。
 * 复用 Node 22 全局 WebSocket；测试时可注入 mock socket。
 */
class DGLabSocketClient {
  constructor({ host, port = DEFAULT_PORT, WebSocketClass = null, keepAlive = true } = {}) {
    if (!host || typeof host !== 'string') throw new TypeError('host 必填');
    this.host = host;
    this.port = Number(port) || DEFAULT_PORT;
    this.url = `ws://${this.host}:${this.port}/${API_VERSION}`;
    this.WebSocketClass = WebSocketClass || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!this.WebSocketClass) throw new Error('当前环境缺少 WebSocket 实现');
    this.keepAlive = keepAlive;
    this.ws = null;
    this.connected = false;
    this.keepAliveTimer = null;
    this._onClose = null;
    this._onError = null;
    this._onMessage = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      if (typeof this.WebSocketClass !== 'function') {
        return reject(new Error('WebSocketClass 不是构造函数: ' + typeof this.WebSocketClass));
      }
      const ws = new this.WebSocketClass(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        if (this.keepAlive) this._startKeepAlive();
        if (!settled) { settled = true; resolve(this); }
      };
      ws.onmessage = (event) => {
        if (this._onMessage) {
          try { this._onMessage(typeof event.data === 'string' ? event.data : String(event.data)); }
          catch (_) {}
        }
      };
      ws.onerror = (err) => {
        if (this._onError) this._onError(err);
        if (!settled) { settled = true; reject(err); }
      };
      ws.onclose = () => {
        this.connected = false;
        this._stopKeepAlive();
        if (this._onClose) this._onClose();
      };
    });
  }

  _startKeepAlive() {
    this._stopKeepAlive();
    // 每分钟发送一次非法消息以维持连接（App 侧通过 onClose 检测掉线，
    // 空闲时主动保活可避免被中间网络回收）。
    this.keepAliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === 1) {
        try { this.ws.ping?.(); } catch (_) {}
      }
    }, 30000);
    // 不阻止进程退出：仅用于保活，连接关闭后即使未清理也不应挂起测试/服务。
    if (typeof this.keepAliveTimer.unref === 'function') this.keepAliveTimer.unref();
  }

  _stopKeepAlive() {
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
  }

  /** 发送郊狼品牌命令（由设备类型层产生），自动翻译为 App 帧 */
  send(brandCommand) {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error('郊狼连接未建立');
    }
    const frame = toWireMessage(brandCommand);
    this.ws.send(JSON.stringify(frame));
    return frame;
  }

  on(event, handler) {
    if (event === 'close') this._onClose = handler;
    else if (event === 'error') this._onError = handler;
    else if (event === 'message') this._onMessage = handler;
    return this;
  }

  disconnect() {
    this._stopKeepAlive();
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = {
  DEFAULT_PORT,
  API_VERSION,
  BUILTIN_PATTERNS,
  buildSetPattern,
  buildStopPattern,
  buildChangeMaxIntensity,
  buildSetBackgroundPattern,
  toWireMessage,
  DGLabSocketClient,
};
