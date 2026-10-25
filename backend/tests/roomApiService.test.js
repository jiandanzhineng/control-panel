const roomApi = require('../services/roomApiService');

describe('roomApiService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetch(payload, status = 200) {
    const calls = [];
    global.fetch = jest.fn(async (url, options) => {
      calls.push({ url, options });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      };
    });
    return calls;
  }

  test('getRoom reads the room through GET /rooms/:id', async () => {
    const calls = mockFetch({ id: 'room-1', members: [] });
    const room = await roomApi.getRoom('token-1', 'room-1');
    expect(room).toEqual({ id: 'room-1', members: [] });
    expect(calls[0].url).toBe(`${roomApi.getBaseUrl()}/rooms/room-1`);
    expect(calls[0].options.method).toBe('GET');
    expect(calls[0].options.headers.authorization).toBe('Bearer token-1');
  });

  test('kickMember sends DELETE /rooms/:id/members/:userId and tolerates 204', async () => {
    const calls = mockFetch(null, 204);
    await expect(roomApi.kickMember('token-1', 'room-1', 'user-2')).resolves.toBeNull();
    expect(calls[0].url).toBe(`${roomApi.getBaseUrl()}/rooms/room-1/members/user-2`);
    expect(calls[0].options.method).toBe('DELETE');
  });

  test('requests carry an abort signal so they cannot hang forever', async () => {
    const calls = mockFetch({ id: 'room-1' });
    await roomApi.getRoom('token-1', 'room-1');
    expect(calls[0].options.signal).toBeTruthy();
  });

  test('surfaces room API errors with code and status', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: 'FORBIDDEN', message: 'Host access required' } }),
    }));
    await expect(roomApi.kickMember('token-1', 'room-1', 'user-2')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });
});
