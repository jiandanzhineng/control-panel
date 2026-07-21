const fs = require('fs');
const path = require('path');
const vm = require('vm');

const gamePath = path.join(__dirname, '..', 'games', 'drink-pee-unlock', 'game.js');

function createElement(attrs = {}) {
  const classNames = new Set();
  const el = {
    attrs,
    textContent: '',
    className: '',
    style: {},
    children: [],
    get firstChild() { return this.children[0] || null; },
    getAttribute(name) { return this.attrs[name] || null; },
    insertBefore(child) { this.children.unshift(child); },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
    },
    classList: {
      toggle(name, enabled) {
        if (enabled) classNames.add(name);
        else classNames.delete(name);
      },
      contains(name) {
        return classNames.has(name);
      },
    },
  };
  return el;
}

function createDocument() {
  const bindKeys = [
    'title', 'statusText', 'remainingSec', 'initialWeight', 'progress', 'targetWeight',
    'shockCount', 'punishDevice', 'shockStatus', 'shockIntensity', 'shockDuration',
    'cooldownRemainingSec', 'lastPunishReason', 'weight', 'pressure', 'tiptoeOk',
    'punishCountdown', 'modeCN', 'weightMin', 'weightMax', 'pressureMin',
    'pressureMax', 'weightCount', 'stableWindowSec', 'punishCooldownSec',
  ];
  const bindElements = bindKeys.map((key) => createElement({ 'data-bind': key }));
  const byBind = new Map(bindElements.map((el) => [el.getAttribute('data-bind'), el]));
  const byId = {
    progressBar: createElement(),
    tiptoeVal: createElement(),
    shockStatusVal: byBind.get('shockStatus'),
    logs: createElement(),
  };

  return {
    readyState: 'complete',
    body: createElement(),
    createElement: () => createElement(),
    addEventListener: jest.fn(),
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (selector) => {
      if (selector === '[data-bind]') return bindElements;
      const match = selector.match(/^\[data-bind="(.+)"\]$/);
      if (match) return bindElements.filter((el) => el.getAttribute('data-bind') === match[1]);
      return [];
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    byBind,
    byId,
  };
}

function createDeviceApi({ mapped = ['scale', 'punish'], params = {}, capabilityValues = {} } = {}) {
  const mappedSet = new Set(mapped);
  const valueHandlers = new Map();
  const invocations = [];

  function handlerKey(logicalId, property) {
    return `${logicalId}:${property}`;
  }

  const DeviceAPI = {
    ready: Promise.resolve(),
    params,
    deviceMap: Object.fromEntries(mapped.map((id) => [id, [`${id}-phys`]])),
    log: jest.fn(),
    device(logicalId) {
      return {
        isMapped: () => mappedSet.has(logicalId),
        invoke: (capability, actionName, invokeParams = {}) => {
          invocations.push({ logicalId, capability, actionName, params: invokeParams });
          return Promise.resolve({ ok: true });
        },
        onValue: (capability, callback) => {
          const key = handlerKey(logicalId, capability);
          if (!valueHandlers.has(key)) valueHandlers.set(key, []);
          valueHandlers.get(key).push(callback);
        },
        readValue: (capability) => Promise.resolve(capabilityValues[handlerKey(logicalId, capability)] || []),
      };
    },
  };

  return {
    DeviceAPI,
    invocations,
    emitValue(logicalId, capability, value) {
      const callbacks = valueHandlers.get(handlerKey(logicalId, capability)) || [];
      callbacks.forEach((callback) => callback(value));
    },
  };
}

async function flushPromises() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function loadGame({ params, capabilityValues, mapped } = {}) {
  const document = createDocument();
  const spoken = [];
  class SpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
      this.lang = '';
      this.rate = 1;
      this.pitch = 1;
      this.voice = null;
    }
  }
  const speechSynthesis = {
    cancel: jest.fn(),
    getVoices: jest.fn(() => [{ lang: 'zh-CN', name: 'Chinese' }]),
    speak: jest.fn((utterance) => spoken.push(utterance)),
  };
  const api = createDeviceApi({
    mapped: mapped || ['scale', 'punish', 'lock'],
    params: {
      mode: 'drink',
      durationSec: 60,
      targetWeight: 9999,
      changeThreshold: 1,
      stableWindowSec: 2,
      punishCooldownSec: 2,
      shockIntensity: 24,
      shockDuration: 3,
      vibeStartProb: 0,
      ...(params || {}),
    },
    capabilityValues,
  });
  const context = {
    window: { speechSynthesis, SpeechSynthesisUtterance },
    document,
    spoken,
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
  vm.runInContext(fs.readFileSync(gamePath, 'utf8'), context, { filename: gamePath });
  await flushPromises();
  return {
    game: context.window.__game,
    document,
    spoken,
    ...api,
    shockStarts() {
      return api.invocations.filter((item) =>
        item.logicalId === 'punish' &&
        item.capability === 'shock' &&
        item.actionName === 'start'
      );
    },
  };
}

