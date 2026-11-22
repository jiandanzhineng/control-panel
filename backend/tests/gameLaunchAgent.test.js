jest.mock('../services/gameService', () => ({
  getGameById: jest.fn((id) => (id === 'known-iframe' ? { id: 'known-iframe', gamePath: '/games/known/index.html' } : null)),
}));
jest.mock('../services/localAppProcessService', () => ({ stopAll: jest.fn(async () => {}) }));
jest.mock('../services/remoteSessionService', () => ({ isOperatorRemoteMode: () => false }));
jest.mock('../game-runtime/gameHostService', () => ({ isHostGame: () => false, start: jest.fn(), stop: jest.fn() }));

const gameLaunchService = require('../services/gameLaunchService');

describe('agent-originated page games must be registered', () => {
  it('refuses an unregistered external page for an agent (no token → no limiting)', async () => {
    await expect(gameLaunchService.startGame({
      gameId: 'unknown',
      externalUrl: 'http://example.test/game.html',
      agentClientId: 'dsh-1',
    })).rejects.toMatchObject({ code: 'AGENT_GAME_NOT_REGISTERED' });
  });

  it('still lets the user start an unregistered external page', async () => {
    const result = await gameLaunchService.startGame({
      gameId: 'unknown',
      externalUrl: 'http://example.test/game.html',
    });
    expect(result.ok).toBe(true);
  });

  it('issues a token bound to the agent for a registered page game', async () => {
    const result = await gameLaunchService.startGame({ gameId: 'known-iframe', agentClientId: 'dsh-1' });
    expect(result.ok).toBe(true);
    expect(result.runtime.gameToken).toBeTruthy();
  });
});
