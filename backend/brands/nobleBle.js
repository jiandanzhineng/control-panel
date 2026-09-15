/**
 * 品牌 BLE：Node noble 直连系统蓝牙（Windows=WinRT）。
 * 不经过 ycy_bridge HTTP。测试可注入 nobleImpl。
 */
const ycy = require('./protocols/ycy');
const logger = require('../utils/logger');

const WRITE_HINTS = ['150a', '1504', 'ffb1', 'ff41', 'ff31', 'ff71', 'ae01', 'ff03', 'ee03'];
const SERVICE_HINTS = ['180c', '180b', 'ffb0', 'ff40', 'ff30', 'ff00', 'ee01', 'ae00'];
const GAP_SHORT = new Set(['2a00', '2a01', '2a02', '2a03', '2a04', '2a05', '2a06', '2a07', '2a08', '2a09', '2aa6', '1800', '1801']);
const SCAN_MS = 2500;
const SETTLE_MS = 400;

function shortUuid(u) {
  const s = String(u || '').toLowerCase().replace(/-/g, '');
  return s.startsWith('0000') && s.length >= 8 ? s.slice(4, 8) : s.slice(0, 8);
}

function charSummary(chars) {
  return (chars || []).map((c) => shortUuid(c.uuid)).join(',') || 'none';
}

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

function isGapChar(c) {
  return GAP_SHORT.has(shortUuid(c.uuid));
}

function uuidEq(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  if (x === y) return true;
  const sx = shortUuid(a);
  const sy = shortUuid(b);
  return sx === sy && sx.length === 4;
}

function pickWriteChar(chars) {
  const list = chars || [];
  const hinted = (c, hint) => String(c.uuid || '').toLowerCase().includes(hint) && !isGapChar(c);
  for (const hint of WRITE_HINTS) {
    const hit = list.find((c) => hinted(c, hint) && isWritable(c));
    if (hit) return hit;
  }
  const any = list.find((c) => isWritable(c) && !isGapChar(c));
  if (any) return any;
  for (const hint of WRITE_HINTS) {
    const hit = list.find((c) => hinted(c, hint));
    if (hit) return hit;
  }
  return null;
}

