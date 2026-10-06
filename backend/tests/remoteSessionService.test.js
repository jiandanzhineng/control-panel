const { EventEmitter } = require('events');
const { RemoteGameService } = require('../services/remoteGameService');
const { RemoteSessionService } = require('../services/remoteSessionService');
const outputGuard = require('../services/remoteOutputGuard');

// 与 remoteGameService.test.js 相同的假 broker / 房间 API，避免依赖真实网络
function guardWith(timerFns) {
  return {
    ...outputGuard,
    createOutputWatchdog: (options) => outputGuard.createOutputWatchdog({ ...options, ...timerFns }),
  };
}

function topicMatches(pattern, topic) {
  const expected = pattern.split('/');
  const actual = topic.split('/');
  return expected.length === actual.length
    && expected.every((part, index) => part === '+' || part === actual[index]);
}

class FakeBroker {
  constructor() {
    this.clients = new Set();
    this.publishes = [];
  }

  connect = (_url, options) => {
    const client = new EventEmitter();
    client.options = { ...options };
    client.subscriptions = [];
    client.subscribe = (topics, _opts, callback) => {
      client.subscriptions.push(...topics);
      callback?.(null);
    };
    client.publish = (topic, payload, _options, callback) => {
      this.publishes.push({ client, topic, payload: JSON.parse(String(payload)) });
      for (const subscriber of this.clients) {
        if (subscriber.subscriptions.some((pattern) => topicMatches(pattern, topic))) {
          queueMicrotask(() => subscriber.emit('message', topic, Buffer.from(payload)));
        }
      }
      callback?.(null);
    };
    client.end = (_force, _opts, callback) => {
      this.clients.delete(client);
      client.emit('close');
      callback?.();
    };
    this.clients.add(client);
    queueMicrotask(() => client.emit('connect'));
    return client;
  };
}

function createApi() {
  const room = { id: 'room-game', joinCode: 'JOIN123', hostUserId: 'owner', hostEpoch: 0 };
  return {
    getBaseUrl: () => 'http://room.test',
    createRoom: jest.fn(async () => room),
    joinRoom: jest.fn(async () => room),
    activateRoom: jest.fn(async () => null),
    heartbeat: jest.fn(async () => null),
    getMqttCredential: jest.fn(async (token) => ({
      brokerUrl: 'mqtt://room.test',
      roomId: room.id,
      userId: token,
      clientId: `client-${token}`,
      username: token,
      password: 'jwt',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    })),
    leaveRoom: jest.fn(async () => null),
    closeRoom: jest.fn(async () => null),
    getRoom: jest.fn(async () => ({ ...room, members: [] })),
    kickMember: jest.fn(async () => null),
  };
}

function mockHost() {
  const listeners = new Set();
  const api = {
    status: { active: false, running: false, snapshot: null },
    start: jest.fn((input) => {
      api.status = {
        active: true,
        running: true,
        sessionId: 'game-session-1',
        gameId: input.gameId,
        source: input.source,
        deviceMap: input.deviceMap || {},
        snapshot: { running: true, gameId: input.gameId },
      };
      return api.status;
    }),
    pause: jest.fn(() => api.status),
    resume: jest.fn(() => api.status),
    stop: jest.fn(() => {
      api.status = { active: false, running: false, snapshot: { ended: true } };
      return api.status;
    }),
    setParams: jest.fn(() => api.status),
    action: jest.fn(() => api.status),
    getStatus: jest.fn(() => api.status),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;
}

function stubTimers() {
  return {
    setTimer: () => ({ id: 1 }),
    clearTimer: () => {},
    setRepeating: () => ({ id: 2 }),
    clearRepeating: () => {},
  };
}

// 可控时钟：让测试手动推进「投影续期 / 自动授权重试」定时器
function fakeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return { id, ms };
    },
    clearTimer(handle) {
      if (handle?.id) timers.delete(handle.id);
    },
    setRepeating: () => ({ id: ++seq }),
    clearRepeating: () => {},
    fire(ms) {
      const hits = [...timers.entries()].filter(([, item]) => item.ms === ms);
      for (const [id, item] of hits) {
        timers.delete(id);
        item.fn();
      }
      return hits.length;
    },
    pending() {
      return timers.size;
    },
  };
}

