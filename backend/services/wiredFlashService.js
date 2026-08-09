const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { execFile } = require('child_process');
const logService = require('./logService');
const defaultSerialConnectionService = require('./serialConnectionService');
const manifestService = require('./firmwareManifestService');
const defaultSerialReset = require('../transports/serialReset');
const { NodeSerialDevice } = require('../transports/nodeSerialDevice');
const { getAllDeviceTypes } = require('../config/deviceTypes');

const { createServiceError } = manifestService;

const IDENTIFY_BAUD_RATE = 115200;
const IDENTIFY_CAPTURE_MS = 4000;
const CONNECT_MAX_ATTEMPTS = 3;
const CONNECT_RETRY_DELAY_MS = 500;
const FLASH_STATUSES = [
  'pending',
  'downloading',
  'verifying',
  'entering_bootloader',
  'flashing',
  'resetting',
  'success',
  'failed',
];

// 已知型号兜底清单,来源: hardware 仓库 GitHub Action 固件构建矩阵。
// 优先使用 backend devices registry 里的型号列表,registry 为空时退回该常量。
const KNOWN_DEVICE_TYPES = ['TD01', 'DIANJI', 'QTZ', 'ZIDONGSUO', 'PJ01', 'QIYA', 'DZC01', 'CUNZHI01'];

const silentTerminal = {
  clean() {},
  writeLine() {},
  write() {},
};

