jest.mock('../services/mqttClientService', () => ({
  init: jest.fn(),
  onMessage: jest.fn(),
  publish: jest.fn(),
}));

jest.mock('../services/logService', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const gameplayService = require('../services/gameplayService');
const deviceService = require('../services/deviceService');

function createGameplayFile(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameplay-capability-'));
  const file = path.join(dir, 'game.js');
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

describe('gameplay capability requirements', () => {
  beforeEach(() => {
    gameplayService.endGameplay();
    deviceService.state.devices = [];
    deviceService.state.dataChangeHandlers = [];
    deviceService.state.offlineCheckInterval = null;
  });

  afterEach(() => {
    gameplayService.endGameplay();
    deviceService.state.devices = [];
    deviceService.state.dataChangeHandlers = [];
  });

  it('starts when mapped device provides every required capability', () => {
    const file = createGameplayFile(`
      module.exports = {
        title: 'Capability game',
        description: 'test',
        requiredDevices: [
          { logicalId: 'combo', capabilities: ['strength', 'pressure'], required: true }
        ],
        start(deviceManager) { deviceManager.setStrength('combo', 88); },
        loop() { return false; }
      };
    `);
    deviceService.state.devices = [{
      id: 'dev-cunzhi',
      name: 'CUNZHI',
      type: 'CUNZHI01',
      connected: true,
      data: {},
    }];

    expect(() => gameplayService.startGameplay(file, { combo: 'dev-cunzhi' }, {})).not.toThrow();
    expect(gameplayService.status().running).toBe(true);
  });

  it('rejects mapped devices that do not provide all requested capabilities', () => {
    const file = createGameplayFile(`
      module.exports = {
        title: 'Capability game',
        description: 'test',
        requiredDevices: [
          { logicalId: 'combo', capabilities: ['strength', 'pressure'], required: true }
        ],
        start() {},
        loop() { return false; }
      };
    `);
    deviceService.state.devices = [{
      id: 'dev-td',
      name: 'TD01',
      type: 'TD01',
      connected: true,
      data: {},
    }];

    expect(() => gameplayService.startGameplay(file, { combo: 'dev-td' }, {}))
      .toThrow(/能力不匹配/);
    expect(gameplayService.status().running).toBe(false);
  });

  it('rejects gameplay files that do not declare capability requirements', () => {
    const file = createGameplayFile(`
      module.exports = {
        title: 'Invalid capability game',
        description: 'test',
        requiredDevices: [
          { logicalId: 'combo', required: true }
        ],
        start() {},
        loop() { return false; }
      };
    `);

    expect(() => gameplayService.getGameplayMeta(file)).toThrow(/必须声明 capabilities/);
  });
});
