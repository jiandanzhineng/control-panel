const fs = require('fs');
const path = require('path');
const vm = require('vm');

const gamePath = path.join(
  __dirname,
  '..',
  'games',
  'maid-punishment',
  'game.js'
);

function createElement() {
  return {
    textContent: '',
    style: {},
    children: [],
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children.at(-1) || null; },
    getAttribute: () => null,
    addEventListener: jest.fn(),
    insertBefore(child) { this.children.unshift(child); },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
    },
  };
}

function createDeviceApi() {
  const valueHandlers = [];
  const invocations = [];
  const mapped = new Set(['tiptoeSensor', 'shock']);

  return {
    invocations,
    DeviceAPI: {
      ready: Promise.resolve(),
      params: { tiptoeDebounceMs: 300 },
      log: jest.fn(),
      device(logicalId) {
        return {
          isMapped: () => mapped.has(logicalId),
          invoke(capability, action, params = {}) {
            invocations.push({ logicalId, capability, action, params });
            return Promise.resolve({ ok: true });
          },
          onProperty: jest.fn(),
          onMessage: jest.fn(),
          onValue(_capability, callback) { valueHandlers.push(callback); },
          readValue: () => Promise.resolve(
            logicalId === 'tiptoeSensor' ? [200] : []
          ),
        };
      },
    },
  };
}

async function flushPromises() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

async function loadGame() {
  const logs = createElement();
  const api = createDeviceApi();
  const document = {
    readyState: 'complete',
    createElement,
    getElementById: (id) => (id === 'logs' ? logs : null),
    querySelectorAll: () => [],
  };
  const context = {
    window: {},
    document,
    DeviceAPI: api.DeviceAPI,
    Date,
    Math,
    Promise,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(gamePath, 'utf8'), context, {
    filename: gamePath,
  });
  await flushPromises();
  return { game: context.window.__game, ...api };
}

describe('maid-punishment capability snapshots', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('triggers after debounce when tiptoe pressure is already high at startup', async () => {
    const env = await loadGame();

    expect(env.game.rt.pressure1).toBe(200);
    expect(env.game.rt.pressureViolated).toBe(false);

    jest.advanceTimersByTime(500);
    await flushPromises();

    expect(env.game.rt.pressureViolated).toBe(true);
    expect(env.invocations).toContainEqual({
      logicalId: 'shock',
      capability: 'shock',
      action: 'start',
      params: { voltage: 24 },
    });
  });
});
