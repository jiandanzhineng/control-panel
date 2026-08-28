/** SOSEXY PID 0004 的品牌连接适配器。 */
const sosexy = require('./protocols/sosexy');

class SosexyWebBleConnection {
  constructor({ deviceId, send, type = 'SOSEXY_PID0004', mode = 'webble' } = {}) {
    this.brand = 'sosexy';
    this.deviceId = deviceId;
    this.mode = mode;
    this.type = type;
    this._transportSend = typeof send === 'function' ? send : null;
    this._messageId = 0;
  }

  onStatus(cb) {
    this._statusCb = cb;
    return this;
  }

  send(command) {
    if (typeof this._transportSend !== 'function') throw new Error('SOSEXY BLE 传输未就绪');
    const frames = sosexy.toBleFrames(command, this._messageId);
    this._messageId = (this._messageId + 1) % 0xff;
    return this._transportSend({ op: 'writeMany', values: frames.map((frame) => Array.from(frame)) });
  }

  disconnect() {
    try { return this._transportSend?.({ method: 'disconnect' }); } catch (_) { return undefined; }
  }

  toMetadata() {
    return {
      brand: 'sosexy',
      mode: this.mode,
      kind: this.mode === 'native' ? 'sosexy-native' : 'sosexy-webble',
      type: this.type,
      serviceUuid: sosexy.SERVICE_UUID,
      writeUuid: sosexy.WRITE_UUID,
      notifyUuid: sosexy.NOTIFY_UUID,
    };
  }
}

module.exports = { SosexyWebBleConnection };
