/**
 * 郊狼（DGLab）设备连接适配器。
 * 作为 deviceConnectionService 的 transport adapter：实现 send(message) / disconnect()，
 * 接收设备类型层发出的“郊狼品牌命令”，翻译为 App 娱乐模式 WebSocket 帧。
 */
const { DGLabSocketClient } = require('./protocols/dglab');

class DGLabConnection {
  constructor({ deviceId, host, port, WebSocketClass = null }) {
    this.brand = 'dglab';
    this.deviceId = deviceId;
    this.host = host;
    this.port = port;
    this.WebSocketClass = WebSocketClass || null;
    this.client = null;
  }

  async connect() {
    this.client = new DGLabSocketClient({ host: this.host, port: this.port, WebSocketClass: this.WebSocketClass || null });
    await this.client.connect();
    return this;
  }

  /** 接收品牌命令（由 DGLAB 设备类型 emit），翻译并下发到 App */
  send(brandCommand) {
    if (!this.client) throw new Error('郊狼连接未建立');
    return this.client.send(brandCommand);
  }

  disconnect() {
    if (this.client) {
      try { this.client.disconnect(); } catch (_) {}
      this.client = null;
    }
  }

  toMetadata() {
    return {
      brand: 'dglab',
      host: this.host,
      port: this.port,
      kind: 'dglab-ws',
    };
  }
}

module.exports = { DGLabConnection };
