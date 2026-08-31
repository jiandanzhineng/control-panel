/** GXP 艾萝机娘二代品牌连接适配器。 */
const gxp = require('./protocols/gxp');

class GxpWebBleConnection {
  constructor({ deviceId, send, type = 'GXP_XA9935', mode = 'webble' } = {}) {
    this.brand = 'gxp';
    this.deviceId = deviceId;
    this.mode = mode;
    this.type = type;
    this._transportSend = typeof send === 'function' ? send : null;
    this._counter = 0;
    this._percent = 0;
    this._mode = 0;
    this._vibrationStopped = false;
  }

  onStatus(cb) {
    this._statusCb = cb;
    return this;
  }

  _nextCounter() {
    this._counter = (this._counter + 1) & 0xff;
    return this._counter;
  }

  _writeFrame(frame) {
    if (typeof this._transportSend !== 'function') throw new Error('GXP BLE 传输未就绪');
    return this._transportSend({
      op: 'write',
      value: Array.from(frame),
      write: gxp.WRITE_UUID,
    });
  }

  async send(command = {}) {
    if (command.cmd === 'stopAll' || command.cmd === 'stop') {
      this._percent = 0;
      this._mode = 0;
      this._vibrationStopped = true;
      await this._writeFrame(gxp.buildMotorAndMode(0, 0, this._nextCounter()));
      return this._writeFrame(gxp.buildStopVibration(this._nextCounter()));
    }
    if (command.cmd === 'stopVibration') {
      this._vibrationStopped = true;
      return this._writeFrame(gxp.buildStopVibration(this._nextCounter()));
    }
    if (command.cmd === 'setMotorAndMode') {
      if (command.percent != null) this._percent = command.percent;
      else if (command.value != null) this._percent = gxp.strengthToPercent(command.value);
      this._mode = Number(command.mode) || 0;
      this._vibrationStopped = false;
      return this._writeFrame(gxp.buildMotorAndMode(this._percent, this._mode, this._nextCounter()));
    }
    if (command.cmd === 'setStrength') {
      this._percent = gxp.strengthToPercent(command.value);
      const mode = this._vibrationStopped ? 0 : this._mode;
      return this._writeFrame(gxp.buildMotorAndMode(this._percent, mode, this._nextCounter()));
    }
    return this._writeFrame(gxp.toBleFrame(command, this._nextCounter()));
  }

  disconnect() {
    try { return this._transportSend?.({ method: 'disconnect' }); } catch (_) { return undefined; }
  }

  toMetadata() {
    return {
      brand: 'gxp',
      mode: this.mode,
      kind: this.mode === 'native' ? 'gxp-native' : 'gxp-webble',
      type: this.type,
      writeUuid: gxp.WRITE_UUID,
      notifyUuid: gxp.NOTIFY_UUID,
    };
  }
}

module.exports = { GxpWebBleConnection };