// 假投影服务：房主与操作方共享一份「房间世界」，模拟两条链路各自的客户端
function createProjectionPair() {
  const world = { members: new Set(), authorized: null, extended: [], joins: [] };
  let nextRoom = 1;
  function make(role) {
    const service = {
      role,
      handlers: new Set(),
      active: false,
      connected: false,
      expired: false,
      roomId: null,
      controlExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
      onEvent(handler) {
        service.handlers.add(handler);
        return () => service.handlers.delete(handler);
      },
      emit(event) {
        for (const handler of service.handlers) handler({ source: 'projection', ...event });
      },
      create: jest.fn(async ({ controlTtlSec }) => {
        service.active = true;
        service.connected = true;
        service.roomId = `room-proj-${nextRoom++}`;
        service.controlExpiresAt = Date.now() + controlTtlSec * 1000;
        return { roomId: service.roomId, joinCode: 'PCODE' };
      }),
      join: jest.fn(async ({ token, joinCode }) => {
        world.joins.push({ token, joinCode });
        world.members.add(token);
        service.active = true;
        service.connected = true;
        service.roomId = `room-proj-${nextRoom++}`;
        service.emit({ type: 'peer', role: 'operator', roomId: service.roomId, joinCode, hostUserId: 'owner' });
        return { roomId: service.roomId };
      }),
      authorize: jest.fn(async (userId) => {
        world.authorized = userId;
        return { active: true };
      }),
      revoke: jest.fn(async () => {
        world.authorized = null;
        return { active: true };
      }),
      kick: jest.fn(async (userId) => {
        world.members.delete(userId);
        world.authorized = null;
        return { active: true };
      }),
      emergencyStop: jest.fn(async () => ({ active: true })),
      extendControl: jest.fn(async ({ controlTtlSec }) => {
        world.extended.push(controlTtlSec);
        service.controlExpiresAt = Date.now() + controlTtlSec * 1000;
        return { ok: true, controlExpiresAt: service.controlExpiresAt };
      }),
      stop: jest.fn(async () => {
        service.active = false;
        service.connected = false;
        return { active: false };
      }),
      hasMember: jest.fn((userId) => world.members.has(userId)),
      getStatus: () => ({
        active: service.active,
        role,
        connected: service.connected,
        roomId: service.roomId,
        expired: service.expired,
        controlExpiresAt: new Date(service.controlExpiresAt).toISOString(),
        authorizedUserId: world.authorized,
      }),
    };
    return service;
  }
  return { world, owner: make('owner'), operator: make('operator') };
}

