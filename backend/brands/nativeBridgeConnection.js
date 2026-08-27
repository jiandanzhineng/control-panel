/**
 * 本机 Rust 桥适配器。命令经现有品牌适配器组帧，再 POST /api/send。
 */
const dglabV2 = require('./protocols/dglabV2');
const { YcyWebBleConnection } = require('./ycyWebBleConnection');
const { DGLabV2WebBleConnection } = require('./webBleConnection');

class NativeBridgeConnection {
  constructor({ brand, deviceId, address, port, type, fetchImpl } = {}) {
    this.brand = brand;
    this.deviceId = deviceId;
    this.address = address;
    this.port = Number(port);
    this.type = type;
    this.mode = 'native';
    this._fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this._inner = brand === 'ycy'
      ? new YcyWebBleConnection({ deviceId, type, send: (msg) => this._sendYcy(msg) })
      : new DGLabV2WebBleConnection({ deviceId, send: (ops) => this._sendDglab(ops) });
  }

  onStatus(cb) { this._statusCb = cb; return this; }
  async connect() { return this; }

  async _postSend(body) {
    const res = await this._fetch(`http://127.0.0.1:${this.port}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(json.msg || '本机桥下发失败');
    return json;
  }

  _sendYcy(msg) {
    if (msg?.method === 'disconnect') return this.disconnect();
    const frame = Buffer.from(msg.value || []);
    return this._postSend({ addr: this.address, frame: frame.toString('hex') });
  }

  _sendDglab(ops) {
    if (ops?.method === 'disconnect') return this.disconnect();
    const list = Array.isArray(ops) ? ops : [];
    return Promise.all(list.filter((op) => op.value).map((op) => this._postSend({
      addr: this.address,
      frame: Buffer.from(op.value).toString('hex'),
      write: dglabV2.V2_CHAR_BY_NAME[op.characteristic],
    })));
  }

  send(brandCommand) { return this._inner.send(brandCommand); }

  async disconnect() {
    try {
      await this._fetch(`http://127.0.0.1:${this.port}/api/disconnect?addr=${encodeURIComponent(this.address)}`, { method: 'POST' });
    } catch (_) { /* 桥可能已关 */ }
  }

  toMetadata() {
    return { brand: this.brand, mode: 'native', kind: 'native-bridge', type: this.type, address: this.address, port: this.port };
  }
}

module.exports = { NativeBridgeConnection };
