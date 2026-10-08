/**
 * 品牌 BLE：Node noble 直连系统蓝牙（Windows=WinRT）。
 * 不经过 ycy_bridge HTTP。测试可注入 nobleImpl。
 */
const ycy = require('./protocols/ycy');
const hrs = require('./protocols/hrs');
const logger = require('../utils/logger');

const WRITE_HINTS = ['150a', '1504', 'ffb1', 'ff41', 'ff31', 'ff71', 'ae01', 'ff03', 'ee03'];
const SERVICE_HINTS = ['180c', '180b', 'ffb0', 'ff40', 'ff30', 'ff00', 'ee01', 'ae00'];
const GAP_SHORT = new Set(['2a00', '2a01', '2a02', '2a03', '2a04', '2a05', '2a06', '2a07', '2a08', '2a09', '2aa6', '1800', '1801']);
const SCAN_MS = 2500;
const SETTLE_MS = 400;
// 心率带：广播含心率服务 0x180D，或名字带这些关键字（大小写不敏感）。
const HRM_NAME_KEYWORDS = ['HRM', 'HEART', 'PULSE', 'HRS', '心率'];
const HRM_STALE_MS = 5000;
const HRM_WATCHDOG_MS = 1000;

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
  return p?.advertisement?.localName || p?.advertisement?.localname || '';
}

/** 广播里是否声明了心率服务（noble 对 16 位 UUID 给短号 '180d'，部分栈给全 UUID）。 */
function advertisesHrs(p) {
  const uuids = p?.advertisement?.serviceUuids;
  if (!Array.isArray(uuids)) return false;
  return uuids.some((u) => shortUuid(u) === '180d');
}

/** 标准蓝牙心率带识别：广播服务优先，名字关键字兜底。 */
function isHrmPeripheral(p) {
  if (advertisesHrs(p)) return true;
  const n = String(nameOf(p) || '').toUpperCase();
  return HRM_NAME_KEYWORDS.some((k) => n.includes(k));
}

function addrOf(p) {
  return String(p.address || p.id || '').toLowerCase();
}