async function flush() {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function setup() {
  const broker = new FakeBroker();
  const api = createApi();
  const host = mockHost();
  const timerFns = stubTimers();
  const games = [{ id: 'surge-edging', runtimeMode: 'host', devices: [], params: [] }];
  const devices = [];
  const makeGame = () => new RemoteGameService({
    host, api, mqttConnect: broker.connect, listGames: () => games, listDevices: () => devices,
    outputGuard: guardWith(timerFns), ...timerFns,
  });
  const ownerGame = makeGame();
  const operatorGame = makeGame();
  const otherGame = makeGame();
  const projection = createProjectionPair();
  const clock = fakeClock();
  const ownerSession = new RemoteSessionService({
    game: ownerGame, projection: projection.owner, log: { info: () => {} }, ...clock,
  });
  const operatorSession = new RemoteSessionService({
    game: operatorGame, projection: projection.operator, log: { info: () => {} }, ...clock,
  });
  const otherSession = new RemoteSessionService({
    game: otherGame, projection: projection.owner, log: { info: () => {} }, ...clock,
  });
  return {
    broker, api, host, ownerGame, operatorGame, otherGame,
    projection, clock, ownerSession, operatorSession, otherSession,
  };
}

// 走完一码加入：被控端建房 → 主控端加入 → 被控端授权 → 主控端进投影房间 → 被控端自动授权
async function setupActiveSession() {
  const ctx = setup();
  await ctx.ownerSession.create({ token: 'owner' });
  await ctx.operatorSession.join({ token: 'operator', joinCode: 'JOIN123' });
  await flush();
  await ctx.ownerSession.authorize({});
  await flush();
  ctx.clock.fire(3000);
  await flush();
  return ctx;
}

describe('remote session service', () => {
  test('creates one user-facing join code and pulls up both links', async () => {
    const { api, ownerSession, projection, clock } = setup();
    const status = await ownerSession.create({ token: 'owner' });
    expect(api.createRoom).toHaveBeenCalledWith('owner', 2, expect.objectContaining({ gameId: 'remote-game' }));
    expect(projection.owner.create).toHaveBeenCalledWith(expect.objectContaining({
      token: 'owner', controlTtlSec: 24 * 60 * 60,
    }));
    expect(status.joinCode).toBe('JOIN123');
    expect(status.role).toBe('owner');
    expect(status.phase).toBe('waiting');
    expect(status.links.projection.roomId).toMatch(/^room-proj-/);
    clock.fire(5 * 60 * 1000);
    await flush();
    await ownerSession.stop();
  });

  test('one-code join delivers the projection invite only to the authorized userId', async () => {
    const { ownerSession, operatorSession, otherSession, operatorGame, otherGame, projection } = setup();
    await ownerSession.create({ token: 'owner' });
    await operatorSession.join({ token: 'operator', joinCode: 'JOIN123' });
    await otherSession.join({ token: 'other', joinCode: 'JOIN123' });
    await flush();

    await ownerSession.authorize({});
    await flush();

    const target = ownerSession.getStatus().peer.userId;
    expect(['operator', 'other']).toContain(target);
    const targetGame = target === 'operator' ? operatorGame : otherGame;
    const otherOperatorGame = target === 'operator' ? otherGame : operatorGame;
    expect(targetGame.getProjectionInvite()).toMatchObject({ joinCode: 'PCODE', forUserId: target });
    // 未被授权的成员拿不到投影房间码
    expect(otherOperatorGame.getProjectionInvite()).toBeNull();

    // 乱序/丢包时操作方主动补要一次；房主对补要的回应里也带着同一份邀请
    const response = await targetGame.command({ type: 'session.projection-invite.request' });
    expect(response.ok).toBe(true);
    expect(response.result.invite).toMatchObject({ joinCode: 'PCODE', forUserId: target });
    // 未被授权的成员补要也拿不到房间码（房主回 invite: null）
    const denied = await otherOperatorGame.command({ type: 'session.projection-invite.request' });
    expect(denied.result?.invite ?? null).toBeNull();
    // 补要只是再要一次房间码，不会重复进房间
    await flush();
    expect(projection.world.joins).toHaveLength(1);

    await ownerSession.stop();
    await operatorSession.stop();
    await otherSession.stop();
  });

  test('operator auto-joins the projection room and host auto-authorizes the same userId', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, projection, operatorGame } = ctx;
    const world = projection.world;
    const target = ownerSession.getStatus().peer.userId;

    expect(world.joins).toEqual([{ token: target, joinCode: 'PCODE' }]);
    expect(projection.owner.authorize).toHaveBeenCalledWith(target);
    expect(world.authorized).toBe(target);
    expect(ownerSession.getStatus().authorized).toBe(true);
    expect(operatorGame.getStatus().authorized).toBe(true);
    expect(operatorSession.getStatus().authorized).toBe(true);
    expect(ownerSession.getStatus().phase).toBe('active');
    expect(ownerSession.isOperatorRemoteMode()).toBe(false);
    expect(operatorSession.isOperatorRemoteMode()).toBe(true);
    expect(operatorSession.projectionRoomId()).toMatch(/^room-proj-/);

    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('revoke, kick and stop cascade to both links', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, ownerGame, operatorGame, projection, api } = ctx;
    const target = ownerSession.getStatus().peer.userId;

    await ownerSession.revoke();
    await flush();
    expect(ownerGame.getAuthorizedUserId()).toBeNull();
    expect(projection.owner.revoke).toHaveBeenCalled();
    expect(ownerSession.getStatus()).toMatchObject({ authorized: false, phase: 'waiting', peer: null });

    await ownerSession.authorize({});
    await flush();
    await ownerSession.kick({ userId: target });
    await flush();
    expect(api.kickMember).toHaveBeenCalledWith('owner', 'room-game', target);
    expect(projection.owner.kick).toHaveBeenCalledWith(target);
    expect(projection.owner.emergencyStop).toHaveBeenCalled();
    expect(ownerSession.getStatus().authorized).toBe(false);

    await ownerSession.stop();
    await flush();
    expect(api.closeRoom).toHaveBeenCalledWith('owner', 'room-game');
    expect(projection.owner.stop).toHaveBeenCalled();
    expect(ownerSession.getStatus()).toMatchObject({ active: false, phase: 'ended' });
    expect(operatorSession.getStatus().phase).toBe('ended');
    await operatorSession.stop();
    await operatorGame.stop();
  });

  test('emergency stop only stops operator outputs and keeps the session', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, ownerGame, host, projection, api } = ctx;
    host.status = {
      active: true, running: true, sessionId: 'game-session-1', source: 'remote',
      deviceMap: {}, snapshot: { running: true },
    };

    await ownerSession.emergencyStop();
    await flush();

    expect(projection.owner.emergencyStop).toHaveBeenCalled();
    expect(host.stop).toHaveBeenCalledWith({ reason: 'remote-emergency-stop' });
    expect(ownerSession.getStatus().active).toBe(true);
    expect(ownerSession.getStatus().authorized).toBe(true);
    expect(api.closeRoom).not.toHaveBeenCalled();
    expect(ownerGame.getStatus().active).toBe(true);

    await ownerSession.stop();
    await flush();
  });

  test('operator emergency stop asks the host to stop without ending the session', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, ownerGame, host } = ctx;
    host.status = {
      active: true, running: true, sessionId: 'game-session-1', source: 'remote',
      deviceMap: {}, snapshot: { running: true },
    };

    await operatorSession.emergencyStop();
    await flush();

    // 主控端不直接停本机，而是发命令请被控端停；被控端停完会话仍在
    expect(host.stop).toHaveBeenCalledWith({ reason: 'remote-emergency-stop' });
    expect(ownerGame.getStatus().active).toBe(true);
    expect(operatorSession.getStatus().active).toBe(true);
    expect(ownerSession.getStatus().authorized).toBe(true);
    expect(ownerSession.getStatus().log.some((entry) => entry.kind === 'operator-output')).toBe(true);

    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('records ok / clamped / rejected operations and caps the log at 50', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, projection } = ctx;
    const target = ownerSession.getStatus().peer.userId;

    projection.owner.emit({
      type: 'operation', userId: target, kind: 'projection.write', target: 'dev-1', outcome: 'ok',
      detail: { requested: { method: 'update', power: 20 }, applied: { method: 'update', power: 20 } },
    });
    projection.owner.emit({
      type: 'operation', userId: target, kind: 'projection.write', target: 'dev-1', outcome: 'clamped',
      detail: { requested: { method: 'update', power: 240 }, applied: { method: 'update', power: 128 } },
    });
    projection.owner.emit({
      type: 'operation', userId: target, kind: 'projection.write', target: 'dev-2', outcome: 'rejected',
      detail: { code: 'REMOTE_OUTPUT_REJECTED', message: '远程投影不允许设备字段: x' },
    });

    const log = ownerSession.getStatus().log;
    const outcomes = log.map((entry) => entry.outcome);
    expect(outcomes).toContain('ok');
    expect(outcomes).toContain('clamped');
    expect(outcomes).toContain('rejected');
    const clamped = log.find((entry) => entry.outcome === 'clamped');
    expect(clamped.summary).toContain('已限制为 128');
    expect(clamped.detail.applied.power).toBe(128);
    expect(clamped.userId).toBe(target);

    for (let i = 0; i < 60; i += 1) {
      projection.owner.emit({
        type: 'operation', userId: target, kind: 'projection.write', target: `dev-${i}`, outcome: 'ok',
        detail: null,
      });
    }
    expect(ownerSession.getStatus().log).toHaveLength(50);

    await ownerSession.stop();
    await flush();
  });

  test('renews the projection control TTL before it expires', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, projection, clock } = ctx;

    // 距到期 10 分钟（小于 30 分钟阈值）→ 续期到 24h
    projection.owner.controlExpiresAt = Date.now() + 10 * 60 * 1000;
    clock.fire(5 * 60 * 1000);
    await flush();
    expect(projection.owner.extendControl).toHaveBeenCalledWith({ controlTtlSec: 24 * 60 * 60 });
    expect(projection.world.extended).toEqual([24 * 60 * 60]);

    // 刚续期完（远离到期）→ 再检查一次不再续期
    projection.owner.extendControl.mockClear();
    clock.fire(5 * 60 * 1000);
    await flush();
    expect(projection.owner.extendControl).not.toHaveBeenCalled();

    await ownerSession.stop();
    await flush();
  });

  test('reports reconnecting on the operator side while a link is down', async () => {
    const ctx = await setupActiveSession();
    const { operatorSession, projection } = ctx;
    expect(operatorSession.getStatus().phase).toBe('active');
    projection.operator.connected = false;
    expect(operatorSession.getStatus().phase).toBe('reconnecting');
    expect(operatorSession.getStatus().links.projection.connected).toBe(false);
    await ctx.ownerSession.stop();
    await operatorSession.stop();
  });

  test('never re-authorizes a member that was kicked', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, ownerGame } = ctx;
    const target = ownerSession.getStatus().peer.userId;
    await ownerSession.kick({ userId: target });
    await flush();

    await expect(ownerSession.authorize({ userId: target })).rejects.toMatchObject({ code: 'USER_KICKED' });
    expect(ownerGame.getAuthorizedUserId()).toBeNull();

    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('operator session ends and reports ended when the host revokes the session', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, operatorGame } = ctx;
    await ownerSession.stop();
    await flush();
    expect(operatorSession.getStatus().phase).toBe('ended');
    expect(operatorSession.getStatus().active).toBe(false);
    await operatorSession.stop();
    await operatorGame.stop();
  });

  test('host stop tells the operator it was the host who ended the session', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, operatorGame } = ctx;
    await ownerSession.stop();
    await flush();
    // 「对方已结束远程」而不是「与对方的连接已断开」：reason 由编排层给出
    expect(operatorSession.getStatus().lastError).toBe('session-stop-by-host');
    await operatorSession.stop();
    await operatorGame.stop();
  });

  test('operator tears down a leftover projection link when the host closes the session', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, projection, operatorGame } = ctx;
    await ownerSession.stop();
    await flush();
    // 房主只关掉自己那侧房间：主控端必须自己把投影链路收掉
    expect(projection.operator.stop).toHaveBeenCalled();
    expect(operatorSession.getStatus().links.projection.connected).toBe(false);
    await operatorSession.stop();
    await operatorGame.stop();
  });

  test('revoking while the projection authorize poll is pending clears the retry timer', async () => {
    const ctx = setup();
    const { ownerSession, operatorSession, projection, clock } = ctx;
    await ownerSession.create({ token: 'owner' });
    await operatorSession.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();
    projection.owner.hasMember.mockReturnValue(false);
    await ownerSession.authorize({});
    await flush();
    expect(clock.pending()).toBeGreaterThan(0);

    await ownerSession.revoke();
    await flush();
    // 重试定时器已被清掉：推进时钟不会再触发一次自动授权
    expect(clock.fire(3000)).toBe(0);
    await flush();
    expect(projection.owner.authorize).not.toHaveBeenCalled();

    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('never auto-authorizes the projection room for a member kicked while polling', async () => {
    const ctx = setup();
    const { ownerSession, operatorSession, ownerGame, projection, clock } = ctx;
    await ownerSession.create({ token: 'owner' });
    await operatorSession.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();
    // 第一次立即轮询时操作方还没进投影房间 → 排下一次 3s 重试
    projection.owner.hasMember.mockReturnValue(false);
    await ownerSession.authorize({});
    await flush();
    const target = ownerSession.getStatus().peer.userId;
    projection.owner.authorize.mockClear();

    // 重试等待期间成员被移出（直接踢主房间，模拟不经编排层 kick() 的路径）；
    // 此刻它已经进了投影房间，若没有 isKicked 守卫就会被自动授权
    projection.owner.hasMember.mockReturnValue(true);
    await ownerGame.kick({ userId: target });
    await flush();
    clock.fire(3000);
    await flush();

    expect(projection.owner.authorize).not.toHaveBeenCalled();
    expect(projection.world.authorized).toBeNull();

    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('rejects a kick that lands while the projection authorize is in flight', async () => {
    const ctx = setup();
    const { ownerSession, operatorSession, ownerGame, projection, clock } = ctx;
    await ownerSession.create({ token: 'owner' });
    await operatorSession.join({ token: 'operator', joinCode: 'JOIN123' });
    await flush();
    projection.owner.hasMember.mockReturnValue(false);
    await ownerSession.authorize({});
    await flush();
    const target = ownerSession.getStatus().peer.userId;
    projection.owner.hasMember.mockReturnValue(true);
    // authorize 落地的同一刻成员已被踢出：必须立刻把刚给的授权撤回来
    projection.owner.authorize.mockImplementationOnce(async (userId) => {
      projection.world.authorized = userId;
      await ownerGame.kick({ userId: target });
      return { active: true };
    });

    clock.fire(3000);
    await flush();

    expect(projection.owner.revoke).toHaveBeenCalled();
    expect(projection.world.authorized).toBeNull();

    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('only the authorized operator can trigger the remote emergency stop', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, otherSession, host } = ctx;
    // 第三个成员（未被授权）加入主房间
    await otherSession.join({ token: 'other', joinCode: 'JOIN123' });
    await flush();
    host.status = {
      active: true, running: true, sessionId: 'game-session-1', source: 'remote',
      deviceMap: {}, snapshot: { running: true },
    };
    host.stop.mockClear();

    // 未被授权的成员发急停：主房间直接拒绝，不落到被控端执行
    await otherSession.emergencyStop();
    await flush();
    expect(host.stop).not.toHaveBeenCalled();

    // 被授权的操作方发急停：照常执行
    await operatorSession.emergencyStop();
    await flush();
    expect(host.stop).toHaveBeenCalledWith({ reason: 'remote-emergency-stop' });

    await ownerSession.stop();
    await operatorSession.stop();
    await otherSession.stop();
  });
});

describe('remote session play occupancy', () => {
  test('operator occupies the play through the main room and releases it on stop', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, operatorGame } = ctx;
    // 占用登记走主房间 RPC：由操作方的 remoteGameService 发出
    const operatorCommand = jest.spyOn(operatorGame, 'command');

    const occupied = await operatorSession.occupyPlay({ gameId: 'surge-edging', gameName: '气压突变寸止' });
    expect(occupied).toMatchObject({ ok: true, gameId: 'surge-edging', gameName: '气压突变寸止' });
    // 占用登记是主房间 RPC，不是本机状态
    expect(operatorCommand).toHaveBeenCalledWith({
      type: 'play.occupy',
      payload: { gameId: 'surge-edging', gameName: '气压突变寸止' },
    });
    expect(operatorSession.getStatus().localPlay).toMatchObject({ gameId: 'surge-edging' });
    expect(ownerSession.getStatus().occupancy).toMatchObject({
      gameId: 'surge-edging', gameName: '气压突变寸止',
    });

    // 同一游戏重复登记：幂等，不再发命令
    operatorCommand.mockClear();
    await operatorSession.occupyPlay({ gameId: 'surge-edging' });
    expect(operatorCommand).not.toHaveBeenCalled();

    await operatorSession.releasePlay({ gameId: 'surge-edging' });
    expect(operatorSession.getStatus().localPlay).toBeNull();
    expect(ownerSession.getStatus().occupancy).toBeNull();

    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('occupy fails visibly when the host runs a local play', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, ownerGame } = ctx;
    const bridgeService = require('../services/bridgeService');
    const spy = jest.spyOn(bridgeService, 'getActiveSessions').mockReturnValue([{ id: 'local-play' }]);
    try {
      await expect(operatorSession.occupyPlay({ gameId: 'surge-edging' }))
        .rejects.toMatchObject({ code: 'HOST_PLAY_ACTIVE' });
      expect(operatorSession.getStatus().localPlay).toBeNull();
      expect(ownerSession.getStatus().occupancy).toBeNull();
    } finally {
      spy.mockRestore();
    }
    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('host preempts the operator play when a local play starts and tells the operator', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, ownerGame } = ctx;
    const emergencyStop = jest.spyOn(ownerGame, 'emergencyStop');
    await operatorSession.occupyPlay({ gameId: 'surge-edging', gameName: '气压突变寸止' });
    expect(ownerSession.getStatus().occupancy).toBeTruthy();

    // 被控端本机开始了一次玩法（bridge init）
    require('../services/playCarrierBus').emitPlayCarrierStart({ kind: 'bridge' });
    await flush();

    expect(emergencyStop).toHaveBeenCalled();
    expect(ownerSession.getStatus().occupancy).toBeNull();
    expect(operatorSession.getStatus().localPlay).toBeNull();
    const preempted = ownerSession.getStatus().log.find((row) => row.kind === 'session.play.preempted');
    expect(preempted).toBeTruthy();
    expect(operatorSession.getStatus().log.some((row) => row.kind === 'session.play.preempted')).toBe(true);

    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('the host stopping the play clears the occupancy and tells the operator to stop', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, ownerGame } = ctx;
    await operatorSession.occupyPlay({ gameId: 'surge-edging' });
    expect(ownerSession.getStatus().occupancy).toBeTruthy();

    // 被控端本地停止主控端起在跑的玩法（game.stop / 急停）：占用清掉，主控端 localPlay 归 null
    await ownerGame.command({ type: 'play.release', payload: { gameId: 'surge-edging' } });
    await flush();
    expect(ownerSession.getStatus().occupancy).toBeNull();
    expect(operatorSession.getStatus().localPlay).toBeNull();

    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('occupancy is cleared when the operator disconnects', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession } = ctx;
    await operatorSession.occupyPlay({ gameId: 'surge-edging' });
    expect(ownerSession.getStatus().occupancy).toBeTruthy();

    // 主控端断开：急停 + 结束会话；占用随会话一起消失（getStatus 的 active=false 分支）
    await operatorSession.stop({ reason: 'operator-stop' });
    await flush();
    await ownerSession.stop({ reason: 'operator-left' });
    expect(ownerSession.getStatus().occupancy ?? null).toBeNull();
  });
});