describe('drink-pee-unlock game loop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('triggers and displays shock when the stable weight countdown expires without a new sample', async () => {
    const env = await loadGame();

    env.emitValue('scale', 'weight', 1001);
    expect(env.game.rt.running).toBe(true);
    expect(env.game.view.punishCountdown).toBe(2);

    jest.advanceTimersByTime(1000);
    await flushPromises();
    expect(env.game.rt.state).toBe('Running');
    expect(env.game.view.punishCountdown).toBe(1);

    jest.advanceTimersByTime(1000);
    await flushPromises();
    expect(env.game.rt.state).toBe('Punish');
    expect(env.game.rt.shockActive).toBe(true);
    expect(env.game.view.shockStatus).toBe('电击中');
    expect(env.document.byId.shockStatusVal.classList.contains('text-danger')).toBe(true);
    expect(env.shockStarts()).toHaveLength(1);
    expect(env.shockStarts()[0].params).toEqual({ voltage: 24 });
  });

  it('reads the current scale snapshot when unchanged reports produce no property event', async () => {
    const env = await loadGame({
      capabilityValues: { 'scale:weight': [537] },
    });

    expect(env.game.rt.weight).toBe(537);
    expect(env.game.view.weight).toBe(537);
    expect(env.game.view.punishCountdown).toBe(2);

    jest.advanceTimersByTime(2000);
    await flushPromises();
    expect(env.game.rt.state).toBe('Punish');
    expect(env.shockStarts()).toHaveLength(1);
  });

  it('initializes optional sensor values from capability snapshots', async () => {
    const env = await loadGame({
      mapped: ['scale', 'sensor', 'qtz', 'punish', 'lock'],
      capabilityValues: {
        'scale:weight': [500],
        'sensor:sphincterPressure': [25],
        'qtz:tiptoePressure': [0],
      },
    });

    expect(env.game.rt.pressure).toBe(25);
    expect(env.game.view.pressure).toBe(25);
    expect(env.game.view.tiptoeOk).toBe(true);
  });

  it('uses the highest detected weight as the drink-mode starting point', async () => {
    const env = await loadGame({
      params: { mode: 'drink', targetWeight: 100 },
      capabilityValues: { 'scale:weight': [0] },
    });

    expect(env.game.rt.initialWeight).toBe(0);
    env.emitValue('scale', 'weight', 120);
    env.emitValue('scale', 'weight', 500);
    expect(env.game.rt.initialWeight).toBe(500);
    expect(env.game.view.progress).toBe(0);

    env.emitValue('scale', 'weight', 450);
    expect(env.game.view.progress).toBe(50);
    env.emitValue('scale', 'weight', 400);
    expect(env.game.rt.running).toBe(false);
    expect(env.game.rt.state).toBe('Unlocked');
  });

  it('uses the lowest detected weight as the pee-mode starting point', async () => {
    const env = await loadGame({
      params: { mode: 'pee', targetWeight: 60 },
      capabilityValues: { 'scale:weight': [500] },
    });

    env.emitValue('scale', 'weight', 450);
    expect(env.game.rt.initialWeight).toBe(450);
    expect(env.game.view.progress).toBe(0);

    env.emitValue('scale', 'weight', 510);
    expect(env.game.rt.running).toBe(false);
    expect(env.game.rt.state).toBe('Unlocked');
  });

  it('announces start, punishment, and end states in Chinese', async () => {
    const env = await loadGame();
    expect(env.spoken.map((utterance) => utterance.text)).toEqual(['玩法开始']);
    expect(env.spoken[0].lang).toBe('zh-CN');

    env.emitValue('scale', 'weight', 1001);
    jest.advanceTimersByTime(2000);
    await flushPromises();
    expect(env.spoken.at(-1).text).toContain('惩罚开始');
    expect(env.spoken.at(-1).text).toContain('喝水惩罚');

    env.game.end({ reason: '手动结束' });
    expect(env.spoken.at(-1).text).toBe('玩法结束。手动结束');
  });

  it('restarts the stable weight countdown after punishment cooldown', async () => {
    const env = await loadGame();
    env.emitValue('scale', 'weight', 1001);

    jest.advanceTimersByTime(2000);
    await flushPromises();
    expect(env.game.rt.state).toBe('Punish');
    expect(env.shockStarts()).toHaveLength(1);

    jest.advanceTimersByTime(5000);
    await flushPromises();
    expect(env.game.rt.state).toBe('Running');
    expect(env.game.view.punishCountdown).toBe(2);

    jest.advanceTimersByTime(1000);
    await flushPromises();
    expect(env.shockStarts()).toHaveLength(1);
    expect(env.game.rt.state).toBe('Running');
    expect(env.game.view.punishCountdown).toBe(1);
  });
});
