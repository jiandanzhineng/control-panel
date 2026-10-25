const fs = require('fs');
const path = require('path');
const vm = require('vm');

const gameDir = path.join(__dirname, '..', 'games', 'pushup-detection');
const script = fs.readFileSync(path.join(gameDir, 'game.js'), 'utf8');
const html = fs.readFileSync(path.join(gameDir, 'index.html'), 'utf8');

function bootGame(mappedMotors = { vibrator: ['TD01'], pj01: ['PJ01'] }) {
  const calls = [];
  const callbacks = {};
  const timers = new Map();
  let nextTimer = 0;
  const logs = {
    children: [],
    insertBefore(node) { this.children.unshift(node); },
    removeChild() { this.children.pop(); },
  };
  const mapped = { qtz: ['sensor'], ...mappedMotors };
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

describe('pushup original independent motor roles', () => {
  test('idle punishment targets the back-pat role and leaves the vibrator alone', async () => {
    const { calls, timers, game } = bootGame();
    await new Promise(setImmediate);
    game.rt.lastActionTs = Date.now() - 20000;
    game.loop();
    expect(calls.filter((call) => call.id === 'vibrator')).toEqual([]);
    expect(calls.filter((call) => call.id === 'pj01').map((call) => call.params.value)).toEqual([255]);
    timers.get(game.rt.pj01Timer)();
    expect(calls.filter((call) => call.id === 'pj01').map((call) => call.params.value)).toEqual([255, 0]);
    game.end();
  });

  test('reward and punishment retain separate devices, states and stop timers', async () => {
    const { calls, callbacks, timers, game } = bootGame();
    await new Promise(setImmediate);
    expect(callbacks.qtz).toEqual(expect.any(Function));

    callbacks.qtz({ method: 'low' });
    callbacks.qtz({ method: 'high' });
    expect(calls.filter((call) => call.id === 'vibrator')).toEqual([
      { id: 'vibrator', capability: 'strength', action: 'set', params: { value: 37 } },
    ]);

    game.rt.lastActionTs = Date.now() - 20000;
    game.loop();
    expect(calls.filter((call) => call.id === 'vibrator').map((call) => call.params.value)).toEqual([37]);
    expect(game.view).toMatchObject({ vibratorOn: true, pj01On: true });
    timers.get(game.rt.pj01Timer)();
    expect(calls.filter((call) => call.id === 'pj01').map((call) => call.params.value)).toEqual([255, 0]);
    expect(game.view).toMatchObject({ vibratorOn: true, pj01On: false });
    timers.get(game.rt.vibratorTimer)();
    expect(calls.filter((call) => call.id === 'vibrator').map((call) => call.params.value)).toEqual([37, 0]);
    game.end();
  });
  test('mapping one physical motor to both roles does not overwrite its configured reward', async () => {
    const { calls, callbacks, game } = bootGame({ vibrator: ['TD01'], pj01: ['TD01'] });
    await new Promise(setImmediate);
    callbacks.qtz({ method: 'low' }); callbacks.qtz({ method: 'high' });
    game.rt.lastActionTs = Date.now() - 20000; game.loop();
    expect(calls.filter((call) => call.id === 'vibrator').map((call) => call.params.value)).toEqual([37]);
    expect(calls.some((call) => call.id === 'pj01')).toBe(false);
    game.end();
  });
});

test('manifest exposes both original motor roles and the back-pat status card', () => {
  const manifest = JSON.parse(html.match(/<script type="application\/json" id="game-manifest">([\s\S]*?)<\/script>/)[1]);
  expect(manifest.devices.filter((device) => device.capabilities.includes('strength')).map((device) => device.id)).toEqual(['vibrator', 'pj01']);
  expect(manifest.params.find((param) => param.key === 'pj01Duration').device).toBe('pj01');
  expect(html).toContain('data-bind="pj01OnText"');
  const game = require('../services/gameService').getGameById('pushup-detection');
  expect(game.devices.some((device) => device.id === 'pj01')).toBe(true);
  expect(game.i18n.en.devices.pj01).toBe('Back-pat motor');
});
