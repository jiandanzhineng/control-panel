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
    'tiptoeQtz', 'tiptoePressureText', 'tiptoePressureThreshold', 'tiptoePressureMax',
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
  const voiceKeys = [];
  function FakeAudio(src) {
    this.src = src;
    this.volume = 1.0;
    voiceKeys.push(src);
  }
  FakeAudio.prototype.play = jest.fn(() => Promise.resolve());
  const speechSynthesis = {
    cancel: jest.fn(),
    getVoices: jest.fn(() => []),
    speak: jest.fn(),
  };
  class SpeechSynthesisUtterance {}
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
    Audio: FakeAudio,
    window: { speechSynthesis, SpeechSynthesisUtterance, Audio: FakeAudio },
    document,
    voiceKeys,
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
    voiceKeys,
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

  it('announces start, punishment, and end states with voice audio files', async () => {
    const env = await loadGame();
    // 游戏开始时播放对应模式的语音
    expect(env.voiceKeys[0]).toMatch(/start_drink\.mp3$/);

    env.emitValue('scale', 'weight', 1001);
    jest.advanceTimersByTime(2000);
    await flushPromises();
    // 惩罚时播放对应惩罚语音
    const punishKey = env.voiceKeys.find((k) => k.includes('punish_drink_stall'));
    expect(punishKey).toBeTruthy();

    env.game.end({ reason: '手动结束' });
    // 手动结束时播放结束语音
    const endKey = env.voiceKeys[env.voiceKeys.length - 1];
    expect(endKey).toMatch(/end_manual\.mp3$/);
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

describe('drink-pee-unlock CUNZHI01 tiptoe pressure', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
  });
  afterEach(() => { jest.useRealTimers(); });

  it('punishes when tiptoe pressure exceeds threshold beyond debounce', async () => {
    const env = await loadGame({
      mapped: ['scale', 'punish', 'lock', 'cunzhi'],
      params: { tiptoePressureThreshold: 100, tiptoeDebounceMs: 300, targetWeight: 9999, stableWindowSec: 9999 },
    });
    env.emitValue('scale', 'weight', 1001);
    expect(env.game.rt.cunzhiMapped).toBe(true);
    expect(env.game.view.tiptoeOk).toBe(true);

    // 压力超阈值，但未过防抖 → 尚未违规
    env.emitValue('cunzhi', 'tiptoePressure', 250);
    jest.advanceTimersByTime(100);
    await flushPromises();
    expect(env.game.rt.state).toBe('Running');

    // 超过防抖时长 → 判定违规并电击
    jest.advanceTimersByTime(1000);
    await flushPromises();
    expect(env.game.rt.tiptoeViolated).toBe(true);
    expect(env.game.rt.state).toBe('Punish');
    expect(env.game.rt.lastPunishReason).toContain('脚跟落地');
    expect(env.shockStarts()).toHaveLength(1);
  });

  it('stays running while tiptoe pressure remains below threshold', async () => {
    const env = await loadGame({
      mapped: ['scale', 'punish', 'lock', 'cunzhi'],
      params: { tiptoePressureThreshold: 100, tiptoeDebounceMs: 300, targetWeight: 9999, stableWindowSec: 9999 },
    });
    env.emitValue('scale', 'weight', 1001);
    env.emitValue('cunzhi', 'tiptoePressure', 30);
    jest.advanceTimersByTime(2000);
    await flushPromises();
    expect(env.game.rt.tiptoeViolated).toBe(false);
    expect(env.game.rt.state).toBe('Running');
    expect(env.shockStarts()).toHaveLength(0);
    expect(env.game.view.tiptoePressureText).toBe(30);
  });

  it('clears violation when pressure drops back below threshold before debounce', async () => {
    const env = await loadGame({
      mapped: ['scale', 'punish', 'lock', 'cunzhi'],
      params: { tiptoePressureThreshold: 100, tiptoeDebounceMs: 300, targetWeight: 9999, stableWindowSec: 9999 },
    });
    env.emitValue('scale', 'weight', 1001);
    env.emitValue('cunzhi', 'tiptoePressure', 250);
    jest.advanceTimersByTime(100);
    env.emitValue('cunzhi', 'tiptoePressure', 20);
    jest.advanceTimersByTime(1000);
    await flushPromises();
    expect(env.game.rt.tiptoeViolated).toBe(false);
    expect(env.game.rt.state).toBe('Running');
    expect(env.shockStarts()).toHaveLength(0);
  });
});
