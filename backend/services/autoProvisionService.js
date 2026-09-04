const { EventEmitter } = require('events');
const fileStorage = require('../utils/fileStorage');
const logger = require('./logService');
const defaultSerialService = require('./serialConnectionService');
const defaultFlashService = require('./wiredFlashService');

// 测试台串口自动供给：页面开启期间，对每个出现的串口跑一条独立流水线
//   探测握手 → 失败则(可选)烧录 → 再次探测 → 成功即交给 testService 自动开测
// 二次探测仍失败进 failed 终态，保持端口预留以阻断自动重试，等手动 retry 或拔插。
const SETTINGS_KEY = 'auto-provision-settings';
const CH34X_VENDOR_ID = '1a86';
// 握手失败但确实像我们的设备（空片/旧固件）才烧；端口被占用等不烧。
const FLASHABLE_PROBE_CODES = [
  'SERIAL_PROBE_TIMEOUT',
  'SERIAL_IDENTITY_INVALID',
  'SERIAL_PROBE_CLOSED',
];
const PROBE_MAX_ATTEMPTS = 2;
const PROBE_RETRY_DELAY_MS = 500;
// 烧录后设备复位重启，等固件把串口调试任务跑起来再探测。
const POST_FLASH_SETTLE_MS = 1500;
const POST_FLASH_PROBE_ATTEMPTS = 4;

function serviceError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function isCh34xPort(port) {
  return String(port?.vendorId || '').toLowerCase() === CH34X_VENDOR_ID;
}

