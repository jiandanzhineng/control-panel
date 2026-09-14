/**
 * 品牌设备 noble 连接：组帧仍走现有协议适配器，GATT 写走 nobleBle。
 */
const dglabV2 = require('./protocols/dglabV2');
const { YcyWebBleConnection } = require('./ycyWebBleConnection');
const { SosexyWebBleConnection } = require('./sosexyWebBleConnection');
const { GxpWebBleConnection } = require('./gxpWebBleConnection');
const { DGLabV2WebBleConnection } = require('./webBleConnection');
const nobleBle = require('./nobleBle');

class NobleBleConnection {
  constructor({ brand, deviceId, address, type, ble } = {}) {
    this.brand = type === 'SOSEXY_PID0004' ? 'sosexy' : (type === 'GXP_XA9935' ? 'gxp' : brand);
    this.deviceId = deviceId;
    this.address = address;
    this.type = type;
    this.mode = 'native';
    this._ble = ble || nobleBle;
    this._inner = type === 'SOSEXY_PID0004'
      ? new SosexyWebBleConnection({ deviceId, type, mode: 'native', send: (msg) => this._sendYcy(msg) })
      : type === 'GXP_XA9935' || brand === 'gxp'
        ? new GxpWebBleConnection({ deviceId, type: 'GXP_XA9935', mode: 'native', send: (msg) => this._sendYcy(msg) })
        : brand === 'ycy'
          ? new YcyWebBleConnection({ deviceId, type, send: (msg) => this._sendYcy(msg) })
          : new DGLabV2WebBleConnection({ deviceId, send: (ops) => this._sendDglab(ops) });
  }

  onStatus(cb) { this._statusCb = cb; return this; }

  async connect() {
    await this._ble.connect(this.address);
    return this;
  }

  _sendYcy(msg) {
    if (msg?.method === 'disconnect') return this.disconnect();
    if (msg?.op === 'writeMany' && Array.isArray(msg.values)) {
      return msg.values.reduce(
        (p, value) => p.then(() => this._ble.write(this.address, Buffer.from(value || []), msg.write)),
        Promise.resolve(),
      );
    }
    return this._ble.write(this.address, Buffer.from(msg.value || []), msg.write);
  }

  _sendDglab(ops) {
    if (ops?.method === 'disconnect') return this.disconnect();
    const list = Array.isArray(ops) ? ops : [];
    return Promise.all(list.filter((op) => op.value).map((op) => this._ble.write(
      this.address,
      Buffer.from(op.value),
      dglabV2.V2_CHAR_BY_NAME[op.characteristic],
    )));
  }

  send(brandCommand) { return this._inner.send(brandCommand); }

  async disconnect() {
    try { await this._ble.disconnect(this.address); } catch (_) { /* 已断开 */ }
  }

  toMetadata() {
    return {
      brand: this.brand, mode: 'native', kind: 'noble-ble',
      type: this.type, address: this.address,
    };
  }
}

module.exports = { NobleBleConnection };
