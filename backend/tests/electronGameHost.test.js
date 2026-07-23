const gameHost = require('../../electron/gameHost');

describe('electron/gameHost pure logic', () => {
  describe('assertAllowedOrigin', () => {
    it('accepts the official top-level origin', () => {
      expect(gameHost.assertAllowedOrigin('https://game.undersilicon.cn')).toBe('https://game.undersilicon.cn');
    });

    it('rejects any other origin', () => {
      const cases = [
        'http://game.undersilicon.cn',
        'https://game.undersilicon.cn:8443',
        'https://evil.undersilicon.cn',
        'https://game.undersilicon.cn.evil.com',
        'https://example.com',
        '',
        null,
      ];
      for (const origin of cases) {
        expect(() => gameHost.assertAllowedOrigin(origin)).toThrow();
        try {
          gameHost.assertAllowedOrigin(origin);
        } catch (error) {
          expect(error.code).toBe('GAME_HOST_FORBIDDEN_ORIGIN');
        }
      }
    });

    it('accepts local loopback origins when developer mode is enabled', () => {
      const origins = [
        'http://localhost:4178',
        'https://localhost:8443',
        'http://127.0.0.1:3000',
        'http://127.42.0.9:5173',
        'http://[::1]:8080',
      ];

      for (const origin of origins) {
        expect(gameHost.assertAllowedOrigin(origin, { developerModeEnabled: true })).toBe(origin);
      }
    });

    it('rejects local origins when developer mode is disabled', () => {
      expect(() => gameHost.assertAllowedOrigin('http://localhost:4178')).toThrow(
        expect.objectContaining({ code: 'GAME_HOST_FORBIDDEN_ORIGIN' }),
      );
    });

    it('rejects non-local origins even when developer mode is enabled', () => {
      const origins = [
        'https://example.com',
        'http://192.168.1.10:4178',
        'file:///C:/games/index.html',
      ];

      for (const origin of origins) {
        expect(() => gameHost.assertAllowedOrigin(origin, { developerModeEnabled: true })).toThrow(
          expect.objectContaining({ code: 'GAME_HOST_FORBIDDEN_ORIGIN' }),
        );
      }
    });
  });

  describe('validateGameId', () => {
    it('accepts allowed characters', () => {
      expect(gameHost.validateGameId('drink-pee_unlock.v2')).toBe('drink-pee_unlock.v2');
      expect(gameHost.validateGameId('ABC123')).toBe('ABC123');
    });

    it('rejects empty / non-string ids', () => {
      for (const bad of ['', null, undefined, 42, {}, []]) {
        expect(() => gameHost.validateGameId(bad)).toThrow();
      }
    });

    it('rejects ids with illegal characters', () => {
      for (const bad of ['a/b', '../etc', 'a b', 'a;b', 'a?b', 'a#b', 'ab$']) {
        expect(() => gameHost.validateGameId(bad)).toThrow(/非法字符/);
      }
    });

    it('rejects ids longer than the limit', () => {
      const tooLong = 'a'.repeat(gameHost.MAX_GAME_ID_LENGTH + 1);
      expect(() => gameHost.validateGameId(tooLong)).toThrow(/长度/);
      const maxOk = 'a'.repeat(gameHost.MAX_GAME_ID_LENGTH);
      expect(gameHost.validateGameId(maxOk)).toBe(maxOk);
    });
  });

  describe('parseGameHostRequest', () => {
    it('accepts a valid request and drops extra fields', () => {
      const parsed = gameHost.parseGameHostRequest({
        v: 1,
        gameId: 'my-game',
        manifest: { evil: true },
        url: 'https://evil.com',
        deviceMap: { a: 1 },
        params: { x: 1 },
      });
      expect(parsed).toEqual({ gameId: 'my-game' });
    });

    it('rejects non-object requests', () => {
      for (const bad of [null, undefined, 'x', 1]) {
        expect(() => gameHost.parseGameHostRequest(bad)).toThrow();
      }
    });

    it('rejects unsupported version', () => {
      for (const v of [0, 2, '1', undefined, null]) {
        expect(() => gameHost.parseGameHostRequest({ v, gameId: 'g' })).toThrow();
        try {
          gameHost.parseGameHostRequest({ v, gameId: 'g' });
        } catch (error) {
          expect(error.code).toBe('GAME_HOST_UNSUPPORTED_VERSION');
        }
      }
    });

    it('rejects invalid gameId', () => {
      expect(() => gameHost.parseGameHostRequest({ v: 1, gameId: '' })).toThrow();
      expect(() => gameHost.parseGameHostRequest({ v: 1, gameId: '../x' })).toThrow();
    });
  });

  describe('buildLaunchPath', () => {
    it('builds the native config path with source=remote', () => {
      expect(gameHost.buildLaunchPath('my-game')).toBe('/plays/game/my-game/config?source=remote');
    });

    it('url-encodes the gameId', () => {
      expect(gameHost.buildLaunchPath('a.b_c-d')).toBe('/plays/game/a.b_c-d/config?source=remote');
    });
  });

  describe('buildInstallUrl', () => {
    it('builds the install endpoint and trims trailing slashes', () => {
      expect(gameHost.buildInstallUrl('http://127.0.0.1:5278', 'g1')).toBe(
        'http://127.0.0.1:5278/api/game-cache/install/g1',
      );
      expect(gameHost.buildInstallUrl('http://127.0.0.1:5278/', 'g1')).toBe(
        'http://127.0.0.1:5278/api/game-cache/install/g1',
      );
    });

    it('url-encodes the gameId', () => {
      expect(gameHost.buildInstallUrl('http://x', 'a.b-c')).toBe('http://x/api/game-cache/install/a.b-c');
    });
  });
});