class AutoProvisionService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(0);
    this.serialService = options.serialService || defaultSerialService;
    this.flashService = options.flashService || defaultFlashService;
    this.storage = options.storage || fileStorage;
    this.setTimeoutFn = options.setTimeout || setTimeout;
    this.settings = this.loadSettings();
    this.enabled = false;
    this.entries = new Map();
    this.runs = new Map();
    this.previousAutoConnect = null;
    this.listenersBound = false;
    this.token = Symbol('auto-provision');
  }

  loadSettings() {
    try {
      const parsed = JSON.parse(this.storage.getItem(SETTINGS_KEY) || 'null');
      return {
        autoFlash: parsed?.autoFlash === true,
        deviceType: typeof parsed?.deviceType === 'string' ? parsed.deviceType : '',
      };
    } catch (_) {
      return { autoFlash: false, deviceType: '' };
    }
  }

  saveSettings() {
    this.storage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
  }

  getSettings() {
    return { ...this.settings };
  }

  setSettings(patch = {}) {
    if (patch.autoFlash !== undefined) {
      if (typeof patch.autoFlash !== 'boolean') {
        throw serviceError('AUTO_FLASH_INVALID', 'autoFlash must be a boolean', 400);
      }
      this.settings.autoFlash = patch.autoFlash;
    }
    if (patch.deviceType !== undefined) {
      if (patch.deviceType !== null && typeof patch.deviceType !== 'string') {
        throw serviceError('DEVICE_TYPE_INVALID', 'deviceType must be a string', 400);
      }
      this.settings.deviceType = String(patch.deviceType || '').trim();
    }
    this.saveSettings();
    this.emitUpdate();
    return this.getSettings();
  }

  getState() {
    return {
      enabled: this.enabled,
      settings: this.getSettings(),
      ports: [...this.entries.values()]
        .map((entry) => ({ ...entry }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  emitUpdate() {
    this.emit('update', this.getState());
  }

  // 页面打开：临时强制串口自动连接，记住原值以便离开时恢复。
  async start() {
    if (this.enabled) return this.getState();
    this.enabled = true;
    this.previousAutoConnect = this.serialService.getSettings().autoConnect === true;
    this.bindListeners();
    if (!this.previousAutoConnect) {
      await this.serialService.setSettings({ autoConnect: true });
    }
    logger.info('AutoProvision', `测试台串口供给开启 (原自动连接=${this.previousAutoConnect})`);
    await this.syncPorts();
    this.emitUpdate();
    return this.getState();
  }

  async stop() {
    if (!this.enabled) return this.getState();
    this.enabled = false;
    this.unbindListeners();
    await Promise.allSettled([...this.runs.values()]);
    this.runs.clear();
    for (const path of [...this.entries.keys()]) {
      this.serialService.releasePort(path, this.token);
    }
    this.entries.clear();
    if (this.previousAutoConnect === false) {
      await this.serialService.setSettings({ autoConnect: false }).catch((error) => {
        logger.warn('AutoProvision', `恢复串口自动连接设置失败: ${error?.message || error}`);
      });
    }
    this.previousAutoConnect = null;
    logger.info('AutoProvision', '测试台串口供给关闭');
    this.emitUpdate();
    return this.getState();
  }

  bindListeners() {
    if (this.listenersBound) return;
    this.onPortAdded = (port) => {
      this.handlePortAdded(port).catch((error) => {
        logger.warn('AutoProvision', `端口 ${port?.path} 处理失败: ${error?.message || error}`);
      });
    };
    this.onPortRemoved = ({ path }) => this.handlePortRemoved(path);
    this.serialService.on('port-added', this.onPortAdded);
    this.serialService.on('port-removed', this.onPortRemoved);
    this.listenersBound = true;
  }

  unbindListeners() {
    if (!this.listenersBound) return;
    this.serialService.off('port-added', this.onPortAdded);
    this.serialService.off('port-removed', this.onPortRemoved);
    this.listenersBound = false;
  }

  // 页面刚打开时，把已经插着的端口也纳入流水线（已连上的直接记为 connected）。
  async syncPorts() {
    let ports = [];
    try {
      ports = await this.serialService.listPorts();
    } catch (error) {
      logger.warn('AutoProvision', `串口枚举失败: ${error?.message || error}`);
      return;
    }
    for (const port of ports) {
      if (!this.entries.has(port.path)) this.trackPort(port);
      if (port.status === 'connected') {
        this.updateEntry(port.path, {
          stage: 'connected',
          deviceId: port.deviceId,
          message: '设备已连接',
        });
      } else {
        this.schedulePipeline(port.path);
      }
    }
  }

  trackPort(port) {
    this.entries.set(port.path, {
      path: port.path,
      friendlyName: port.friendlyName || port.manufacturer || '',
      vendorId: port.vendorId || null,
      ch34x: isCh34xPort(port),
      stage: 'pending',
      message: '等待处理',
      deviceId: null,
      deviceType: null,
      flashProgress: null,
      attempts: 0,
      flashed: false,
      error: null,
      updatedAt: new Date().toISOString(),
    });
  }

  updateEntry(path, patch) {
    const entry = this.entries.get(path);
    if (!entry) return null;
    Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
    this.emitUpdate();
    return entry;
  }

  handlePortRemoved(path) {
    this.serialService.releasePort(path, this.token);
    if (this.entries.delete(path)) this.emitUpdate();
  }

  async handlePortAdded(port) {
    if (!this.enabled) return;
    if (!this.entries.has(port.path)) this.trackPort(port);
    else this.updateEntry(port.path, { vendorId: port.vendorId || null, ch34x: isCh34xPort(port) });
    this.schedulePipeline(port.path);
  }

  schedulePipeline(path, options = {}) {
    if (!this.enabled || !this.entries.has(path)) return null;
    if (this.runs.has(path)) return this.runs.get(path);
    const entry = this.entries.get(path);
    if (entry.stage === 'connected') return null;
    // failed 是终态：只有手动 retry 或拔插后重新出现才再跑。
    if (entry.stage === 'failed' && !options.manual) return null;

    const run = this.runPipeline(path, options)
      .catch((error) => {
        logger.warn('AutoProvision', `端口 ${path} 流水线异常: ${error?.message || error}`);
      })
      .finally(() => this.runs.delete(path));
    this.runs.set(path, run);
    return run;
  }

  async retry(path) {
    const entry = this.entries.get(path);
    if (!entry) throw serviceError('PORT_NOT_TRACKED', `端口 ${path} 不在测试台管理范围内`, 404);
    if (this.runs.has(path)) return this.getState();
    this.updateEntry(path, {
      stage: 'pending', message: '手动重试', error: null, attempts: 0, flashed: false, flashProgress: null,
    });
    await this.schedulePipeline(path, { manual: true });
    return this.getState();
  }

  // 流水线：预留端口 → 探测 → (失败且允许时)烧录 → 再探测 → 成功/失败终态
  async runPipeline(path, options = {}) {
    const release = this.serialService.reservePort(path, this.token);
    try {
      this.updateEntry(path, { stage: 'probing', message: '尝试串口连接', error: null });
      const first = await this.probe(path, PROBE_MAX_ATTEMPTS);
      if (first.ok) return this.markConnected(path, first.device);

      const decision = this.decideFlash(path, first.error, options);
      if (!decision.allowed) {
        return this.markFailed(path, first.error, decision.reason);
      }

      const flashed = await this.flash(path, decision.deviceType);
      if (!flashed.ok) return this.markFailed(path, flashed.error, '固件烧录失败');

      this.updateEntry(path, {
        stage: 'probing', flashed: true, flashProgress: 100, message: '烧录完成，重新连接设备',
      });
      await this.sleep(POST_FLASH_SETTLE_MS);
      const second = await this.probe(path, POST_FLASH_PROBE_ATTEMPTS);
      if (second.ok) return this.markConnected(path, second.device);
      return this.markFailed(path, second.error, '烧录后仍无法连接');
    } finally {
      // 成功与非终态释放预留交还给自动轮询；failed 终态保持预留以阻断自动重试。
      const entry = this.entries.get(path);
      if (!entry || entry.stage !== 'failed') release();
    }
  }

  async probe(path, maxAttempts) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!this.enabled || !this.entries.has(path)) {
        return { ok: false, error: serviceError('AUTO_PROVISION_CANCELLED', '流程已取消', 409) };
      }
      this.updateEntry(path, {
        stage: 'probing',
        attempts: attempt,
        message: `尝试串口连接（第 ${attempt}/${maxAttempts} 次）`,
      });
      try {
        const device = await this.serialService.connect(path, {
          automatic: false,
          reservationToken: this.token,
        });
        return { ok: true, device };
      } catch (error) {
        lastError = error;
        logger.info('AutoProvision', `端口 ${path} 第 ${attempt} 次握手失败: ${error?.code} ${error?.message}`);
        if (attempt < maxAttempts) await this.sleep(PROBE_RETRY_DELAY_MS);
      }
    }
    return { ok: false, error: lastError };
  }

  decideFlash(path, error, options = {}) {
    const entry = this.entries.get(path);
    if (entry?.flashed) return { allowed: false, reason: '本轮已烧录过，不重复烧录' };
    if (!this.settings.autoFlash && !options.forceFlash) {
      return { allowed: false, reason: '未开启自动烧录' };
    }
    if (!entry?.ch34x) {
      return { allowed: false, reason: '非 CH34x(VID 1A86) 串口，跳过烧录以免写坏其他设备' };
    }
    if (!FLASHABLE_PROBE_CODES.includes(error?.code)) {
      return { allowed: false, reason: `握手失败原因不适合烧录 (${error?.code || 'UNKNOWN'})` };
    }
    const deviceType = String(this.settings.deviceType || '').trim();
    if (!deviceType) return { allowed: false, reason: '未选择烧录型号' };
    return { allowed: true, deviceType };
  }

  async flash(path, deviceType) {
    this.updateEntry(path, {
      stage: 'flashing', deviceType, flashProgress: 0, message: '准备烧录固件',
    });
    try {
      const { flashId } = await this.flashService.startFlash(
        { path, deviceType },
        { reservationToken: this.token },
      );
      const unsubscribe = this.flashService.onFlashStatus(flashId, (status) => {
        this.updateEntry(path, {
          stage: 'flashing',
          flashProgress: status.progress,
          message: status.msg || `烧录 ${status.status}`,
        });
      });
      let final;
      try {
        final = await this.flashService.waitForFlash(flashId);
      } finally {
        unsubscribe();
      }
      if (final?.status !== 'success') {
        const err = final?.error || {};
        return {
          ok: false,
          error: serviceError(err.code || 'FLASH_FAILED', err.message || final?.msg || '烧录失败', 500),
        };
      }
      return { ok: true, status: final };
    } catch (error) {
      return { ok: false, error };
    }
  }

  markConnected(path, device) {
    return this.updateEntry(path, {
      stage: 'connected',
      deviceId: device?.id || null,
      deviceType: device?.type && device.type !== 'base' ? device.type : this.entries.get(path)?.deviceType,
      message: '设备已连接，自动化测试将自动开始',
      error: null,
    });
  }

  markFailed(path, error, reason) {
    const code = error?.code || 'AUTO_PROVISION_FAILED';
    const detail = error?.message || String(error || '未知错误');
    logger.warn('AutoProvision', `端口 ${path} 进入失败终态: ${reason} (${code})`);
    return this.updateEntry(path, {
      stage: 'failed',
      flashProgress: null,
      message: reason,
      error: { code, message: detail, reason },
    });
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = this.setTimeoutFn(resolve, ms);
      timer?.unref?.();
    });
  }

  resetForTests() {
    this.unbindListeners();
    this.enabled = false;
    this.entries.clear();
    this.runs.clear();
    this.previousAutoConnect = null;
    this.settings = { autoFlash: false, deviceType: '' };
    this.removeAllListeners();
  }
}

const autoProvisionService = new AutoProvisionService();

module.exports = autoProvisionService;
module.exports.AutoProvisionService = AutoProvisionService;
module.exports.constants = {
  SETTINGS_KEY,
  CH34X_VENDOR_ID,
  FLASHABLE_PROBE_CODES,
  PROBE_MAX_ATTEMPTS,
  POST_FLASH_SETTLE_MS,
  POST_FLASH_PROBE_ATTEMPTS,
};
