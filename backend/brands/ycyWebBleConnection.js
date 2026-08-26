/**
 * 役次元 Web Bluetooth 连接适配器。
 * GATT 句柄在渲染进程；本类把品牌命令翻成 0x35 帧，经 send 闭包写特征值。
 */
const ycy = require('./protocols/ycy');
const { mergeFjbState, toLevel255, clampInt } = require('./capabilityMap');

class YcyWebBleConnection {
  constructor({ deviceId, send, type = 'YCY_CUP' }) {
    this.brand = 'ycy';
    this.deviceId = deviceId;
    this.mode = 'webble';
    this.type = type;
    this._transportSend = typeof send === 'function' ? send : null;
    this._statusCb = null;
    this._fjb = { stroke: 0, vibe: 0, axis: 0 };
  }

  onStatus(cb) {
    this._statusCb = cb;
    return this;
  }

  _normalize(brandCommand) {
    const c = brandCommand || {};
    if (c.cmd === 'setMotors') {
      const ch = c.channels || {};
      if (ch.a != null && ch.stroke == null) {
        return { ...c, cmd: 'setSpeed', speed: toLevel255(ch.a, 20) || 0 };
      }
      this._fjb = mergeFjbState(this._fjb, ch);
      return { brand: 'ycy', cmd: 'setFjb', ...this._fjb };
    }
    if (c.cmd === 'setFjb') {
      this._fjb = {
        stroke: c.stroke != null ? c.stroke : this._fjb.stroke,
        vibe: c.vibe != null ? c.vibe : this._fjb.vibe,
        axis: c.axis != null ? c.axis : this._fjb.axis,
      };
      return { ...c, cmd: 'setFjb', ...this._fjb };
    }
    if (c.cmd === 'stopFjb' || c.cmd === 'stopToy' || c.cmd === 'stopAll') {
      this._fjb = { stroke: 0, vibe: 0, axis: 0 };
    }
    if (c.cmd === 'setEstim') {
      return {
        brand: 'ycy', cmd: 'setStrength',
        channel: c.channel || 'A',
        value: Math.round((clampInt(c.intensity, 0, 255) / 255) * 100),
        wave: c.wave,
      };
    }
    return c;
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