describe('remote session occupancy emergency paths', () => {
  test('host preempt stops the projection outputs too, not only the game link', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, projection, ownerGame } = ctx;
    const projectionStop = jest.spyOn(projection.owner, 'emergencyStop');
    await operatorSession.occupyPlay({ gameId: 'surge-edging' });
    require('../services/playCarrierBus').emitPlayCarrierStart({ kind: 'bridge' });
    await flush();
    // 投影链路的锁存输出也要立刻停（不能等看门狗到期）
    expect(projectionStop).toHaveBeenCalled();
    expect(ownerGame.emergencyStop).toBeDefined();
    expect(ownerSession.getStatus().occupancy).toBeNull();
    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('an idempotent re-occupy keeps the host-side record for the operator bar', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession } = ctx;
    await operatorSession.occupyPlay({ gameId: 'surge-edging', gameName: '气压突变寸止' });
    expect(ownerSession.getStatus().occupancy).toMatchObject({ gameName: '气压突变寸止' });

    // 页面刷新 / 断线重连后的重复登记：被控端按幂等处理，不会重发占用事件
    await operatorSession.occupyPlay({ gameId: 'surge-edging' });
    await flush();
    expect(ownerSession.getStatus().occupancy).toMatchObject({
      gameId: 'surge-edging', gameName: '气压突变寸止',
    });
    expect(operatorSession.getStatus().localPlay).toMatchObject({ gameId: 'surge-edging' });
    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('the host emergency stop clears the occupancy so the operator stops its local play', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession } = ctx;
    await operatorSession.occupyPlay({ gameId: 'surge-edging', gameName: '气压突变寸止' });
    expect(ownerSession.getStatus().occupancy).toBeTruthy();
    expect(operatorSession.getStatus().localPlay).toBeTruthy();

    await ownerSession.emergencyStop();
    await flush();

    expect(ownerSession.getStatus().occupancy).toBeNull();
    expect(operatorSession.getStatus().localPlay).toBeNull();
    await ownerSession.stop();
    await operatorSession.stop();
  });
});

