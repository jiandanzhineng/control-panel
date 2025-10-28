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

const cp = require('child_process');
const mqttService = require('../services/mqttService');

describe('mqttService', () => {
  afterEach(() => {
    try { mqttService.stop(); } catch (_) {}
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('start -> status -> stop: should manage mosquitto lifecycle and cleanup temp conf', () => {
    const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    const res = mqttService.start({ port: 1883, bind: '0.0.0.0' });
    expect(res.running).toBe(true);
    expect(typeof res.pid).toBe('number');
    expect(res.port).toBe(1883);

    const s1 = mqttService.status();
    expect(s1.running).toBe(true);
    expect(s1.pid).toBe(res.pid);
    expect(s1.port).toBe(1883);

    const stopped = mqttService.stop();
    expect(stopped.running).toBe(false);

    const s2 = mqttService.status();
    expect(s2.running).toBe(false);

    expect(unlinkSpy).toHaveBeenCalled();
  });

  it('start when already running should reuse existing process and not respawn', () => {
    const first = mqttService.start({ port: 1884, bind: '127.0.0.1' });
    const second = mqttService.start({ port: 1884, bind: '127.0.0.1' });

    expect(first.running).toBe(true);
    expect(second.running).toBe(true);
    expect(second.pid).toBe(first.pid);
    expect(cp.spawn).toHaveBeenCalledTimes(1);
  });
});