/**
 * 标准蓝牙心率带连接适配器（纯上行）。
 * 作为 deviceConnectionService 的 transport adapter：send(message) 静默忽略，
 * 因为心率带没有可写特征，也没有停止语义（心率不归零，只由看门狗标记 stale）。
 */
const hrs = require('./protocols/hrs');

/** 与 brandService.normalizeMacDeviceId 同规则：12 位小写 hex，无分隔符。 */
function normalizeMac(addr) {
  const hex = String(addr || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return hex.length >= 12 ? hex.slice(-12) : '';
}

class HrmConnection {
  constructor({ deviceId, address, name, ble, onData } = {}) {
    this.brand = 'hrm';
    this.deviceId = deviceId;
    this.address = address;
    this.name = name;
    this.type = 'HRM';
    this.mode = 'native';
    this._ble = ble || require('./nobleBle');
    this._onData = typeof onData === 'function' ? onData : null;
    this._statusCb = null;
    this._off = null;
    this.identity = null;
    this.firmwareVersion = null;
    // 连接后确定：身份特征里的 device_id，缺失则为规范化 BLE 地址。
    this.resolvedDeviceId = null;
  }

  onStatus(cb) { this._statusCb = cb; return this; }

  async connect() {
    const ready = await this._ble.connect(this.address);
    this.identity = ready?.identity || null;
    this.firmwareVersion = this.identity?.firmwareVersion || null;
    this.resolvedDeviceId = this.identity?.deviceId || normalizeMac(this.address) || this.deviceId;
    this._off = this._ble.onHrmEvent((evt) => {
      if (String(evt?.address || '').toLowerCase() !== String(this.address || '').toLowerCase()) return;
      if (evt.type === 'disconnect') {
        // 掉线后自行摘掉监听，避免重连时旧适配器继续收事件。
        try { this._off?.(); } catch (_) { /* ignore */ }
        this._off = null;
        this._statusCb?.('close', { error: '心率带已断开' });
        return;
      }
      if (evt.type === 'data' && evt.props) this._onData?.(evt.props);
    });
    // 连接即先给一次「无有效读数」，避免卡片停在断开前的旧心率。
    this._onData?.({
      heart_rate: 0,
      hr_status: hrs.STALE_STATUS,
      ...(ready?.battery != null ? { battery: ready.battery } : {}),
    });
    return this;
  }

  /** 下行命令（监控弹窗的 report_delay_ms、玩法复位等）一律静默忽略，不报错。 */
  send() { return { ok: true, ignored: true }; }

  async disconnect() {
    try { this._off?.(); } catch (_) { /* ignore */ }
    this._off = null;
    try { await this._ble.disconnect(this.address); } catch (_) { /* 已断开 */ }
  }

  toMetadata() {
    return {
      brand: 'hrm',
      mode: 'native',
      kind: 'hrm-ble',
      type: 'HRM',
      address: this.address,
      name: this.name,
      ...(this.identity?.deviceId ? { deviceId: this.identity.deviceId } : {}),
      ...(this.firmwareVersion ? { firmwareVersion: this.firmwareVersion } : {}),
    };
  }
}

module.exports = { HrmConnection, normalizeMac };
