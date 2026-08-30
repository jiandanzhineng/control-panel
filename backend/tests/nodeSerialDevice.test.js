const { NodeSerialDevice, setSerialPortClass } = require('../transports/nodeSerialDevice');

class MockPort {
  constructor() {
    this.isOpen = false;
    this.setCalls = [];
    this.handlers = {};
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

  on(event, handler) {
    this.handlers[event] = handler;
    return this;
  }
}

describe('NodeSerialDevice', () => {
  afterEach(() => {
    setSerialPortClass(null);
  });

  test('open 不改 DTR/RTS', async () => {
    setSerialPortClass(MockPort);
    const device = new NodeSerialDevice('COM17');
    await device.open({ baudRate: 115200 });
    expect(device.port.setCalls).toEqual([]);
    expect(device.readable).toBeTruthy();
    expect(device.writable).toBeTruthy();
    await device.close();
  });
});
