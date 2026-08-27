/**
 * 役次元 Web Bluetooth 连接适配器。
 * GATT 句柄在渲染进程；本类把品牌命令翻成 0x35 帧，经 send 闭包写特征值。
 */
const ycy = require('./protocols/ycy');
const { createYcyNormState, normalizeYcyCommand } = require('./capabilityMap');

class YcyWebBleConnection {
  constructor({ deviceId, send, type = 'YCY_CUP' }) {
    this.brand = 'ycy';
    this.deviceId = deviceId;
    this.mode = 'webble';
    this.type = type;
    this._transportSend = typeof send === 'function' ? send : null;
    this._statusCb = null;
    this._norm = createYcyNormState();
  }

  onStatus(cb) {
    this._statusCb = cb;
    return this;
  }

  _normalize(brandCommand) {
    return normalizeYcyCommand(this._norm, brandCommand, this.mode);
  }

  send(brandCommand) {
    if (typeof this._transportSend !== 'function') {
      throw new Error('役次元 WebBLE 传输未就绪');
    }
    const frame = ycy.toBleFrame(this._normalize(brandCommand));
    return this._transportSend({ op: 'write', value: Array.from(frame) });
  }

  disconnect() {
    try { this._transportSend?.({ method: 'disconnect' }); } catch (_) { /* 渲染进程可能已断开 */ }
  }

  toMetadata() {
    return { brand: 'ycy', mode: 'webble', kind: 'ycy-webble', type: this.type };
  }
}

module.exports = { YcyWebBleConnection };