function hexKey(s) {
  return String(s || '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

function matchesBrand(brand, name) {
  const n = String(name || '').toUpperCase();
  if (brand === 'hrm') return HRM_NAME_KEYWORDS.some((k) => n.includes(k));
  if (brand === 'dglab') return ['D-LAB', 'DG-LAB', 'COYOTE', '47L', 'ESTIM'].some((k) => n.includes(k));
  if (brand === 'sosexy') return n.includes('SOSEXY');
  if (brand === 'gxp') return n.includes('XA9935') || n.includes('GXP');
  return ycy.BLE_NAME_KEYWORDS.some((k) => n.includes(String(k).toUpperCase()))
    || ['FJB', 'ENEMA', 'GLJ', 'DJ'].some((k) => n.includes(k));
}

// 未知名字的品牌判定：心率带优先（避免把心率带按 ycy 兜底吞掉）。
function detectBrand(name, peripheral) {
  if (isHrmPeripheral(peripheral) || matchesBrand('hrm', name)) return 'hrm';
  if (matchesBrand('sosexy', name)) return 'sosexy';
  if (matchesBrand('gxp', name)) return 'gxp';
  if (matchesBrand('dglab', name)) return 'dglab';
  if (matchesBrand('ycy', name)) return 'ycy';
  return null;
}

function filterBrand(list, brand) {
  if (!brand) return list;
  if (brand === 'hrm') {
    return list.filter((d) => isHrmPeripheral({ advertisement: { localName: d.name, serviceUuids: d.serviceUuids } }));
  }
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

function isBlockedChar(c) {
  if (isGapChar(c)) return true;
  return String(c.uuid || '').toLowerCase().includes('8ec9');
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

/** 按短号找特征（心率服务/电量/身份都用标准短号，兼容全 UUID）。 */
function findChar(chars, short) {
  return (chars || []).find((c) => uuidEq(c.uuid, short)) || null;
}

function canNotify(c) {
  const p = c?.properties;
  if (!p) return false;
  if (Array.isArray(p)) return p.includes('notify') || p.includes('indicate');
  return !!(p.notify || p.indicate);
}

function canRead(c) {
  const p = c?.properties;
  if (!p) return false;
  if (Array.isArray(p)) return p.includes('read');
  return !!p.read;
}

/** 读一个特征（noble readAsync 优先，回调式兜底）；读失败返回 null。 */
async function readChar(c) {
  if (!c) return null;
  try {
    if (typeof c.readAsync === 'function') return await c.readAsync();
    return await new Promise((res, rej) => c.read((e, d) => (e ? rej(e) : res(d))));
  } catch (_) {
    return null;
  }
}

/** 订阅通知（on('data') 为主，noble 回调式 subscribe 仅作兼容）。 */
function subscribeChar(c, onData) {
  if (!c || !canNotify(c)) return false;
  const handler = (data) => onData(Buffer.isBuffer(data) ? data : Buffer.from(data || []));
  c.on('data', handler);
  try {
    if (typeof c.subscribeAsync === 'function') { c.subscribeAsync().catch(() => {}); return true; }
    if (typeof c.subscribe === 'function') { c.subscribe(); return true; }
  } catch (_) { /* 订阅失败仍保留监听，等设备侧推送 */ }
  return true;
}

function pickWriteChar(chars) {
  const list = chars || [];
  const hinted = (c, hint) => String(c.uuid || '').toLowerCase().includes(hint) && !isBlockedChar(c);
  for (const hint of WRITE_HINTS) {
    const hit = list.find((c) => hinted(c, hint) && isWritable(c));
    if (hit) return hit;
  }
  const any = list.find((c) => isWritable(c) && !isBlockedChar(c));
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
    this._inflight = new Map();
    // 心率带：数据/断线监听者与看门狗定时器（按 address 索引）
    this._hrmListeners = new Set();
    this._hrmWatchdogs = new Map();
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
        .map((p) => ({
          id: addrOf(p),
          address: addrOf(p),
          name: nameOf(p),
          rssi: p.rssi,
          serviceUuids: p.advertisement?.serviceUuids,
        }))
        .filter((d) => detectBrand(d.name, { advertisement: { localName: d.name, serviceUuids: d.serviceUuids } }));
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

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

  /** 建立 GATT 连接（幂等：已连接则跳过）。 */
  async _gattConnect(p, key, t0) {
    if (p.state === 'connected') return;
    try {
      if (typeof p.connectAsync === 'function') await p.connectAsync();
      else await new Promise((res, rej) => p.connect((e) => (e ? rej(e) : res())));
    } catch (e) {
      if (!/already connected/i.test(e.message || '')) {
        logger.error('[ble] gatt connect fail', { address: key, err: e.message, ms: Date.now() - t0 });
        throw e;
      }
    }
    logger.info('[ble] gatt connected', { address: key, ms: Date.now() - t0 });
  }

  /**
   * 心率带连接：订阅 0x2A37 测量，读+订阅 0x2A19 电量，读 0xFF04 身份。
   * 返回 { address, kind:'hrm', heartRateChar, batteryChar, identity }；
   * identity 为 null 表示第三方心率带（上层回退规范化 BLE 地址做设备 ID）。
   */
  async _connectHrm(p, key, t0) {
    await this._gattConnect(p, key, t0);
    let chars = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      await this._sleep(attempt === 1 ? 250 : 400);
      chars = await this._discoverChars(p);
      if (findChar(chars, hrs.HR_MEASUREMENT_CHAR)) break;
      logger.warn('[ble] hrm gatt empty, retry', { address: key, attempt, chars: charSummary(chars) });
    }
    const heartRateChar = findChar(chars, hrs.HR_MEASUREMENT_CHAR);
    if (!heartRateChar) {
      try {
        if (typeof p.disconnectAsync === 'function') await p.disconnectAsync();
        else p.disconnect();
      } catch (_) { /* ignore */ }
      logger.error('[ble] hrm no 2a37', { address: key, chars: charSummary(chars), ms: Date.now() - t0 });
      throw new Error(`未发现心率测量特征 0x2A37 (${charSummary(chars)})`);
    }

    const batteryChar = findChar(chars, hrs.BATTERY_LEVEL_CHAR);
    let battery = null;
    if (batteryChar) {
      const raw = await readChar(batteryChar);
      if (raw && raw.length) battery = raw[0];
    }

    // 身份特征：存在但非法 → 抛错拒绝连接（ADR 0011）；缺失 → null 由上层回退。
    const identityChar = findChar(chars, hrs.IDENTITY_CHAR);
    let identity = null;
    if (identityChar) {
      const raw = await readChar(identityChar);
      try {
        identity = hrs.parseIdentity(raw);
      } catch (e) {
        try {
          if (typeof p.disconnectAsync === 'function') await p.disconnectAsync();
          else p.disconnect();
        } catch (_) { /* ignore */ }
        logger.error('[ble] hrm identity invalid', { address: key, err: e.message });
        throw e;
      }
    }

    const onData = (buf) => this._onHrmData(key, buf);
    subscribeChar(heartRateChar, onData);
    subscribeChar(batteryChar, (buf) => this._onHrmBattery(key, buf));
    const onDisconnect = () => this._onHrmDisconnect(key);
    p.once?.('disconnect', onDisconnect);

    const sess = {
      peripheral: p, kind: 'hrm', heartRateChar, batteryChar, identity, chars,
      lastFrameAt: Date.now(), onDisconnect,
    };
    this._sessions.set(key, sess);
    if (battery !== null) this._emitHrm(key, { battery });
    this._startHrmWatchdog(key);
    logger.info('[ble] hrm ready', {
      address: key, identity: identity?.deviceId || null, battery, ms: Date.now() - t0,
    });
    return {
      address: key,
      kind: 'hrm',
      heartRateChar: heartRateChar.uuid,
      batteryChar: batteryChar?.uuid || null,
      battery,
      identity,
    };
  }

  /** 一帧心率测量：解析 → 转发给监听者；坏帧只记日志，不影响连接。 */
  _onHrmData(key, buf) {
    const sess = this._sessions.get(key);
    if (!sess) return;
    try {
      const parsed = hrs.parseMeasurement(buf);
      sess.lastFrameAt = Date.now();
      this._emitHrm(key, hrs.toProps(parsed));
    } catch (e) {
      logger.warn('[ble] hrm frame invalid', { address: key, err: e.message, hex: Buffer.from(buf).toString('hex') });
    }
  }

  _onHrmBattery(key, buf) {
    if (!buf?.length) return;
    this._emitHrm(key, { battery: buf[0] });
  }

  /** 断线：清会话 + 通知监听者（brandService 据此置离线并交给自动连接 tick）。 */
  _onHrmDisconnect(key) {
    const sess = this._sessions.get(key);
    if (!sess) return;
    this._sessions.delete(key);
    this._stopHrmWatchdog(key);
    logger.info('[ble] hrm disconnected', { address: key });
    for (const cb of this._hrmListeners) {
      try { cb({ type: 'disconnect', address: key }); } catch (_) { /* 单个监听者异常不影响其他 */ }
    }
  }

  _emitHrm(key, props) {
    for (const cb of this._hrmListeners) {
      try { cb({ type: 'data', address: key, props }); } catch (_) { /* ignore */ }
    }
  }

  /** 看门狗：超过 5s 没有测量帧 → heart_rate=0 + hr_status='stale'。 */
  _startHrmWatchdog(key) {
    this._stopHrmWatchdog(key);
    const timer = setInterval(() => {
      const sess = this._sessions.get(key);
      if (!sess || sess.kind !== 'hrm') return this._stopHrmWatchdog(key);
      if (sess.lastFrameAt && Date.now() - sess.lastFrameAt >= HRM_STALE_MS) {
        sess.lastFrameAt = 0;
        this._emitHrm(key, { heart_rate: 0, hr_status: hrs.STALE_STATUS });
      }
    }, HRM_WATCHDOG_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this._hrmWatchdogs.set(key, timer);
  }

  _stopHrmWatchdog(key) {
    const timer = this._hrmWatchdogs.get(key);
    if (timer) { clearInterval(timer); this._hrmWatchdogs.delete(key); }
  }

  /** 监听心率数据/断线。返回取消函数。 */
  onHrmEvent(cb) {
    this._hrmListeners.add(cb);
    return () => this._hrmListeners.delete(cb);
  }

  /** 取一次会话信息（供 brandService 连接后确定设备 ID）。 */
  getSession(address) {
    return this._sessions.get(String(address || '').toLowerCase()) || null;
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
      if (!detectBrand(name, p)) {
        if (!seen.has(id)) {
          seen.add(id);
          logger.debug('[ble] scan seen', { name: name || '(no name)', id, rssi: p.rssi, ms: Date.now() - t0 });
        }
        return;
      }
      const isNew = !found.has(id);
      found.set(id, { id, address: id, name, rssi: p.rssi, serviceUuids: p.advertisement?.serviceUuids });
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

  _readyInfo(key, sess) {
    const write = sess.write;
    const writeShort = shortUuid(write.uuid);
    const proto = writeShort === '150a' ? 'v3' : (writeShort === '1504' || String(write.uuid).toLowerCase().includes('955a1504') ? 'v2' : undefined);
    return { address: key, writeUuid: write.uuid, proto };
  }

  async connect(address) {
    const key = String(address || '').toLowerCase();
    const sess = this._sessions.get(key);
    if (sess?.write) return this._readyInfo(key, sess);
    const pending = this._inflight.get(key);
    if (pending) return pending;
    const job = this._connectOnce(address);
    this._inflight.set(key, job);
    try { return await job; }
    finally { this._inflight.delete(key); }
  }

  async _connectOnce(address) {
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
    // 心率带走独立分支：只订阅通知、不要求写特征（见方案 docs/plan/heart-rate-strap.md）。
    if (detectBrand(nameOf(p), p) === 'hrm') return await this._connectHrm(p, key, t0);
    await this._gattConnect(p, key, t0);
    let write = null;
    let chars = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      await this._sleep(attempt === 1 ? 250 : 400);
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
    this._stopHrmWatchdog(key);
    if (!sess?.peripheral) return;
    if (sess.kind === 'hrm') {
      // 主动断开：摘掉断线监听，避免把用户断开又当成掉线触发重连。
      try { sess.peripheral.removeListener?.('disconnect', sess.onDisconnect); } catch (_) { /* ignore */ }
    }
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
  isHrmPeripheral,
  findChar,
  uuidEq,
  WRITE_HINTS,
  HRM_NAME_KEYWORDS,
  HRM_STALE_MS,
  scan: (opts) => shared.scan(opts),
  connect: (addr) => shared.connect(addr),
  write: (addr, frame, uuid) => shared.write(addr, frame, uuid),
  disconnect: (addr) => shared.disconnect(addr),
  onHrmEvent: (cb) => shared.onHrmEvent(cb),
  getSession: (addr) => shared.getSession(addr),
  shared,
};
