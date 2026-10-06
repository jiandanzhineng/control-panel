// GameStateStream 单测：注入假定时器，配合真实 game-state-patch 模块验证合并/rev 语义
const { GameStateStream } = require('../game-runtime/gameStateStream');
const patch = require('../public/game-state-patch');

// 假时钟：收集待执行定时器，fire() 执行最早的一个
function createClock() {
  const timers = [];
  return {
    timers,
    setTimer(fn, ms) {
      const handle = { id: timers.length + 1 };
      timers.push({ fn, ms, handle });
      return handle;
    },
    clearTimer(handle) {
      const index = timers.findIndex((entry) => entry.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    fire() {
      const entry = timers.shift();
      if (!entry) throw new Error('没有待执行的定时器');
      entry.fn();
      return entry;
    },
  };
}

function createStream(clock, options) {
  return new GameStateStream(Object.assign({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  }, options));
}

// 记录事件的订阅者
function recorder(stream) {
  const events = [];
  const unsubscribe = stream.subscribe((event) => events.push(event));
  return { events, unsubscribe };
}

describe('GameStateStream', () => {
  it('新订阅者立刻收到 snapshot（发布前 snapshot 为 null、rev 为 0）', () => {
    const clock = createClock();
    const stream = createStream(clock);

    const { events } = recorder(stream);

    expect(events).toEqual([{ type: 'snapshot', rev: 0, state: null }]);
    expect(stream.getRev()).toBe(0);
    expect(stream.getSnapshot()).toBeNull();
  });

  it('首个快照发布后订阅者收到全量 snapshot，rev 递增到 1', () => {
    const clock = createClock();
    const stream = createStream(clock);
    const { events } = recorder(stream);

    stream.update({ pressure: 1 });
    expect(clock.timers).toHaveLength(1);
    clock.fire();

    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: 'snapshot',
      rev: 1,
      state: { pressure: 1 },
    });
    expect(stream.getSnapshot()).toEqual({ pressure: 1 });
  });

  it('无变化时不发事件、rev 不变', () => {
    const clock = createClock();
    const stream = createStream(clock);
    const listener = jest.fn();
    stream.subscribe(listener);
    listener.mockClear(); // 忽略订阅时的首帧

    stream.update({ pressure: 1 });
    clock.fire();
    expect(listener).toHaveBeenCalledTimes(1);

    stream.update({ pressure: 1 });
    clock.fire();
    expect(listener).toHaveBeenCalledTimes(1); // 无差异，不再通知
    expect(stream.getRev()).toBe(1);
  });

  it('标量变化在窗口结束后发一条 patch，baseRev 为上一次 rev', () => {
    const clock = createClock();
    const stream = createStream(clock);
    const { events } = recorder(stream);

    stream.update({ pressure: 1, level: 0 });
    clock.fire();
    stream.update({ pressure: 2, level: 0 });
    clock.fire();

    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ type: 'snapshot', rev: 1 });
    const evt = events[2];
    expect(evt.type).toBe('patch');
    expect(evt.rev).toBe(2);
    expect(evt.baseRev).toBe(1);
    expect(evt.ops).toHaveLength(1);
    // 只包含变化的路径（op 形状由 game-state-patch 定义，这里校验不含未变字段）
    expect(JSON.stringify(evt.ops)).toContain('pressure');
    expect(JSON.stringify(evt.ops)).not.toContain('level');
    expect(patch.apply(events[1].state, evt.ops)).toEqual({ pressure: 2, level: 0 });
    expect(stream.getRev()).toBe(2);
  });

  it('窗口内三次 update 只合并成一条 patch，diff 基准是上一次已发布快照', () => {
    const clock = createClock();
    const stream = createStream(clock);
    const { events } = recorder(stream);

    stream.update({ pressure: 1 });
    clock.fire(); // 已发布 { pressure: 1 }，rev=1

    stream.update({ pressure: 2 });
    stream.update({ pressure: 3 });
    stream.update({ pressure: 4 });
    expect(clock.timers).toHaveLength(1); // 三次 update 只排一次 flush

    clock.fire();
    expect(events).toHaveLength(3); // 首帧 + snapshot + 唯一一条 patch
    const evt = events[2];
    expect(evt.type).toBe('patch');
    expect(evt.rev).toBe(2);
    expect(evt.baseRev).toBe(1);
    // 若 diff 基准是「上一次 update」，回放到已发布快照会得到 3 而不是 4
    expect(patch.apply({ pressure: 1 }, evt.ops)).toEqual({ pressure: 4 });
    expect(stream.getSnapshot()).toEqual({ pressure: 4 });
  });

  it('windowMs 默认 50，可自定义', () => {
    const clock = createClock();
    const stream = createStream(clock);
    stream.update({ a: 1 });
    expect(clock.timers[0].ms).toBe(50);

    const clock2 = createClock();
    const stream2 = createStream(clock2, { windowMs: 200 });
    stream2.update({ a: 1 });
    expect(clock2.timers[0].ms).toBe(200);
  });

  it('中途订阅者先收到当前全量快照', () => {
    const clock = createClock();
    const stream = createStream(clock);
    stream.update({ score: 7 });
    clock.fire();

    const late = jest.fn();
    stream.subscribe(late);

    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith({
      type: 'snapshot',
      rev: 1,
      state: { score: 7 },
    });
  });

  it('reset() 发全量 snapshot、递增 rev，并丢弃待发布内容', () => {
    const clock = createClock();
    const stream = createStream(clock);
    const { events } = recorder(stream);

    stream.update({ round: 1 });
    clock.fire();
    stream.update({ round: 2 }); // 待发布，尚未到窗口
    expect(clock.timers).toHaveLength(1);

    const emitted = stream.reset({ round: 0 });

    expect(clock.timers).toHaveLength(0); // 待执行 flush 被取消
    expect(emitted).toEqual({ type: 'snapshot', rev: 2, state: { round: 0 } });
    expect(events).toHaveLength(3);
    expect(events[2]).toEqual(emitted);
    expect(stream.getSnapshot()).toEqual({ round: 0 });
  });

  it('reset(null) 仍发 snapshot 事件，快照为空', () => {
    const clock = createClock();
    const stream = createStream(clock);
    const { events } = recorder(stream);

    stream.reset(null);

    expect(events[1]).toEqual({ type: 'snapshot', rev: 1, state: null });
    expect(stream.getSnapshot()).toBeNull();
    expect(stream.getRev()).toBe(1);
  });

  it('clear() 取消待执行定时器且不再通知', () => {
    const clock = createClock();
    const stream = createStream(clock);
    const listener = jest.fn();
    stream.subscribe(listener);
    listener.mockClear();

    stream.update({ a: 1 });
    expect(clock.timers).toHaveLength(1);

    stream.clear();

    expect(clock.timers).toHaveLength(0);
    expect(stream.getRev()).toBe(0);
    expect(stream.getSnapshot()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('一个订阅者抛错不影响其他订阅者', () => {
    const clock = createClock();
    const stream = createStream(clock);
    const bad = jest.fn(() => {
      throw new Error('订阅者炸了');
    });
    const good = jest.fn();

    stream.subscribe(bad);
    stream.subscribe(good);
    stream.update({ a: 1 });
    expect(() => clock.fire()).not.toThrow();

    expect(bad).toHaveBeenCalledTimes(2); // 首帧 + snapshot
    expect(good).toHaveBeenCalledTimes(2);
    expect(good.mock.calls[1][0]).toEqual({
      type: 'snapshot',
      rev: 1,
      state: { a: 1 },
    });
  });

  it('flush() 无待发布内容时返回 null 且不递增 rev', () => {
    const clock = createClock();
    const stream = createStream(clock);
    stream.update({ a: 1 });
    clock.fire();

    expect(stream.flush()).toBeNull();
    expect(stream.getRev()).toBe(1);
  });

  it('退订后不再收到事件', () => {
    const clock = createClock();
    const stream = createStream(clock);
    const listener = jest.fn();
    const unsubscribe = stream.subscribe(listener);
    listener.mockClear();

    unsubscribe();
    stream.update({ a: 1 });
    clock.fire();

    expect(listener).not.toHaveBeenCalled();
  });
});