function runPowerShell(script, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

class WiredFlashService {
  constructor(options = {}) {
    this.SerialPortClass = options.SerialPortClass || null;
    this.serialReset = options.serialReset || defaultSerialReset;
    this.loadEsptool = options.loadEsptool || (() => import('esptool-js/bundle.js'));
    this.serialConnectionService = options.serialConnectionService || defaultSerialConnectionService;
    this.manifestService = options.manifestService || manifestService;
    this.downloadFetcher = options.downloadFetcher || null;
    this.cacheDir = options.cacheDir || path.join(__dirname, '..', 'data', 'wired-flash-cache');
    this.sleep = options.sleep || sleep;
    this.createFlashId = options.createFlashId || (() => crypto.randomUUID());
    this.createDevice = options.createDevice || ((portPath) => new NodeSerialDevice(portPath));
    this.runCommand = options.runCommand || runPowerShell;

    this.flashStatusMap = new Map();
    this.statusHandlers = new Map();
    this.flashPromises = new Map();
  }

  getSerialPortClass() {
    // 懒加载:没有原生绑定的环境也能启动,首次用到串口才报错
    if (!this.SerialPortClass) this.SerialPortClass = require('serialport').SerialPort;
    return this.SerialPortClass;
  }

  getDownloadFetcher() {
    if (this.downloadFetcher) return this.downloadFetcher;
    if (typeof fetch !== 'function') {
      throw createServiceError('FIRMWARE_DOWNLOAD_FAILED', '当前 Node.js 运行环境不支持 fetch', 500);
    }
    return fetch;
  }

  getKnownDeviceTypes() {
    let types = [];
    try {
      types = getAllDeviceTypes();
    } catch (_) {
      types = [];
    }
    if (!Array.isArray(types) || types.length === 0) return KNOWN_DEVICE_TYPES;
    return types;
  }

  // WCH(沁恒) CH340/CH341/CH343/CH344 的 USB VID 均为 1A86。
  // 驱动未装时设备不进串口列表,而是作为带错误码的 PnP 设备存在,
  // 只能通过 Win32_PnPEntity 的 ConfigManagerErrorCode 检测(非 0 即异常)。
  async getDriverStatus() {
    if (process.platform !== 'win32') {
      return { checked: false, reason: '仅支持 Windows 驱动检测', driverMissing: false, problemDevices: [] };
    }
    let stdout;
    try {
      stdout = await this.runCommand(
        "Get-CimInstance Win32_PnPEntity | Where-Object { $_.DeviceID -match 'VID_1A86' } " +
          '| Select-Object Name, DeviceID, Status, ConfigManagerErrorCode | ConvertTo-Json -Compress',
      );
    } catch (error) {
      throw createServiceError('DRIVER_CHECK_FAILED', `驱动状态检测失败: ${error?.message || error}`, 500);
    }

    let parsed = [];
    const text = String(stdout || '').trim();
    if (text) {
      try {
        const json = JSON.parse(text);
        parsed = Array.isArray(json) ? json : [json];
      } catch (_) {
        parsed = [];
      }
    }

    const devices = parsed.map((item) => ({
      name: String(item?.Name || ''),
      deviceId: String(item?.DeviceID || ''),
      status: String(item?.Status || ''),
      errorCode: Number(item?.ConfigManagerErrorCode ?? 0),
    }));
    const problemDevices = devices.filter((device) => device.errorCode !== 0);
    return {
      checked: true,
      driverMissing: problemDevices.length > 0,
      problemDevices,
      deviceCount: devices.length,
    };
  }

  isPortBusy(path) {
    const svc = this.serialConnectionService;
    return !!(svc?.sessions?.has(path) || svc?.pendingConnections?.has(path));
  }

  assertPortFree(path) {
    if (this.isPortBusy(path)) {
      throw createServiceError('SERIAL_PORT_BUSY', `串口 ${path} 已被连接占用，请先断开串口连接再操作`, 409);
    }
  }

  async listPorts() {
    let ports;
    try {
      ports = await this.getSerialPortClass().list();
    } catch (error) {
      throw createServiceError('SERIAL_ENUMERATION_FAILED', error?.message || '无法枚举串口', 500);
    }

    return (ports || [])
      .filter((port) => port?.path)
      .map((port) => {
        const session = this.serialConnectionService?.sessions?.get(port.path);
        return {
          ...port,
          busy: this.isPortBusy(port.path),
          deviceId: session?.deviceId || null,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  // 通过启动日志识别设备(该机 @DEBUG START 握手因传感器故障不可用):
  // 115200 打开 → {dtr:true,rts:true} → 复位脉冲 {dtr:false,rts:false} 150ms
  // → {dtr:true,rts:true} → 采集 4 秒输出并解析版本/MAC/型号。
  // 识别不到型号不报错,返回 identified:false,由前端让用户手选。
  async identify(portPath) {
    const normalizedPath = typeof portPath === 'string' ? portPath.trim() : '';
    if (!normalizedPath) {
      throw createServiceError('SERIAL_PATH_REQUIRED', 'Serial port path is required', 400);
    }
    this.assertPortFree(normalizedPath);

    const SerialPort = this.getSerialPortClass();
    const port = new SerialPort({
      path: normalizedPath,
      baudRate: IDENTIFY_BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false,
    });

    let log = '';
    const onData = (chunk) => { log += chunk.toString('utf8'); };

    try {
      await new Promise((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())));
      port.on('data', onData);
      await this.setLines(port, { dtr: true, rts: true });
      // 复位脉冲:EN 低 150ms 后释放,BOOT 保持高 → 重启进 app 打印启动日志
      await this.setLines(port, { dtr: false, rts: false });
      await this.sleep(150);
      await this.setLines(port, { dtr: true, rts: true });
      await this.sleep(IDENTIFY_CAPTURE_MS);
    } catch (error) {
      if (error?.code) throw error;
      throw createServiceError('SERIAL_IDENTIFY_FAILED', error?.message || '串口识别失败', 409);
    } finally {
      if (port.isOpen) await new Promise((resolve) => port.close(() => resolve()));
    }

    return { path: normalizedPath, ...this.parseBootLog(log) };
  }

  setLines(port, flags) {
    return new Promise((resolve, reject) => port.set(flags, (e) => (e ? reject(e) : resolve())));
  }

  parseBootLog(log) {
    const text = typeof log === 'string' ? log : '';

    const versionMatch = text.match(/App version:\s*(v[\d.]+)/);
    const version = versionMatch ? versionMatch[1] : null;

    let mac = null;
    const macMatch = text.match(/MAC Address:\s*([0-9a-fA-F]{12})/);
    if (macMatch) {
      mac = macMatch[1].toLowerCase();
    } else {
      const staMatch = text.match(/sta \(([0-9a-fA-F:]{17})\)/);
      if (staMatch) mac = staMatch[1].replace(/:/g, '').toLowerCase();
    }

    // 型号优先用 device_init/on_device_init 行的日志标签识别(如 `I (610) QTZ: device_init`),
    // 避免正文里偶然出现的型号字符串(如共享组件的 `td01:` 模块标签)误判;
    // init 行没有命中再回退到全文词边界匹配。长的型号先匹配,避免短型号成为长型号前缀时误判。
    let deviceType = null;
    const candidates = [...this.getKnownDeviceTypes()].sort((a, b) => b.length - a.length);
    const initTags = new Set();
    for (const match of text.matchAll(/\b([A-Za-z0-9_]+):\s*(?:on_)?device_init\b/g)) {
      initTags.add(match[1].toUpperCase());
    }
    for (const type of candidates) {
      if (initTags.has(type.toUpperCase())) {
        deviceType = type;
        break;
      }
    }
    if (!deviceType) {
      for (const type of candidates) {
        if (new RegExp(`\\b${escapeRegExp(type)}\\b`, 'i').test(text)) {
          deviceType = type;
          break;
        }
      }
    }

    return {
      identified: !!deviceType,
      deviceType,
      version,
      mac,
    };
  }

  async getFirmwareForDevice(deviceType, currentVersion) {
    if (!deviceType || typeof deviceType !== 'string') {
      throw createServiceError('DEVICE_TYPE_REQUIRED', 'deviceType is required', 400);
    }
    const manifest = await this.manifestService.fetchLatestManifest();
    const entry = this.manifestService.findFirmware(manifest, deviceType, 'merged');
    const firmware = this.manifestService.toFirmwareInfo(entry);
    const latestVersion = manifest.latest_version || null;

    return {
      supported: !!firmware,
      currentVersion: currentVersion || null,
      latestVersion,
      updateAvailable: !!firmware && this.manifestService.isUpdateAvailable(currentVersion, latestVersion),
      firmware,
    };
  }

  async startFlash({ path: portPath, deviceType } = {}) {
    const normalizedPath = typeof portPath === 'string' ? portPath.trim() : '';
    if (!normalizedPath) {
      throw createServiceError('SERIAL_PATH_REQUIRED', 'Serial port path is required', 400);
    }
    if (!deviceType || typeof deviceType !== 'string') {
      throw createServiceError('DEVICE_TYPE_REQUIRED', 'deviceType is required', 400);
    }
    this.assertPortFree(normalizedPath);

    const flashId = this.createFlashId();
    this.recordFlashStatus(flashId, { status: 'pending', progress: 0, msg: '烧录任务已创建' }, {
      path: normalizedPath,
      deviceType,
    });

    // 延迟一个 tick 启动,保证调用方在 startFlash 返回后再订阅也能看到全部状态流转
    const run = Promise.resolve().then(() => this.runFlash(flashId, { path: normalizedPath, deviceType }));
    this.flashPromises.set(flashId, run);
    run.finally(() => this.flashPromises.delete(flashId)).catch(() => {});

    return { flashId };
  }

  async runFlash(flashId, { path: portPath, deviceType }) {
    let transport = null;
    try {
      // 1. 下载固件(带 sha256 缓存)
      this.recordFlashStatus(flashId, { status: 'downloading', progress: 0, msg: '获取固件清单' });
      const manifest = await this.manifestService.fetchLatestManifest();
      const entry = this.manifestService.findFirmware(manifest, deviceType, 'merged');
      const firmware = this.manifestService.toFirmwareInfo(entry);
      if (!firmware) {
        throw createServiceError('FIRMWARE_NOT_SUPPORTED', `设备类型 ${deviceType} 暂无整片烧录固件`, 404);
      }
      const filePath = await this.ensureFirmwareCached(firmware);

      // 2. 校验 sha256
      this.recordFlashStatus(flashId, { status: 'verifying', progress: null, msg: '校验固件完整性' });
      const actualSha256 = await sha256File(filePath);
      if (firmware.sha256 && actualSha256 !== String(firmware.sha256).toLowerCase()) {
        throw createServiceError(
          'FIRMWARE_CHECKSUM_MISMATCH',
          `固件校验失败: 期望 ${firmware.sha256}, 实际 ${actualSha256}`,
          502,
        );
      }
      const data = new Uint8Array(await fs.readFile(filePath));

      // 3. 进下载模式并与 ROM 同步(重试 3 次)
      this.recordFlashStatus(flashId, { status: 'entering_bootloader', progress: null, msg: '进入下载模式' });
      this.assertPortFree(portPath);
      const esptool = await this.loadEsptool();
      const connected = await this.connectWithRetry(portPath, esptool);
      transport = connected.transport;
      const esploader = connected.esploader;

      // 4. 烧录 merged 镜像到 0x0(不做整片 erase;merged bin 会覆盖 NVS,烧完配网信息丢失,属预期)
      this.recordFlashStatus(flashId, { status: 'flashing', progress: 0, msg: '开始烧录' });
      await esploader.writeFlash({
        fileArray: [{ data, address: 0x0 }],
        flashMode: 'dio',
        flashFreq: '80m',
        flashSize: '4MB',
        eraseAll: false,
        compress: true,
        reportProgress: (i, written, total) => {
          const progress = total > 0 ? Math.floor((written / total) * 100) : null;
          this.recordFlashStatus(flashId, {
            status: 'flashing',
            progress,
            msg: `烧录中 ${written}/${total}`,
          });
        },
      });

      // 5. 断开并复位回 app
      this.recordFlashStatus(flashId, { status: 'resetting', progress: null, msg: '复位设备' });
      try { await transport.disconnect(); } catch (_) {}
      transport = null;
      await this.serialReset.hardResetToApp(portPath);

      this.recordFlashStatus(flashId, {
        status: 'success',
        progress: 100,
        msg: '烧录完成，设备已重启',
      }, { firmwareVersion: manifest.latest_version || null, filename: firmware.filename || null });
    } catch (error) {
      if (transport) {
        try { await transport.disconnect(); } catch (_) {}
      }
      const serviceError = error?.code
        ? error
        : createServiceError('FLASH_FAILED', error?.message || '烧录失败', 500);
      this.recordFlashStatus(flashId, {
        status: 'failed',
        progress: null,
        msg: serviceError.message,
        error: {
          code: serviceError.code,
          message: serviceError.message,
          status: serviceError.status || 500,
        },
      });
    }
    return this.getFlashStatus(flashId);
  }

  async connectWithRetry(portPath, esptool) {
    let lastError = null;
    for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt += 1) {
      let transport = null;
      try {
        await this.serialReset.enterDownloadMode(portPath);
        const device = this.createDevice(portPath);
        transport = new esptool.Transport(device, false);
        const esploader = new esptool.ESPLoader({
          transport,
          baudrate: 115200,
          romBaudrate: 115200,
          terminal: silentTerminal,
        });
        await esploader.main('no_reset');
        return { transport, esploader };
      } catch (error) {
        lastError = error;
        logService.warn('WiredFlash', `连接下载模式第 ${attempt} 次失败: ${error?.message || error}`);
        if (transport) {
          try { await transport.disconnect(); } catch (_) {}
        }
        if (attempt < CONNECT_MAX_ATTEMPTS) await this.sleep(CONNECT_RETRY_DELAY_MS);
      }
    }
    throw createServiceError(
      'FLASH_CONNECT_FAILED',
      `进入下载模式失败(重试 ${CONNECT_MAX_ATTEMPTS} 次): ${lastError?.message || lastError}`,
      502,
    );
  }

  async ensureFirmwareCached(firmware) {
    const cachePath = path.join(this.cacheDir, `${String(firmware.sha256).toLowerCase()}.bin`);

    try {
      const cachedSha = await sha256File(cachePath);
      if (!firmware.sha256 || cachedSha === String(firmware.sha256).toLowerCase()) return cachePath;
      logService.warn('WiredFlash', '缓存固件校验不一致，重新下载');
    } catch (_) {
      // 缓存不存在,走下载
    }

    const fetcher = this.getDownloadFetcher();
    const res = await fetcher(firmware.url, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res?.ok) {
      throw createServiceError('FIRMWARE_DOWNLOAD_FAILED', `固件下载失败: HTTP ${res?.status || 'unknown'}`, 502);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (firmware.sizeBytes && buffer.length !== firmware.sizeBytes) {
      throw createServiceError(
        'FIRMWARE_DOWNLOAD_FAILED',
        `固件大小不符: 期望 ${firmware.sizeBytes}, 实际 ${buffer.length}`,
        502,
      );
    }

    await fs.mkdir(this.cacheDir, { recursive: true });
    const tempPath = `${cachePath}.download`;
    await fs.writeFile(tempPath, buffer);
    await fs.rename(tempPath, cachePath);
    return cachePath;
  }

  recordFlashStatus(flashId, payload = {}, context = {}) {
    const previous = this.flashStatusMap.get(flashId) || {};
    const status = FLASH_STATUSES.includes(payload.status) ? payload.status : 'pending';

    let progress;
    if (status === 'success') progress = 100;
    else if (status === 'pending') progress = 0;
    else {
      const num = Number(payload.progress);
      progress = Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : null;
    }

    const next = {
      flashId,
      path: context.path || previous.path || null,
      deviceType: context.deviceType || previous.deviceType || null,
      status,
      progress,
      msg: typeof payload.msg === 'string' ? payload.msg : '',
      error: payload.error || null,
      updatedAt: new Date().toISOString(),
      firmwareVersion: context.firmwareVersion || previous.firmwareVersion || null,
      filename: context.filename || previous.filename || null,
    };

    this.flashStatusMap.set(flashId, next);
    this.emitFlashStatus(flashId, next);
    return next;
  }

  getFlashStatus(flashId) {
    return this.flashStatusMap.get(flashId) || null;
  }

  onFlashStatus(flashId, handler) {
    if (!this.statusHandlers.has(flashId)) this.statusHandlers.set(flashId, new Set());
    const handlers = this.statusHandlers.get(flashId);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.statusHandlers.delete(flashId);
    };
  }

  emitFlashStatus(flashId, status) {
    const handlers = this.statusHandlers.get(flashId);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(status);
      } catch (error) {
        logService.warn('WiredFlash', `烧录状态推送失败: ${error?.message || error}`);
      }
    }
  }

  // 等待烧录流程结束(测试与内部用),返回最终状态
  waitForFlash(flashId) {
    return this.flashPromises.get(flashId) || Promise.resolve(this.getFlashStatus(flashId));
  }

  resetForTests() {
    this.flashStatusMap.clear();
    this.statusHandlers.clear();
    this.flashPromises.clear();
  }
}

const wiredFlashService = new WiredFlashService();

module.exports = wiredFlashService;
module.exports.WiredFlashService = WiredFlashService;
module.exports.constants = {
  IDENTIFY_BAUD_RATE,
  IDENTIFY_CAPTURE_MS,
  CONNECT_MAX_ATTEMPTS,
  KNOWN_DEVICE_TYPES,
};
