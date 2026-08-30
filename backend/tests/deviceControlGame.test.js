const fs = require('fs');
const path = require('path');
const gameService = require('../services/gameService');

test('device control game is discoverable and uses DeviceAPI', () => {
  const game = gameService.getGameById('device-control');
  expect(game).toMatchObject({
    id: 'device-control',
    version: '1.0.3',
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
