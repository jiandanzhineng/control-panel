const serialReset = require('../transports/serialReset');

class MockPort {
  constructor() {
    this.isOpen = false;
    this.setCalls = [];
  }

  open(cb) {
    this.isOpen = true;
    setImmediate(() => cb(null));
  }

  close(cb) {
    this.isOpen = false;
    setImmediate(() => cb(null));
  }

  set(flags, cb) {
    this.setCalls.push({ ...flags });
    setImmediate(() => cb(null));
  }
}

class MockDevice {
  constructor() {
    this.signalCalls = [];
    this.port = { isOpen: true };
  }

  async setSignals(signals) {
    this.signalCalls.push({ ...signals });
  }
}

describe('serialReset 下载模式时序', () => {
  afterEach(() => {
    serialReset.setSerialPortClass(null);
  });

  test('enterDownloadModeOnDevice 在已打开句柄上拉复位并保持 BOOT 低', async () => {
    const device = new MockDevice();
    await serialReset.enterDownloadModeOnDevice(device);
    expect(device.signalCalls).toEqual([
      { dataTerminalReady: false, requestToSend: true },
      { dataTerminalReady: true, requestToSend: false },
    ]);
  });

  test('enterDownloadMode 关口前完成同一时序', async () => {
    const instances = [];
    class Port extends MockPort {
      constructor() {
        super();
        instances.push(this);
      }
    }
    serialReset.setSerialPortClass(Port);
    await serialReset.enterDownloadMode('COM17');
    expect(instances).toHaveLength(1);
    expect(instances[0].setCalls).toEqual([
      { dtr: false, rts: true },
      { dtr: true, rts: false },
    ]);
    expect(instances[0].isOpen).toBe(false);
  });
});
