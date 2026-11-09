const eventBus = require('../services/eventBus');
const playCarrierBus = require('../services/playCarrierBus');

describe('eventBus', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    eventBus._resetForTests();
  });

  afterEach(() => {
    eventBus._resetForTests();
    jest.useRealTimers();
  });

  it('assigns monotonically increasing seq and timestamps', () => {
    const a = eventBus.publish('device.added', { deviceId: 'd1' });
    const b = eventBus.publish('device.removed', { deviceId: 'd1' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.type).toBe('device.added');
    expect(typeof a.ts).toBe('number');
    expect(eventBus.getSeq()).toBe(2);
  });

  it('keeps a 500-event ring buffer', () => {
    for (let i = 0; i < 510; i += 1) eventBus.publish('device.updated', { n: i });
    const all = eventBus.recent({ limit: 1000 });
    expect(all).toHaveLength(eventBus.RING_SIZE);
    expect(all[0].seq).toBe(11);
    expect(all[all.length - 1].seq).toBe(510);
    expect(eventBus.recent({ limit: 3 }).map((event) => event.seq)).toEqual([508, 509, 510]);
  });

  it('filters by type prefix', () => {
    eventBus.publish('device.added', { deviceId: 'd1' });
    eventBus.publish('game.started', { gameId: 'g1' });
    eventBus.publish('game.state', { gameId: 'g1' });
    eventBus.publish('client.route', { path: '/home' });
    expect(eventBus.recent({ types: ['game'] }).map((event) => event.type)).toEqual(['game.started', 'game.state']);
    expect(eventBus.recent({ types: ['device', 'client'] })).toHaveLength(2);
    expect(eventBus.matchesTypes('game.started', ['game'])).toBe(true);
    expect(eventBus.matchesTypes('gameplay.started', ['game'])).toBe(false);
  });

  it('replays events after a given seq', () => {
    eventBus.publish('device.added', { n: 1 });
    eventBus.publish('device.added', { n: 2 });
    eventBus.publish('device.added', { n: 3 });
    expect(eventBus.since(1).map((event) => event.seq)).toEqual([2, 3]);
    expect(eventBus.since(99)).toEqual([]);
    expect(eventBus.since(0)).toHaveLength(3);
  });

  it('merges throttled device updates per device (>=200ms)', () => {
    eventBus.publishDeviceUpdated('d1', { a: { old: 0, new: 1 } }, { a: 1 }, 200);
    eventBus.publishDeviceUpdated('d1', { b: { old: 0, new: 2 } }, { a: 1, b: 2 }, 200);
    eventBus.publishDeviceUpdated('d2', { c: { old: 0, new: 3 } }, { c: 3 }, 200);
    expect(eventBus.recent({ limit: 10 })).toHaveLength(0);

    jest.advanceTimersByTime(199);
    expect(eventBus.recent({ limit: 10 })).toHaveLength(0);

    jest.advanceTimersByTime(1);
    const events = eventBus.recent({ limit: 10 });
    expect(events).toHaveLength(2);
    const d1 = events.find((event) => event.deviceId === 'd1');
    expect(d1.type).toBe('device.updated');
    expect(Object.keys(d1.changes).sort()).toEqual(['a', 'b']);
    expect(d1.data).toEqual({ a: 1, b: 2 });
  });

  it('flushThrottled emits pending events immediately', () => {
    eventBus.publishDeviceUpdated('d1', { a: { old: 0, new: 1 } }, { a: 1 }, 200);
    const flushed = eventBus.flushThrottled();
    expect(flushed).toHaveLength(1);
    expect(eventBus.recent({ limit: 10 })).toHaveLength(1);
  });

  it('maps play carrier start/exit to game events', () => {
    eventBus.attachGameCarrier();
    playCarrierBus.emitPlayCarrierStart({ kind: 'host', gameId: 'g1', source: 'local' });
    playCarrierBus.emitPlayCarrierExit({ kind: 'bridge', gameId: 'g2', reason: 'user_stop' });
    const events = eventBus.recent({ types: ['game'] });
    expect(events).toEqual([
      expect.objectContaining({ type: 'game.started', gameId: 'g1', carrier: 'host' }),
      expect.objectContaining({ type: 'game.stopped', gameId: 'g2', carrier: 'bridge', reason: 'user_stop' }),
    ]);
  });
});
