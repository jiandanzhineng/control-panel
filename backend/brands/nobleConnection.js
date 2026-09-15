/**
 * 品牌设备 noble 连接：组帧仍走现有协议适配器，GATT 写走 nobleBle。
 */
const dglabV2 = require('./protocols/dglabV2');
const dglabV3 = require('./protocols/dglabV3');
const { YcyWebBleConnection } = require('./ycyWebBleConnection');
const { SosexyWebBleConnection } = require('./sosexyWebBleConnection');
const { GxpWebBleConnection } = require('./gxpWebBleConnection');
const { DGLabV2WebBleConnection } = require('./webBleConnection');
const { DGLabV3Connection } = require('./dglabV3Connection');
const nobleBle = require('./nobleBle');

class NobleBleConnection {
  constructor({ brand, deviceId, address, type, name, ble, timers } = {}) {
    this.brand = type === 'SOSEXY_PID0004' ? 'sosexy' : (type === 'GXP_XA9935' ? 'gxp' : brand);
    this.deviceId = deviceId;
    this.address = address;
    this.type = type;
    this.name = name;
    this.mode = 'native';
    this._ble = ble || nobleBle;
    this._timers = timers;
    if (type === 'SOSEXY_PID0004') {
      this._inner = new SosexyWebBleConnection({ deviceId, type, mode: 'native', send: (msg) => this._sendFrame(msg) });
    } else if (type === 'GXP_XA9935' || brand === 'gxp') {
      this._inner = new GxpWebBleConnection({ deviceId, type: 'GXP_XA9935', mode: 'native', send: (msg) => this._sendFrame(msg) });
    } else if (brand === 'ycy') {
      this._inner = new YcyWebBleConnection({ deviceId, type, send: (msg) => this._sendFrame(msg) });
    } else {
      this._inner = null;
    }
  }

  onStatus(cb) { this._statusCb = cb; return this; }

  async connect() {
    const ready = await this._ble.connect(this.address);
    if (!this._inner && this.brand === 'dglab') {
      const v3 = dglabV3.isV3Name(this.name) || dglabV3.isV3WriteUuid(ready?.writeUuid);
      if (dglabV3.isV3Name(this.name) && !dglabV3.isV3WriteUuid(ready?.writeUuid)) {
        try { await this._ble.disconnect(this.address); } catch (_) { /* ignore */ }
        throw new Error('郊狼 3.0 未发现写特征 150A');
      }
      if (v3) {
        this._inner = new DGLabV3Connection({
          deviceId: this.deviceId,
          send: (msg) => this._sendFrame(msg),
          timers: this._timers,
        });
        await this._inner.start();
      } else {
        this._inner = new DGLabV2WebBleConnection({
          deviceId: this.deviceId,
          send: (ops) => this._sendDglab(ops),
        });
      }
    }
    return this;
  }

  _sendFrame(msg) {
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

  send(brandCommand) {
    if (!this._inner) throw new Error('设备未连接');
    return this._inner.send(brandCommand);
  }

  async disconnect() {
    try { if (this._inner?.v3) this._inner.disconnect(); } catch (_) { /* ignore */ }
    try { await this._ble.disconnect(this.address); } catch (_) { /* 已断开 */ }
  }

  toMetadata() {
    return {
      brand: this.brand, mode: 'native', kind: 'noble-ble',
      type: this.type, address: this.address, name: this.name,
      proto: this._inner?.v3 ? 'v3' : (this._inner?.v2 ? 'v2' : undefined),
    };
  }
}

module.exports = { NobleBleConnection };
