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
    // ensure clean state by unpublishing all known entries
    const rows = mdnsService.status();
    for (const row of rows) {
      try { mdnsService.unpublish(row.id); } catch (_) {}
    }
    jest.clearAllMocks();
  });

  it('publish -> status -> unpublish: should manage mdns entries and process', () => {
    const res = mdnsService.publish({ ip: '192.168.1.10' });
    expect(res.running).toBe(true);
    expect(typeof res.pid).toBe('number');
    expect(typeof res.id).toBe('string');
    expect(res.ip).toBe('192.168.1.10');

    const list = mdnsService.status();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(1);
    const row = list.find(r => r.id === res.id);
    expect(row).toBeDefined();
    expect(row.running).toBe(true);
    expect(row.pid).toBe(res.pid);

    const out = mdnsService.unpublish(res.id);
    expect(out.running).toBe(false);

    const list2 = mdnsService.status();
    expect(list2.find(r => r.id === res.id)).toBeUndefined();

    // verify child kill happened via mocked child state
    const child = cp.__mockChildren[0];
    expect(child.killed).toBe(true);
  });
});