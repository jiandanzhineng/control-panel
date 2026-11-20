const fs = require('fs');
const path = require('path');
const vm = require('vm');
const deviceTypes = require('../devices/registry');
const gameService = require('../services/gameService');

test('device control game is discoverable and uses DeviceAPI', () => {
  const game = gameService.getGameById('device-control');
  expect(game).toMatchObject({
    id: 'device-control',
    version: '1.0.6',
    gamePath: '/games/device-control/index.html',
  });
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'games', 'device-control', 'game.js'),
    'utf8',
  );
  expect(source).toContain('DeviceAPI.getDevices()');
  expect(source).toContain("connectionType(device) === 'remote'");
  expect(source).toContain("invoke(id, 'distance', 'configure'");
});

test.each([
  ['zh', ['压力 · kPa', '脚踏1 · 状态', '板载按键 · 状态', '电量 · %', '温度 · ℃', '上报间隔 · ms', '远阈值 · mm']],
  ['en', ['Pressure · kPa', 'Pedal 1 · Status', 'Onboard button · Status', 'Battery · %', 'Temperature · ℃', 'Report interval · ms', 'Far threshold · mm']],
])('device control renders localized telemetry (%s)', async (locale, labels) => {
  const vendorBattery = deviceTypes.getDeviceTypeConfig('HRM').monitorData.find(({ key }) => key === 'battery');
  const devices = [
    { id: 'CUNZHI01', data: { pressure: 0, battery: 60, unknown: '<value>' }, monitorSpec: [vendorBattery] },
    { id: 'QTZ', data: { button0: 1, report_delay_ms: 500, high_band: 80 } },
    { id: 'DAN01', data: { button0: 0, temperature: 24 }, monitorSpec: [{ key: 'button0', name: '脚踏1', unit: '状态' }] },
  ].map((device) => ({ ...device, type: device.id, connected: true, typeConfig: deviceTypes.getDeviceTypeConfig(device.id) }));
  const nodes = new Map();
  const context = vm.createContext({
    DeviceAPI: { locale, getDevices: async () => devices },
    document: {
      getElementById(id) { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    addEventListener() {},
    setInterval() {},
  });
  context.window = context;
  for (const file of ['public/game-i18n.js', 'games/device-control/i18n.js', 'games/device-control/game.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  await new Promise(setImmediate);
  const html = nodes.get('devices').innerHTML;
  labels.forEach((label) => expect(html).toContain(`>${label}</div>`));
  expect(html).toContain('data-key="pressure">0</div>');
  expect(html).toContain('data-key="unknown">&lt;value&gt;</div>');
});
