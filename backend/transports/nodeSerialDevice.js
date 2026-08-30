// Node 端的 WebSerial 形态适配层,供 esptool-js 的 Transport 使用。
// 注意不要用 Readable.toWeb 包装 serialport,实测有坑。
// 打开串口时不改 DTR/RTS：拉回运行态会把芯片踢出下载模式。
let SerialPortClass = null;

function getSerialPortClass() {
  if (!SerialPortClass) SerialPortClass = require('serialport').SerialPort;
  return SerialPortClass;
}

// 测试注入用;传 null 恢复为懒加载 serialport
function setSerialPortClass(cls) {
  SerialPortClass = cls || null;
}

class SerialReadable {
  constructor(port) {
    this.queue = [];
    this.pending = null;
    this.locked = false;
    port.on('data', (chunk) => {
      const value = new Uint8Array(chunk);
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.resolve({ value, done: false });
      } else {
        this.queue.push(value);
      }
    });
  }
  // 不抛异常:允许多次 readLoop 重入(esptool-js 同步失败重试时会再次 getReader)
  getReader() {
    this.locked = true;
    return {
      read: () => (this.queue.length > 0
        ? Promise.resolve({ value: this.queue.shift(), done: false })
        : new Promise((resolve) => { this.pending = { resolve }; })),
      cancel: () => {
        if (this.pending) {
          const p = this.pending;
          this.pending = null;
          p.resolve({ value: undefined, done: true });
        }
        this.locked = false;
        return Promise.resolve();
      },
      releaseLock: () => { this.locked = false; },
    };
  }
}

class SerialWritable {
  constructor(port) { this.port = port; this.locked = false; }
  getWriter() {
    this.locked = true;
    return {
      write: (data) => new Promise((resolve, reject) => {
        this.port.write(Buffer.from(data), (err) => {
          if (err) return reject(err);
          this.port.drain((e2) => (e2 ? reject(e2) : resolve()));
        });
      }),
      close: () => Promise.resolve(),
      releaseLock: () => { this.locked = false; },
    };
  }
}

class NodeSerialDevice {
  constructor(path, info = {}) {
    this.path = path;
    this.info = info;
    this.port = null;
    this._readable = null;
    this._writable = null;
    this.baudRate = 0;
  }
  get readable() { return this._readable; }
  get writable() { return this._writable; }
  getInfo() { return this.info; }

  async open(options = {}) {
    const baudRate = options.baudRate || 115200;
    if (this.port && this.port.isOpen && this.baudRate === baudRate) return;
    await this._closePort();
    const SerialPort = getSerialPortClass();
    this.port = new SerialPort({
      path: this.path, baudRate, dataBits: 8, stopBits: 1, parity: 'none', autoOpen: false,
    });
    await new Promise((resolve, reject) => this.port.open((e) => (e ? reject(e) : resolve())));
    this.baudRate = baudRate;
    this._readable = new SerialReadable(this.port);
    this._writable = new SerialWritable(this.port);
  }

  async setSignals(signals = {}) {
    if (!this.port || !this.port.isOpen) return;
    const flags = {};
    if (typeof signals.dataTerminalReady === 'boolean') flags.dtr = signals.dataTerminalReady;
    if (typeof signals.requestToSend === 'boolean') flags.rts = signals.requestToSend;
    if (Object.keys(flags).length === 0) return;
    await new Promise((resolve, reject) => this.port.set(flags, (e) => (e ? reject(e) : resolve())));
  }

  async _closePort() {
    if (this.port) {
      const p = this.port;
      this.port = null;
      this._readable = null;
      this._writable = null;
      if (p.isOpen) await new Promise((resolve) => p.close(() => resolve()));
    }
  }
  async close() { await this._closePort(); }
}

module.exports = {
  SerialReadable,
  SerialWritable,
  NodeSerialDevice,
  setSerialPortClass,
};
