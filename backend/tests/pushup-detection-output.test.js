const fs = require('fs');
const path = require('path');
const vm = require('vm');

const gameDir = path.join(__dirname, '..', 'games', 'pushup-detection');
const script = fs.readFileSync(path.join(gameDir, 'game.js'), 'utf8');
const html = fs.readFileSync(path.join(gameDir, 'index.html'), 'utf8');

function bootGame(physicalType) {
  const calls = [];
  const callbacks = {};
  const timers = new Map();
  let nextTimer = 0;
  const logs = {
    children: [],
    insertBefore(node) { this.children.unshift(node); },
    removeChild() { this.children.pop(); },
  };
  const mapped = { qtz: ['sensor'], vibrator: [physicalType] };
  const context = {
    Date,
    Math,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return ++nextTimer; },
    clearInterval() {},
    document: {
      readyState: 'complete',
      querySelectorAll: () => [],
      getElementById: (id) => id === 'logs' ? logs : null,
      createElement: () => ({ className: '', textContent: '' }),
    },
    DeviceAPI: {
      ready: Promise.resolve(),
      params: {
        targetCount: 5,
        rewardTriggerCount: 1,
        rewardTriggerProbability: 100,
        vibratorIntensity: 37,
        enableVoice: false,
      },
      deviceMap: mapped,
      device(id) {
        return {
          isMapped: () => !!mapped[id]?.length,
          invoke(capability, action, params) {
            calls.push({ id, capability, action, params });
            return Promise.resolve();
          },
          onMessage(callback) { callbacks[id] = callback; },
          onValue() {},
          readValue: () => Promise.resolve([]),
        };
      },
      log() {},
    },
  };
  context.window = context;
  vm.runInNewContext(script, context);
  return { calls, callbacks, timers, game: context.__game };
}

describe.each(['TD01', 'PJ01'])('pushup motor output mapped to %s', (physicalType) => {
  test('uses configured intensity for punishment without a reward', async () => {
    const { calls, timers, game } = bootGame(physicalType);
    await new Promise(setImmediate);
    game.rt.lastActionTs = Date.now() - 20000;
    game.loop();
    expect(calls.filter((call) => call.id === 'vibrator').map((call) => call.params.value)).toEqual([37]);
    timers.get(game.rt.punishMotorTimer)();
    expect(calls.filter((call) => call.id === 'vibrator').map((call) => call.params.value)).toEqual([37, 0]);
    game.end();
  });

  test('shares configured intensity across reward and punishment without stopping an overlapping action', async () => {
    const { calls, callbacks, timers, game } = bootGame(physicalType);
    await new Promise(setImmediate);
    expect(callbacks.qtz).toEqual(expect.any(Function));

    callbacks.qtz({ method: 'low' });
    callbacks.qtz({ method: 'high' });
    expect(calls.filter((call) => call.id === 'vibrator')).toEqual([
      { id: 'vibrator', capability: 'strength', action: 'set', params: { value: 37 } },
    ]);

    game.rt.lastActionTs = Date.now() - 20000;
    game.loop();
    expect(calls.filter((call) => call.id === 'vibrator').map((call) => call.params.value)).toEqual([37, 37]);
    timers.get(game.rt.punishMotorTimer)();
    expect(calls.filter((call) => call.id === 'vibrator').map((call) => call.params.value)).toEqual([37, 37, 37]);
    timers.get(game.rt.vibratorTimer)();
    expect(calls.filter((call) => call.id === 'vibrator').map((call) => call.params.value)).toEqual([37, 37, 37, 0]);
    expect(calls.some((call) => call.id === 'pj01')).toBe(false);
    game.end();
  });
});

test('manifest exposes one motor slot for both actions', () => {
  const manifest = JSON.parse(html.match(/<script type="application\/json" id="game-manifest">([\s\S]*?)<\/script>/)[1]);
  expect(manifest.version).toBe('2.1.4');
  expect(manifest.devices.filter((device) => device.capabilities.includes('strength')).map((device) => device.id)).toEqual(['vibrator']);
  expect(manifest.devices.find((device) => device.id === 'vibrator').maxDevices).toBe(1);
  expect(manifest.params.find((param) => param.key === 'pj01Duration').device).toBe('vibrator');
  const game = require('../services/gameService').getGameById('pushup-detection');
  expect(game.devices.find((device) => device.id === 'vibrator').maxDevices).toBe(1);
  expect(game.i18n.en.devices.vibrator).toBe('Motor (TD01/PJ01)');
});
