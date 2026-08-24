/**
 * 蓝牙体感设备连接适配器。
 * 作为 deviceConnectionService 的 transport adapter：实现 send(message) / disconnect()，
 * 接收设备类型层发出的品牌命令，翻译为 App 娱乐模式 WebSocket 帧。
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
    this._statusCb = null;
  }

  /** 注册状态回调：brandService 用它接收 close / error，驱动状态机与重连。 */
  onStatus(cb) {
    this._statusCb = cb;
    return this;
  }

  async connect() {
    this.client = new DGLabSocketClient({ host: this.host, port: this.port, WebSocketClass: this.WebSocketClass || null });
    this.client.on('close', () => { this._statusCb?.('close', { error: '蓝牙体感设备连接已关闭' }); });
    this.client.on('error', (err) => { this._statusCb?.('error', { error: err?.message || String(err) }); });
    await this.client.connect();
    return this;
  }

  /** 轻量重连：复用既有 host/port 重建底层客户端。 */
  async reconnect() {
    this.disconnect();
    await this.connect();
  }

  /** 接收品牌命令（由 DGLAB 设备类型 emit），翻译并下发到 App */
  send(brandCommand) {
    if (!this.client) throw new Error('蓝牙体感设备连接未建立');
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
