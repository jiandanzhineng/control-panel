/**
 * 役次元（YCY / YOKONEX）设备连接适配器。
 * 支持两种模式：
 *   - bridge：连接 YCY API-bridge（WebSocket → IM game_cmd），以指令触发控制。
 *   - ble   ：BLE 直连（YSKJ_EMS_BLE / YSKJ_TOY_BLE），原始强度/通道/波形下发。
 * 作为 deviceConnectionService 的 transport adapter：实现 send(message) / disconnect()。
 */
const ycy = require('./protocols/ycy');

class YCYConnection {
  constructor({ deviceId, mode = 'bridge', WebSocketClass = null } = {}) {
    this.brand = 'ycy';
    this.deviceId = deviceId;
    this.mode = mode; // 'bridge' | 'ble'
    this.WebSocketClass = WebSocketClass || null;
    this.bridge = null;
    this.ble = null;
    this.auth = null; // { uid, token } 桥接模式鉴权
  }

  async connect(opts = {}) {
    if (this.mode === 'ble') {
      this.ble = new ycy.YcyBleTransport();
      await this.ble.connect(this.deviceId, {
        serviceUuid: opts.serviceUuid,
        writeUuid: opts.writeUuid,
      });
      return this;
    }
    // bridge 模式
    const { host = '127.0.0.1', port = ycy.BRIDGE_DEFAULT_PORT, connectCode, uid, token } = opts;
    const auth = connectCode ? ycy.parseConnectCode(connectCode) : { uid: uid || '', token: token || '' };
    this.auth = auth;
    this.bridge = new ycy.YcyBridgeClient({ host, port, WebSocketClass: this.WebSocketClass });
    await this.bridge.connect();
    this.bridge.login(auth);
    return this;
  }

  /** 接收品牌命令（由 YCY_* 设备类型 emit），翻译并下发 */
  send(brandCommand) {
    if (this.mode === 'ble') {
      if (!this.ble) throw new Error('役次元 BLE 未连接');
      const frame = ycy.toBleFrame(brandCommand);
      return this.ble.write(frame);
    }
    if (!this.bridge) throw new Error('役次元桥接未连接');
    const msg = ycy.toBridgeMessage(brandCommand, { token: this.auth?.token });
    return this.bridge.send(msg);
  }

  disconnect() {
    if (this.bridge) { try { this.bridge.disconnect(); } catch (_) {} this.bridge = null; }
    if (this.ble) { try { this.ble.disconnect(); } catch (_) {} this.ble = null; }
  }

  toMetadata() {
    return {
      brand: 'ycy',
      mode: this.mode,
      kind: this.mode === 'ble' ? 'ycy-ble' : 'ycy-bridge',
      ...(this.auth?.uid ? { uid: this.auth.uid } : {}),
    };
  }
}

module.exports = { YCYConnection };
