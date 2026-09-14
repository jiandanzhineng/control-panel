/**
 * 品牌 BLE：Node noble 直连系统蓝牙（Windows=WinRT）。
 * 不经过 ycy_bridge HTTP。测试可注入 nobleImpl。
 */
const ycy = require('./protocols/ycy');
const logger = require('../utils/logger');

const WRITE_HINTS = ['ff41', 'ff31', 'ff71', 'ae01', 'ff03', 'ee03'];
const SCAN_MS = 2500;
const SETTLE_MS = 400;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadNoble() {
  try {
    return require('@stoprocent/noble');
  } catch (_) {
    try {
      return require('@abandonware/noble');
    } catch (e) {
      throw new Error('未安装 noble（请 npm i @stoprocent/noble）');
    }
  }
}

function nameOf(p) {
  return p.advertisement?.localName || p.advertisement?.localname || '';
}

function addrOf(p) {
  return String(p.address || p.id || '').toLowerCase();
}

function hexKey(s) {
  return String(s || '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

function matchesBrand(brand, name) {
  const n = String(name || '').toUpperCase();
  if (brand === 'dglab') return ['D-LAB', 'DG-LAB', 'COYOTE', '47L', 'ESTIM'].some((k) => n.includes(k));
  if (brand === 'sosexy') return n.includes('SOSEXY');
  if (brand === 'gxp') return n.includes('XA9935') || n.includes('GXP');
  return ycy.BLE_NAME_KEYWORDS.some((k) => n.includes(String(k).toUpperCase()))
    || ['FJB', 'ENEMA', 'GLJ', 'DJ'].some((k) => n.includes(k));
}

function detectBrand(name) {
  if (matchesBrand('sosexy', name)) return 'sosexy';
  if (matchesBrand('gxp', name)) return 'gxp';
  if (matchesBrand('dglab', name)) return 'dglab';
  if (matchesBrand('ycy', name)) return 'ycy';
  return null;
}

function filterBrand(list, brand) {
  if (!brand) return list;
  return list.filter((d) => matchesBrand(brand, d.name));
}

function isWritable(c) {
  const p = c.properties;
  if (!p) return false;
  if (Array.isArray(p)) return p.includes('write') || p.includes('writeWithoutResponse');
  return !!(p.write || p.writeWithoutResponse);
}

function pickWriteChar(chars) {
  const list = chars || [];
  for (const hint of WRITE_HINTS) {
    const hit = list.find((c) => String(c.uuid || '').toLowerCase().includes(hint) && isWritable(c));
    if (hit) return hit;
  }
  return list.find(isWritable) || null;
}

class NobleBle {
  constructor({ nobleImpl } = {}) {
    this._noble = nobleImpl || null;
    this._peripherals = new Map();
    this._sessions = new Map();
    this._scanShared = null;
    this._scanSettle = null;
  }

  noble() {
    if (!this._noble) this._noble = loadNoble();
    return this._noble;
  }

  async waitReady() {
    const n = this.noble();
    if (n.state === 'poweredOn') return;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('蓝牙适配器未就绪')), 8000);
      const on = (state) => {
        if (state === 'poweredOn') {
          clearTimeout(t);
          n.removeListener('stateChange', on);
          resolve();
        }
      };
      n.on('stateChange', on);
      if (n.state === 'poweredOn') on('poweredOn');
    });
  }

  async scan({ brand = null, timeoutMs = SCAN_MS, settleMs = SETTLE_MS } = {}) {
    if (this._scanShared) {
      return filterBrand(await this._scanShared, brand);
    }
    this._scanShared = this._runScan({ timeoutMs, settleMs });
    try {
      return filterBrand(await this._scanShared, brand);
    } finally {
      this._scanShared = null;
    }
  }

  _findPeripheral(address) {
    const key = String(address || '').toLowerCase();
    const hex = hexKey(address);
    return this._peripherals.get(key)
      || [...this._peripherals.values()].find((x) => addrOf(x) === key || hexKey(addrOf(x)) === hex)
      || null;
  }

  async _runScan({ timeoutMs, settleMs }) {
    const n = this.noble();
    const t0 = Date.now();
    logger.info('[ble] scan start', { timeoutMs, settleMs });
    await this.waitReady();
    const found = new Map();
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    this._scanSettle = settle;
    let early = null;
    const onDiscover = (p) => {
      const name = nameOf(p);
      const id = addrOf(p);
      if (!id) return;
      this._peripherals.set(id, p);
      if (!detectBrand(name)) return;
      const isNew = !found.has(id);
      found.set(id, { id, address: id, name, rssi: p.rssi });
      if (isNew) logger.info('[ble] scan found', { name, id, rssi: p.rssi, ms: Date.now() - t0 });
      if (isNew && found.size === 1 && settleMs >= 0) {
        early = setTimeout(() => settle('early'), settleMs);
      }
    };
    n.on('discover', onDiscover);
    try {
      if (typeof n.startScanningAsync === 'function') await n.startScanningAsync([], false);
      else await new Promise((res, rej) => n.startScanning([], false, (e) => (e ? rej(e) : res())));
      const timer = setTimeout(() => settle('timeout'), timeoutMs);
      const reason = await done;
      clearTimeout(timer);
      if (early) clearTimeout(early);
      logger.info('[ble] scan done', { reason, count: found.size, ms: Date.now() - t0 });
    } finally {
      this._scanSettle = null;
      n.removeListener('discover', onDiscover);
      try {
        if (typeof n.stopScanningAsync === 'function') await n.stopScanningAsync();
        else await new Promise((res) => n.stopScanning(() => res()));
      } catch (_) { /* ignore */ }
    }
    return [...found.values()];
  }

  async connect(address) {
    const t0 = Date.now();
    const key = String(address || '').toLowerCase();
    let p = this._findPeripheral(address);
    logger.info('[ble] connect', { address: key, cached: !!p });
    if (!p) {
      await this.scan({ timeoutMs: SCAN_MS });
      p = this._findPeripheral(address);
    }
    if (this._scanSettle) this._scanSettle('pre-connect');
    if (this._scanShared) await this._scanShared.catch(() => {});
    if (!p) {
      logger.error('[ble] connect fail', { address: key, err: 'not found', ms: Date.now() - t0 });
      throw new Error(`未找到设备 ${address}`);
    }
    try {
      if (typeof p.connectAsync === 'function') await p.connectAsync();
      else await new Promise((res, rej) => p.connect((e) => (e ? rej(e) : res())));
    } catch (e) {
      logger.error('[ble] gatt connect fail', { address: key, err: e.message, ms: Date.now() - t0 });
      throw e;
    }
    logger.info('[ble] gatt connected', { address: key, ms: Date.now() - t0 });
    await sleep(150);
    let services = [];
    let characteristics = [];
    if (typeof p.discoverAllServicesAndCharacteristicsAsync === 'function') {
      const got = await p.discoverAllServicesAndCharacteristicsAsync();
      services = got.services || [];
      characteristics = got.characteristics || [];
    } else {
      await new Promise((res, rej) => {
        p.discoverAllServicesAndCharacteristics((e, s, c) => {
          if (e) return rej(e);
          services = s || [];
          characteristics = c || [];
          res();
        });
      });
    }
    const chars = characteristics.length
      ? characteristics
      : services.flatMap((s) => s.characteristics || []);
    const write = pickWriteChar(chars);
    if (!write) {
      const u = chars.map((c) => `${c.uuid}:${JSON.stringify(c.properties || {})}`).join(',');
      logger.error('[ble] no write char', { address: key, chars: u, ms: Date.now() - t0 });
      throw new Error(`设备尚未发现写特征/未就绪 (${u || 'no-chars'})`);
    }
    this._sessions.set(key, { peripheral: p, write, chars });
    logger.info('[ble] ready', { address: key, writeUuid: write.uuid, charCount: chars.length, ms: Date.now() - t0 });
    return { address: key, writeUuid: write.uuid };
  }

  async write(address, frame, writeUuid) {
    const key = String(address || '').toLowerCase();
    const sess = this._sessions.get(key);
    if (!sess) throw new Error('设备未就绪');
    let char = sess.write;
    if (writeUuid) {
      char = sess.chars.find((c) => String(c.uuid).toLowerCase() === String(writeUuid).toLowerCase()) || char;
    }
    if (!char) throw new Error('写特征未缓存');
    const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    const without = Array.isArray(char.properties)
      ? char.properties.includes('writeWithoutResponse')
      : !!char.properties?.writeWithoutResponse;
    try {
      if (typeof char.writeAsync === 'function') await char.writeAsync(buf, without);
      else await new Promise((res, rej) => char.write(buf, without, (e) => (e ? rej(e) : res())));
    } catch (e) {
      logger.error('[ble] write fail', { address: key, err: e.message, hex: buf.toString('hex') });
      throw e;
    }
    logger.info('[ble] write', { address: key, hex: buf.toString('hex'), without });
    return { ok: true, written: buf.toString('hex') };
  }

  async disconnect(address) {
    const key = String(address || '').toLowerCase();
    const sess = this._sessions.get(key);
    this._sessions.delete(key);
    if (!sess?.peripheral) return;
    try {
      if (typeof sess.peripheral.disconnectAsync === 'function') await sess.peripheral.disconnectAsync();
      else sess.peripheral.disconnect();
    } catch (_) { /* already down */ }
  }
}

const shared = new NobleBle();

module.exports = {
  NobleBle,
  pickWriteChar,
  matchesBrand,
  detectBrand,
  WRITE_HINTS,
  scan: (opts) => shared.scan(opts),
  connect: (addr) => shared.connect(addr),
  write: (addr, frame, uuid) => shared.write(addr, frame, uuid),
  disconnect: (addr) => shared.disconnect(addr),
  shared,
};
