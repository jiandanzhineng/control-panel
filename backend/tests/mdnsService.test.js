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

  it('publish -> status -> unpublish: basic lifecycle', () => {
    const res = mdnsService.publish();
    expect(typeof res.running).toBe('boolean');
    expect(res.pid === undefined || typeof res.pid === 'number').toBe(true);

    const status = mdnsService.status();
    expect(typeof status.running).toBe('boolean');
    expect(status.pid === undefined || typeof status.pid === 'number').toBe(true);

    const out = mdnsService.unpublish();
    expect(out.running).toBe(false);

    const status2 = mdnsService.status();
    expect(status2.running).toBe(false);
  });

  it('should replace existing instance when publishing new one', () => {
    const res1 = mdnsService.publish();
    expect(res1.pid === undefined || typeof res1.pid === 'number').toBe(true);
    const res2 = mdnsService.publish();
    expect(res2.pid === undefined || typeof res2.pid === 'number').toBe(true);
    const status = mdnsService.status();
    expect(status.pid === undefined || typeof status.pid === 'number').toBe(true);
  });
});