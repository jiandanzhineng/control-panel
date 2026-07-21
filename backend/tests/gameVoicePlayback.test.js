const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAMES = {
  drink: {
    file: path.join(__dirname, '..', 'games', 'drink-pee-unlock', 'game.js'),
    globalName: '__game',
    intervalMs: 1000,
    mapped: ['scale', 'punish', 'lock'],
  },
  pressureV1: {
    file: path.join(__dirname, '..', 'games', 'pressure-edging', 'game.js'),
    globalName: '__pe',
    intervalMs: 200,
    mapped: ['sensor', 'motor', 'punish', 'lock'],
  },
  pressureV2: {
    file: path.join(__dirname, '..', 'games', 'pressure-edging-v2', 'game.js'),
    globalName: '__game',
    intervalMs: 200,
    mapped: ['sensor', 'motor', 'punish', 'lock'],
  },
};

function createElement() {
  return {
    textContent: '',
    className: '',
    style: {},
    children: [],
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    insertBefore(child) { this.children.unshift(child); },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
    },
    addEventListener: jest.fn(),
    classList: { toggle: jest.fn() },
  };
}

function createEventTarget() {
  const handlers = new Map();
  return {
    addEventListener: jest.fn((type, handler) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
    }),
    removeEventListener: jest.fn((type, handler) => {
      const listeners = handlers.get(type);
      if (listeners) listeners.delete(handler);
    }),
    dispatch(type) {
      const listeners = Array.from(handlers.get(type) || []);
      listeners.forEach((handler) => handler({ type }));
    },
  };
}

function createDocument() {
  const events = createEventTarget();
  const logs = createElement();
  return {
    ...events,
    readyState: 'complete',
    body: createElement(),
    createElement,
    querySelectorAll: () => [],
    getElementById: (id) => id === 'logs' ? logs : null,
  };
}

function createDeviceApi(mapped, params, propertyValues = {}) {
  const mappedSet = new Set(mapped);
  const propertyHandlers = new Map();
  const invocations = [];
  const keyFor = (logicalId, property) => `${logicalId}:${property}`;
  const DeviceAPI = {
    ready: Promise.resolve(),
    params,
    log: jest.fn(),
    device(logicalId) {
      return {
        isMapped: () => mappedSet.has(logicalId),
        invoke: (capability, actionName, invokeParams = {}) => {
          invocations.push({ logicalId, capability, actionName, params: invokeParams });
          return Promise.resolve({ ok: true });
        },
        onProperty: (property, callback) => {
          const key = keyFor(logicalId, property);
          if (!propertyHandlers.has(key)) propertyHandlers.set(key, []);
          propertyHandlers.get(key).push(callback);
        },
        read: (property) => Promise.resolve(propertyValues[keyFor(logicalId, property)] || []),
      };
    },
  };
  return {
    DeviceAPI,
    invocations,
    emitProperty(logicalId, property, value) {
      const callbacks = propertyHandlers.get(keyFor(logicalId, property)) || [];
      callbacks.forEach((callback) => callback(value));
    },
  };
}

function createAudioClass(playOutcomes) {
  const instances = [];
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.volume = 1;
      this.currentTime = 0;
      this.listeners = new Map();
      this.play = jest.fn(() => {
        const outcome = playOutcomes.shift();
        return outcome === 'reject'
          ? Promise.reject(new Error('autoplay blocked'))
          : Promise.resolve();
      });
      this.pause = jest.fn();
      instances.push(this);
    }

    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    }

    removeEventListener(type, handler) {
      const listeners = this.listeners.get(type);
      if (listeners) listeners.delete(handler);
    }

    dispatch(type) {
      const listeners = Array.from(this.listeners.get(type) || []);
      listeners.forEach((handler) => handler({ type, target: this }));
    }
  }
  FakeAudio.instances = instances;
  return FakeAudio;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

async function loadGame(gameName, options = {}) {
  const definition = GAMES[gameName];
  const document = createDocument();
  const windowEvents = createEventTarget();
  const Audio = createAudioClass([...(options.playOutcomes || [])]);
  const api = createDeviceApi(
    options.mapped || definition.mapped,
    options.params || {},
    options.propertyValues
  );
  const window = {
    ...windowEvents,
    Audio,
    devicePixelRatio: 1,
  };
  const context = {
    Audio,
    console,
    Date,
    DeviceAPI: api.DeviceAPI,
    document,
    Math,
    Promise,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    window,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(definition.file, 'utf8'), context, { filename: definition.file });
  await flushPromises();
  return {
    Audio,
    audio: Audio.instances,
    document,
    game: window[definition.globalName],
    intervalMs: definition.intervalMs,
    ...api,
  };
}

function voiceNames(audio) {
  return audio.map((item) => path.basename(item.src));
}