describe('projection write gate (host local play window)', () => {
  test('the gate is open while no local play runs, and closes while one does', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession } = ctx;
    // 没有本地玩法、没有主控端占用：投影写入照常
    expect(ownerSession._isPlayOccupied()).toBe(false);
    const bridgeService = require('../services/bridgeService');
    const spy = jest.spyOn(bridgeService, 'getActiveSessions').mockReturnValue([{ id: 'local-play' }]);
    try {
      expect(ownerSession._isPlayOccupied()).toBe(true);
    } finally {
      spy.mockRestore();
    }
    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('a host-run remote game is not treated as a local play', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, host } = ctx;
    // 被控端 HostRuntime 跑的是主控端起的那局：不算本地占用
    host.status = { active: true, running: true, source: 'remote', snapshot: { running: true } };
    expect(ownerSession._isPlayOccupied()).toBe(false);
    // 被控端自己起的 HostRuntime（source=local）才算本地占用
    host.status = { active: true, running: true, source: 'local', snapshot: { running: true } };
    expect(ownerSession._isPlayOccupied()).toBe(true);
    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('the gate is closed after a preempt until the operator occupies again', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession } = ctx;
    await operatorSession.occupyPlay({ gameId: 'surge-edging' });
    expect(ownerSession._isPlayOccupied()).toBe(false);

    require('../services/playCarrierBus').emitPlayCarrierStart({ kind: 'bridge' });
    await flush();
    // 顶替后主控端还没重新登记：只允许停止/归零（本地玩法也已退出，靠顶替标记继续挡）
    const bridgeService = require('../services/bridgeService');
    const spy = jest.spyOn(bridgeService, 'getActiveSessions').mockReturnValue([]);
    try {
      expect(ownerSession._isPlayOccupied()).toBe(true);
      // 主控端重新登记新占用的那一刻才放开
      await operatorSession.occupyPlay({ gameId: 'surge-edging' });
      await flush();
      expect(ownerSession._isPlayOccupied()).toBe(false);
      // 主控端停止玩法（占用释放）：残余写入窗口随之关闭
      await operatorSession.releasePlay({ gameId: 'surge-edging' });
      await flush();
      expect(ownerSession._isPlayOccupied()).toBe(false);
    } finally {
      spy.mockRestore();
    }
    await ownerSession.stop();
    await operatorSession.stop();
  });
});

describe('play end reason on the operator side', () => {
  test('a host local play preempt reports host-local-play', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession } = ctx;
    await operatorSession.occupyPlay({ gameId: 'surge-edging', gameName: '气压突变寸止' });
    require('../services/playCarrierBus').emitPlayCarrierStart({ kind: 'bridge' });
    await flush();
    expect(operatorSession.getStatus().localPlay).toBeNull();
    expect(operatorSession.getStatus().playEndedReason).toBe('host-local-play');
    await ownerSession.stop();
    await operatorSession.stop();
  });

  test('the host stopping the play reports host-stopped, not a preempt', async () => {
    const ctx = await setupActiveSession();
    const { ownerSession, operatorSession, ownerGame } = ctx;
    await operatorSession.occupyPlay({ gameId: 'surge-edging', gameName: '气压突变寸止' });
    // 被控端停止玩法（占用释放）走占用事件，不是顶替事件
    await ownerGame.command({ type: 'play.release', payload: { gameId: 'surge-edging' } });
    await flush();
    expect(operatorSession.getStatus().localPlay).toBeNull();
    expect(operatorSession.getStatus().playEndedReason).toBe('host-stopped');
    await ownerSession.stop();
    await operatorSession.stop();
  });
});