class NobleBle {
  constructor({ nobleImpl } = {}) {
    this._noble = nobleImpl || null;
    this._peripherals = new Map();
    this._sessions = new Map();
    this._scanShared = null;
    this._scanSettle = null;
    this._connecting = false;
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

  async scan({ brand = null, timeoutMs = SCAN_MS, settleMs = SETTLE_MS, quiet = false } = {}) {
    if (this._connecting) {
      const cached = [...this._peripherals.values()]
        .map((p) => ({ id: addrOf(p), address: addrOf(p), name: nameOf(p), rssi: p.rssi }))
        .filter((d) => detectBrand(d.name));
      return filterBrand(cached, brand);
    }
    if (this._scanShared) {
      return filterBrand(await this._scanShared, brand);
    }
    this._scanShared = (async () => {
      const first = await this._runScan({ timeoutMs, settleMs, quiet });
      if (first.length) return first;
      if (!quiet) logger.info('[ble] scan empty, retry');
      return this._runScan({ timeoutMs, settleMs, quiet });
    })();
    try {
      return filterBrand(await this._scanShared, brand);
    } finally {
      this._scanShared = null;
    }
  }

  async _discoverChars(p) {
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
    let chars = characteristics.length ? characteristics : services.flatMap((s) => s.characteristics || []);
    if (chars.length) return chars;
    if (typeof p.discoverSomeServicesAndCharacteristicsAsync !== 'function') return chars;
    try {
      const got = await p.discoverSomeServicesAndCharacteristicsAsync(SERVICE_HINTS, []);
      services = got.services || [];
      characteristics = got.characteristics || [];
      chars = characteristics.length ? characteristics : services.flatMap((s) => s.characteristics || []);
    } catch (_) { /* 按已知服务再发现失败则保持空 */ }
    return chars;
  }

  _findPeripheral(address) {
    const key = String(address || '').toLowerCase();
    const hex = hexKey(address);
    return this._peripherals.get(key)
      || [...this._peripherals.values()].find((x) => addrOf(x) === key || hexKey(addrOf(x)) === hex)
      || null;
  }

  async _runScan({ timeoutMs, settleMs, quiet = false }) {
    const n = this.noble();
    const t0 = Date.now();
    const scanLog = quiet ? logger.debug.bind(logger) : logger.info.bind(logger);
    scanLog('[ble] scan start', { timeoutMs, settleMs });
    await this.waitReady();
    const found = new Map();
    const seen = new Set();
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    this._scanSettle = settle;
    let early = null;
    const onDiscover = (p) => {
      const name = nameOf(p);
      const id = addrOf(p);
      if (!id) return;
      this._peripherals.set(id, p);
      if (!detectBrand(name)) {
        if (!seen.has(id)) {
          seen.add(id);
          logger.debug('[ble] scan seen', { name: name || '(no name)', id, rssi: p.rssi, ms: Date.now() - t0 });
        }
        return;
      }
      const isNew = !found.has(id);
      found.set(id, { id, address: id, name, rssi: p.rssi });
      if (isNew) scanLog('[ble] scan found', { name, id, rssi: p.rssi, ms: Date.now() - t0 });
      if (isNew && found.size === 1 && settleMs >= 0) {
        early = setTimeout(() => settle('early'), settleMs);
      }
    };
    n.on('discover', onDiscover);
    try {
      // allowDuplicates=true：Windows 首包常无名字，名字在后续广播；false 会丢掉第二包。
      if (typeof n.startScanningAsync === 'function') await n.startScanningAsync([], true);
      else await new Promise((res, rej) => n.startScanning([], true, (e) => (e ? rej(e) : res())));
      const timer = setTimeout(() => settle('timeout'), timeoutMs);
      const reason = await done;
      clearTimeout(timer);
      if (early) clearTimeout(early);
      scanLog('[ble] scan done', { reason, count: found.size, ms: Date.now() - t0 });
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
    this._connecting = true;
    logger.info('[ble] connect', { address: key, cached: !!p, state: p?.state });
    try {
    if (!p) {
      await this.scan({ timeoutMs: SCAN_MS, quiet: true });
      p = this._findPeripheral(address);
    }
    if (this._scanSettle) this._scanSettle('pre-connect');
    if (this._scanShared) await this._scanShared.catch(() => {});
    if (!p) {
      logger.error('[ble] connect fail', { address: key, err: 'not found', ms: Date.now() - t0 });
      throw new Error(`未找到设备 ${address}`);
    }
    if (p.state !== 'connected') {
      try {
        if (typeof p.connectAsync === 'function') await p.connectAsync();
        else await new Promise((res, rej) => p.connect((e) => (e ? rej(e) : res())));
      } catch (e) {
        if (!/already connected/i.test(e.message || '')) {
          logger.error('[ble] gatt connect fail', { address: key, err: e.message, ms: Date.now() - t0 });
          throw e;
        }
      }
    }
    logger.info('[ble] gatt connected', { address: key, ms: Date.now() - t0 });
    let write = null;
    let chars = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      await sleep(attempt === 1 ? 250 : 400);
      chars = await this._discoverChars(p);
      write = pickWriteChar(chars);
      if (write) break;
      logger.warn('[ble] gatt empty, retry', { address: key, attempt, chars: charSummary(chars) });
    }
    if (!write) {
      logger.warn('[ble] gatt reconnect', { address: key });
      try {
        if (typeof p.disconnectAsync === 'function') await p.disconnectAsync();
        else p.disconnect();
      } catch (_) { /* ignore */ }
      await sleep(500);
      if (typeof p.connectAsync === 'function') await p.connectAsync();
      else await new Promise((res, rej) => p.connect((e) => (e ? rej(e) : res())));
      await sleep(400);
      chars = await this._discoverChars(p);
      write = pickWriteChar(chars);
    }
    if (!write) {
      try {
        if (typeof p.disconnectAsync === 'function') await p.disconnectAsync();
        else p.disconnect();
      } catch (_) { /* ignore */ }
      logger.error('[ble] no write char', { address: key, chars: charSummary(chars), ms: Date.now() - t0 });
      throw new Error(`设备尚未发现写特征/未就绪 (${charSummary(chars)})`);
    }
    this._sessions.set(key, { peripheral: p, write, chars });
    const writeShort = shortUuid(write.uuid);
    const proto = writeShort === '150a' ? 'v3' : (writeShort === '1504' || String(write.uuid).toLowerCase().includes('955a1504') ? 'v2' : undefined);
    logger.info('[ble] ready', { address: key, writeUuid: write.uuid, proto, charCount: chars.length, ms: Date.now() - t0 });
    return { address: key, writeUuid: write.uuid, proto };
    } finally {
      this._connecting = false;
    }
  }

  async write(address, frame, writeUuid) {
    const key = String(address || '').toLowerCase();
    const sess = this._sessions.get(key);
    if (!sess) throw new Error('设备未就绪');
    let char = sess.write;
    if (writeUuid) {
      char = (sess.chars || []).find((c) => uuidEq(c.uuid, writeUuid));
      if (!char) throw new Error(`写特征不匹配 ${writeUuid}`);
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
  uuidEq,
  WRITE_HINTS,
  scan: (opts) => shared.scan(opts),
  connect: (addr) => shared.connect(addr),
  write: (addr, frame, uuid) => shared.write(addr, frame, uuid),
  disconnect: (addr) => shared.disconnect(addr),
  shared,
};
