/**
 * 郊狼 3.0：连上写 BF，之后 100ms 写 B0。品牌命令仍是 setPattern/setEstim/stopPattern。
 */
const dglabV3 = require('./protocols/dglabV3');

class DGLabV3Connection {
  constructor({ deviceId, send, intervalMs = dglabV3.B0_INTERVAL_MS, timers } = {}) {
    this.brand = 'dglab';
    this.deviceId = deviceId;
    this.mode = 'native';
    this.v3 = true;
    this._transportSend = typeof send === 'function' ? send : null;
    this._intervalMs = intervalMs;
    this._timers = timers || { setInterval, clearInterval };
    this._ab = { a: 0, b: 0 };
    this._timer = null;
    this._idleTicks = 0;
  }

  onStatus(cb) {
    this._statusCb = cb;
    return this;
  }

  _write(bytes) {
    if (typeof this._transportSend !== 'function') throw new Error('郊狼 3.0 传输未就绪');
    return this._transportSend({
      value: bytes,
      write: dglabV3.V3_UUIDS.write,
    });
  }

  _tick() {
    const idle = this._ab.a === 0 && this._ab.b === 0;
    this._idleTicks = idle ? this._idleTicks + 1 : 0;
    Promise.resolve(this._write(dglabV3.nextB0(this._ab))).catch(() => {});
    if (idle && this._idleTicks >= 3) this._stopLoop();
  }

  _ensureLoop() {
    if (this._timer) return;
    this._idleTicks = 0;
    this._timer = this._timers.setInterval(() => this._tick(), this._intervalMs);
    this._tick();
  }

  _stopLoop() {
    if (this._timer != null) this._timers.clearInterval(this._timer);
    this._timer = null;
  }

  async start() {
    await this._write(dglabV3.packBf());
    this._ensureLoop();
    return this;
  }

  send(brandCommand) {
    this._ab = dglabV3.applyCommand(this._ab, brandCommand);
    const running = !!this._timer;
    this._ensureLoop();
    if (running) this._tick();
    return Promise.resolve();
  }

  disconnect() {
    this._ab = { a: 0, b: 0 };
    this._stopLoop();
  }

  toMetadata() {
    return {
      brand: 'dglab',
      mode: 'native',
      kind: 'dglab-v3-noble',
      v3: true,
    };
  }
}

module.exports = { DGLabV3Connection };
