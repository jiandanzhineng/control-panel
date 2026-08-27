/**
 * DG-LAB 原版 V2（Web Bluetooth 直连）连接适配器。
 *
 * 作为 deviceConnectionService 的 transport adapter：实现 send(brandCommand) /
 * disconnect()，接收品牌层发出的 V2 品牌命令，翻译为 GATT 操作数组后，经主进程注入的
 * send 闭包（IPC 转发到渲染进程 GATT 写队列）下发。GATT 句柄本身由渲染进程持有，
 * 本适配器不直接触碰蓝牙硬件。
 */
const dglabV2 = require('./protocols/dglabV2');

class DGLabV2WebBleConnection {
  constructor({ deviceId, send }) {
    this.brand = 'dglab';
    this.deviceId = deviceId;
    this.mode = 'webble';
    this.v2 = true;
    this._transportSend = typeof send === 'function' ? send : null;
    this._statusCb = null;
    this._ab = { a: 0, b: 0 };
  }

  /** 注册状态回调（保持统一接口；V2 链路在渲染进程，close 由 Electron 经 detachWebBle 处理）。 */
  onStatus(cb) {
    this._statusCb = cb;
    return this;
  }

  _normalize(brandCommand) {
    const c = brandCommand || {};
    if (c.cmd === 'setEstim') {
      const hw = Math.round((Math.max(0, Math.min(255, Number(c.intensity) || 0)) / 255) * dglabV2.STRENGTH_HW_MAX);
      const ch = String(c.channel || 'ab').toLowerCase();
      if (ch === 'a') this._ab.a = hw;
      else if (ch === 'b') this._ab.b = hw;
      else { this._ab.a = hw; this._ab.b = hw; }
      return { ...c, cmd: 'setEstim', a: this._ab.a, b: this._ab.b };
    }
    if (c.cmd === 'setPattern') {
      const hw = dglabV2.uiToHwStrength(Number(c.intensity) || 0, 100, dglabV2.STRENGTH_HW_MAX);
      this._ab = { a: hw, b: hw };
    }
    if (c.cmd === 'stopPattern' || c.cmd === 'v2_stop') {
      if (c.cmd !== 'setPattern') this._ab = { a: 0, b: 0 };
    }
    return c;
  }

  /** 接收 V2 品牌命令（由品牌层产生），翻译为 GATT 操作并经 IPC 下发到渲染进程 */
  send(brandCommand) {
    if (typeof this._transportSend !== 'function') {
      throw new Error('DG-LAB V2 WebBLE 传输未就绪');
    }
    return this._transportSend(dglabV2.toGattOps(this._normalize(brandCommand)));
  }

  disconnect() {
    try {
      this._transportSend?.({ method: 'disconnect' });
    } catch (_) { /* 渲染进程可能已先行断开 */ }
  }

  toMetadata() {
    return {
      brand: 'dglab',
      mode: 'webble',
      kind: 'dglab-v2-webble',
      v2: true,
    };
  }
}

module.exports = { DGLabV2WebBleConnection };
