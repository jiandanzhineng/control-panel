const fs = require('fs');

// Mock child_process.spawn to avoid real mosquitto dependency
jest.mock('child_process', () => {
  const children = [];
  let pidSeed = 20000;
  const createChild = () => {
    const handlers = {};
    const child = {
      pid: pidSeed++,
      killed: false,
      on(event, cb) {
        handlers[event] = handlers[event] || [];
        handlers[event].push(cb);
      },
      kill(signal) {
        this.killed = true;
        (handlers['exit'] || []).forEach(fn => fn(0));
      }
    };
    return child;
  };
  return {
    spawn: jest.fn(() => {
      const c = createChild();
      children.push(c);
      return c;
    }),
    __mockChildren: children,
  };
});

describe('mqttService', () => {
  const originalPlatform = process.platform;
  let mqttService;
  let cp;

  beforeEach(() => {
    jest.resetModules();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    cp = require('child_process');
    mqttService = require('../services/mqttService');
  });

  afterEach(async () => {
    try { await mqttService.stop(); } catch (_) {}
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('start -> status -> stop: should manage mosquitto lifecycle and cleanup temp conf', async () => {
    const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    const res = await mqttService.start({ port: 1883, bind: '0.0.0.0' });
    expect(res.running).toBe(true);
    expect(typeof res.pid).toBe('number');
    expect(res.port).toBe(1883);

    const s1 = await mqttService.status();
    expect(s1.running).toBe(true);
    expect(s1.pid).toBe(res.pid);
    expect(s1.port).toBe(1883);

    const stopped = await mqttService.stop();
    expect(stopped.running).toBe(false);

    const s2 = await mqttService.status();
    expect(s2.running).toBe(false);

    expect(unlinkSpy).toHaveBeenCalled();
  });

  it('start when already running should reuse existing process and not respawn', async () => {
    const first = await mqttService.start({ port: 1884, bind: '127.0.0.1' });
    const second = await mqttService.start({ port: 1884, bind: '127.0.0.1' });

    expect(first.running).toBe(true);
    expect(second.running).toBe(true);
    expect(second.pid).toBe(first.pid);
    expect(cp.spawn).toHaveBeenCalledTimes(1);
  });
});

describe('mqttService on Windows', () => {
  const originalPlatform = process.platform;
  let mqttService;
  let emqxService;

  beforeEach(() => {
    jest.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    jest.doMock('../services/emqxService', () => ({
      checkStatus: jest.fn(async () => ({ running: true, status: 'running' })),
      startBroker: jest.fn(async () => ({ success: true })),
      stopBroker: jest.fn(async () => ({ success: true })),
    }));
    emqxService = require('../services/emqxService');
    mqttService = require('../services/mqttService');
  });

  afterEach(async () => {
    try { await mqttService.stop(); } catch (_) {}
    jest.dontMock('../services/emqxService');
    jest.restoreAllMocks();
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('coalesces concurrent starts and reuses an existing EMQX broker', async () => {
    const [first, second] = await Promise.all([
      mqttService.start(),
      mqttService.start(),
    ]);

    expect(first).toMatchObject({ running: true, broker: 'emqx', port: 1883 });
    expect(second).toEqual(first);
    expect(emqxService.checkStatus).toHaveBeenCalledTimes(1);
    expect(emqxService.startBroker).not.toHaveBeenCalled();
  });

  it('does not stop a pre-existing EMQX broker during owned-service cleanup', async () => {
    await mqttService.start();
    const result = await mqttService.stop({ onlyOwned: true });

    expect(result).toMatchObject({ running: true, broker: 'emqx', preserved: true });
    expect(emqxService.stopBroker).not.toHaveBeenCalled();
  });
});