describe('game voice playback lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('protects the drink intro, lets punishment interrupt it, and delays cooldown voice', async () => {
    const env = await loadGame('drink', {
      params: {
        durationSec: 60,
        targetWeight: 100,
        stableWindowSec: 1,
        punishCooldownSec: 10,
        shockDuration: 2,
        vibeStartProb: 0,
      },
    });

    expect(voiceNames(env.audio)).toEqual(['start_drink.mp3']);
    env.emitProperty('scale', 'weight', 500);
    env.emitProperty('scale', 'weight', 470);
    expect(voiceNames(env.audio)).toEqual(['start_drink.mp3']);

    jest.advanceTimersByTime(1000);
    await flushPromises();
    expect(env.game.rt.state).toBe('Punish');
    expect(voiceNames(env.audio)).toEqual(['start_drink.mp3', 'punish_drink_stall.mp3']);
    expect(env.audio[0].pause).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2000);
    await flushPromises();
    expect(env.game.rt.state).toBe('Cooldown');
    expect(env.audio).toHaveLength(2);

    env.audio[1].dispatch('ended');
    expect(voiceNames(env.audio)).toEqual([
      'start_drink.mp3',
      'punish_drink_stall.mp3',
      'cooldown_start.mp3',
    ]);
  });

  it('does not replay a rejected intro after a newer critical event succeeds', async () => {
    const env = await loadGame('drink', {
      playOutcomes: ['reject', 'resolve'],
      params: {
        durationSec: 60,
        targetWeight: 9999,
        stableWindowSec: 1,
        punishCooldownSec: 10,
        shockDuration: 2,
        vibeStartProb: 0,
      },
    });
    await flushPromises();
    env.emitProperty('scale', 'weight', 500);

    jest.advanceTimersByTime(1000);
    await flushPromises();
    expect(voiceNames(env.audio)).toEqual(['start_drink.mp3', 'punish_drink_stall.mp3']);

    env.document.dispatch('pointerdown');
    await flushPromises();
    expect(voiceNames(env.audio)).toEqual(['start_drink.mp3', 'punish_drink_stall.mp3']);
  });

  it.each(['drink', 'pressureV1', 'pressureV2'])('creates no Audio when voice is disabled in %s', async (gameName) => {
    const env = await loadGame(gameName, { params: { voiceEnabled: false } });
    expect(env.audio).toHaveLength(0);
  });

  it('does not announce delay during pressure v1 startup', async () => {
    const env = await loadGame('pressureV1');
    expect(voiceNames(env.audio)).toEqual(['edging_start.mp3']);

    env.game.loop();
    env.audio[0].dispatch('ended');
    expect(env.game.rt.isInDelayPeriod).toBe(true);
    expect(voiceNames(env.audio)).toEqual(['edging_start.mp3']);
  });

  it('announces pressure v1 middle each time the pressure leaves and re-enters the band', async () => {
    const env = await loadGame('pressureV1');
    env.audio[0].dispatch('ended');
    env.game.rt.isInDelayPeriod = true;
    env.game.rt.delayStartTime = Date.now();
    env.game.cfg.lowPressureDelay = 999;

    env.emitProperty('sensor', 'pressure', 18);
    env.game.loop();
    env.audio[env.audio.length - 1].dispatch('ended');
    env.emitProperty('sensor', 'pressure', 10);
    env.game.loop();
    env.emitProperty('sensor', 'pressure', 18);
    env.game.loop();

    expect(voiceNames(env.audio).filter((name) => name === 'edging_middle.mp3')).toHaveLength(2);
  });

  it('lets pressure v2 overload interrupt intro without changing the state transition', async () => {
    const env = await loadGame('pressureV2');
    env.emitProperty('sensor', 'pressure', 19.5);
    env.emitProperty('sensor', 'pressure', 20);

    expect(env.game.rt.state).toBe('EDGING');
    expect(env.game.rt.edgingCount).toBe(1);
    expect(voiceNames(env.audio)).toEqual(['edging_start.mp3', 'edging_peak.mp3']);
    expect(env.audio[0].pause).toHaveBeenCalledTimes(1);
    expect(env.invocations.filter((item) =>
      item.logicalId === 'punish' && item.capability === 'shock' && item.actionName === 'start'
    )).toHaveLength(1);
  });

  it('releases an errored intro and plays only the latest valid pressure v2 state', async () => {
    const env = await loadGame('pressureV2');
    env.emitProperty('sensor', 'pressure', 19.5);
    env.emitProperty('sensor', 'pressure', 10);

    expect(env.game.rt.state).toBe('SUB_CALM');
    expect(voiceNames(env.audio)).toEqual(['edging_start.mp3']);

    env.audio[0].dispatch('error');
    expect(voiceNames(env.audio)).toEqual(['edging_start.mp3', 'edging_calm.mp3']);
    expect(env.DeviceAPI.log).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('edging_start.mp3')
    );
  });
});
