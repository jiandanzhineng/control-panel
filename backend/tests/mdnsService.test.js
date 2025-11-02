// Mock child_process.spawn to avoid real python dependency
jest.mock('child_process', () => {
  const children = [];
  let pidSeed = 30000;
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
const mdnsService = require('../services/mdnsService');

describe('mdnsService', () => {
  afterEach(() => {
    try { mdnsService.unpublish(); } catch (_) {}
    jest.clearAllMocks();
  });

  it('publish -> status -> unpublish: should manage single mdns instance', () => {
    const res = mdnsService.publish({ ip: '192.168.1.10' });
    expect(res.running).toBe(true);
    expect(typeof res.pid).toBe('number');
    expect(res.ip).toBe('192.168.1.10');

    const status = mdnsService.status();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(res.pid);
    expect(status.ip).toBe('192.168.1.10');

    const out = mdnsService.unpublish();
    expect(out.running).toBe(false);

    const status2 = mdnsService.status();
    expect(status2.running).toBe(false);

    // verify child kill happened via mocked child state
    const child = cp.__mockChildren[0];
    expect(child.killed).toBe(true);
  });

  it('should replace existing instance when publishing new one', () => {
    const res1 = mdnsService.publish({ ip: '192.168.1.10' });
    expect(res1.running).toBe(true);

    const res2 = mdnsService.publish({ ip: '192.168.1.20' });
    expect(res2.running).toBe(true);
    expect(res2.ip).toBe('192.168.1.20');

    const status = mdnsService.status();
    expect(status.running).toBe(true);
    expect(status.ip).toBe('192.168.1.20');

    // verify first child was killed
    const child1 = cp.__mockChildren[0];
    expect(child1.killed).toBe(true);
  });
});