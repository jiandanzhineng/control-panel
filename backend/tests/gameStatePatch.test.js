// game-state-patch 单测：diff 只发变化部分、apply 能精确回放、坏 op 一律返回 null
const patch = require('../public/game-state-patch');

const { diff, apply, isApplicable, MAX_OPS, MAX_ARRAY_ITEMS } = patch;

describe('game-state-patch diff', () => {
  it('无变化时返回空数组', () => {
    expect(diff({ a: 1 }, { a: 1 })).toEqual([]);
    expect(diff(null, null)).toEqual([]);
    expect(diff({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toEqual([]);
    expect(diff('same', 'same')).toEqual([]);
  });

  it('标量变化只发一条 set', () => {
    expect(diff(1, 2)).toEqual([{ op: 'set', path: '', value: 2 }]);
    expect(diff({ level: 0 }, { level: 1 }))
      .toEqual([{ op: 'set', path: 'level', value: 1 }]);
  });

  it('字符串、布尔、数字变化都走 set', () => {
    expect(diff({ mode: 'idle' }, { mode: 'run' }))
      .toEqual([{ op: 'set', path: 'mode', value: 'run' }]);
    expect(diff({ on: false }, { on: true }))
      .toEqual([{ op: 'set', path: 'on', value: true }]);
    expect(diff({ pressure: 1.5 }, { pressure: 2.25 }))
      .toEqual([{ op: 'set', path: 'pressure', value: 2.25 }]);
  });

  it('嵌套对象变化产生点分路径', () => {
    const prev = { player: { stats: { hp: 100 } } };
    const next = { player: { stats: { hp: 80 } } };
    expect(diff(prev, next)).toEqual([{ op: 'set', path: 'player.stats.hp', value: 80 }]);
  });

  it('新增 key 发 set，删除 key 发 del', () => {
    expect(diff({ a: 1 }, { a: 1, b: 2 })).toEqual([{ op: 'set', path: 'b', value: 2 }]);
    expect(diff({ a: 1, b: 2 }, { a: 1 })).toEqual([{ op: 'del', path: 'b' }]);
  });

  it('值为 undefined 视为删除', () => {
    const next = { a: 1, b: undefined };
    expect(diff({ a: 1, b: 2 }, next)).toEqual([{ op: 'del', path: 'b' }]);
  });
});

describe('game-state-patch 数组与兜底', () => {
  it('采样数组追加只发新增尾部条目', () => {
    const prev = { samples: [1, 2, 3] };
    const next = { samples: [1, 2, 3, 4, 5] };
    expect(diff(prev, next)).toEqual([
      { op: 'append', path: 'samples', items: [4, 5] },
    ]);
  });

  it('倒序日志数组新条目走 prepend', () => {
    const prev = { logs: [{ id: 2 }, { id: 1 }] };
    const next = { logs: [{ id: 3 }, { id: 2 }, { id: 1 }] };
    expect(diff(prev, next)).toEqual([
      { op: 'prepend', path: 'logs', items: [{ id: 3 }] },
    ]);
  });

  it('既非前缀也非后缀时整段替换', () => {
    expect(diff({ v: [1, 2, 3] }, { v: [9, 8, 7] }))
      .toEqual([{ op: 'set', path: 'v', value: [9, 8, 7] }]);
    expect(diff({ v: [1, 2, 3] }, { v: [1, 9, 3] }))
      .toEqual([{ op: 'set', path: 'v', value: [1, 9, 3] }]);
  });

  it('数组缩水或类型变化时整体替换', () => {
    expect(diff({ v: [1, 2, 3] }, { v: [1, 2] }))
      .toEqual([{ op: 'set', path: 'v', value: [1, 2] }]);
    expect(diff({ v: [1, 2] }, { v: { 0: 1, 1: 2 } }))
      .toEqual([{ op: 'set', path: 'v', value: { 0: 1, 1: 2 } }]);
  });

  it('追加条目超过 MAX_ARRAY_ITEMS 退回 set', () => {
    const prev = { samples: [1] };
    const next = { samples: [1].concat(Array.from({ length: MAX_ARRAY_ITEMS + 1 }, (_, i) => i)) };
    const ops = diff(prev, next);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('set');
    expect(ops[0].value).toBe(next.samples);
  });

  it('追加条目恰好等于 MAX_ARRAY_ITEMS 仍走 append', () => {
    const added = Array.from({ length: MAX_ARRAY_ITEMS }, (_, i) => i);
    const ops = diff({ s: [1] }, { s: [1].concat(added) });
    expect(ops).toEqual([{ op: 'append', path: 's', items: added }]);
  });

  it('含点的 key 无法寻址，退化为整个父对象替换', () => {
    const next = { 'a.b': 2, x: 1 };
    expect(diff({ 'a.b': 1, x: 1 }, next))
      .toEqual([{ op: 'set', path: '', value: next }]);

    const nestedNext = { s: { 'a.b': 2 } };
    expect(diff({ s: { 'a.b': 1 } }, nestedNext))
      .toEqual([{ op: 'set', path: 's', value: nestedNext.s }]);
  });

  // 回归：不可寻址的 key 被删除 / 新增时也必须整份替换父对象。
  // 旧实现会发出 `del 'logs.'` 这种坏 path，apply 直接返回 null（丢帧），
  // 或把 `a.b` 写成 `{a:{b:…}}` 造成文档结构被改坏。
  it('不可寻址的 key 删除/新增时退化为父对象替换（不再产生坏 op）', () => {
    const nestedPrev = { logs: { '': 1, keep: 2 } };
    const nestedNext = { logs: { keep: 2 } };
    const ops = diff(nestedPrev, nestedNext);
    expect(ops).toEqual([{ op: 'set', path: 'logs', value: nestedNext.logs }]);
    expect(apply(nestedPrev, ops)).toEqual(nestedNext);

    const addPrev = { a: {} };
    const addNext = { a: { 'b.c': 1 } };
    const addOps = diff(addPrev, addNext);
    expect(addOps).toEqual([{ op: 'set', path: 'a', value: addNext.a }]);
    expect(apply(addPrev, addOps)).toEqual(addNext);

    // 根层同理：path '' 的 set 就是整份替换
    const rootPrev = { '': 1, keep: 2 };
    const rootNext = { keep: 2 };
    expect(diff(rootPrev, rootNext)).toEqual([{ op: 'set', path: '', value: rootNext }]);
    expect(apply(rootPrev, diff(rootPrev, rootNext))).toEqual(rootNext);
  });

  it('不可寻址的 key 值未变时不触发整份替换', () => {
    const prev = { s: { 'a.b': 1, keep: 1 } };
    const next = { s: { 'a.b': 1, keep: 2 } };
    expect(diff(prev, next)).toEqual([{ op: 'set', path: 's.keep', value: 2 }]);
  });

  it('op 数超过 MAX_OPS 时回退为一条根 set', () => {
    const next = {};
    for (let i = 0; i < MAX_OPS + 20; i++) next['k' + i] = i;
    const ops = diff({}, next);
    expect(ops).toEqual([{ op: 'set', path: '', value: next }]);
  });

  it('diff 不修改入参', () => {
    const prev = { a: { b: [1, 2] }, gone: 1 };
    const next = { a: { b: [1, 2, 3] }, fresh: 2 };
    const prevSnapshot = JSON.parse(JSON.stringify(prev));
    const nextSnapshot = JSON.parse(JSON.stringify(next));
    diff(prev, next);
    expect(prev).toEqual(prevSnapshot);
    expect(next).toEqual(nextSnapshot);
  });
});

// 性质测试：种子固定，失败可复现。形状覆盖嵌套对象/数组/标量/null/undefined，
// 键里混入不可寻址的 key（含点、空串）以覆盖「退化为父对象整体 set」的分支。
describe('game-state-patch 性质测试（apply(prev, diff(prev, next)) ≡ next）', () => {
  function seeded(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SAFE_KEYS = ['a', 'b', 'level', 'pressure', 'samples', 'logs', 'x'];
  const UNSAFE_KEYS = ['a.b', 'back\\slash', ''];

  function pickKey(rand) {
    const roll = rand();
    if (roll < 0.1) return UNSAFE_KEYS[Math.floor(rand() * UNSAFE_KEYS.length)];
    return SAFE_KEYS[Math.floor(rand() * SAFE_KEYS.length)];
  }

  function randValue(rand, depth) {
    if (depth <= 0 || rand() < 0.45) {
      const roll = rand();
      if (roll < 0.3) return Math.floor(rand() * 100);
      if (roll < 0.5) return rand() < 0.5;
      if (roll < 0.7) return `v${Math.floor(rand() * 10)}`;
      if (roll < 0.8) return null;
      if (roll < 0.9) return undefined; // 值为 undefined 的 key 必须按「删除」处理
      return Math.round(rand() * 1000) / 10;
    }
    if (rand() < 0.7) {
      const obj = {};
      const count = Math.floor(rand() * 4);
      for (let i = 0; i < count; i += 1) obj[pickKey(rand)] = randValue(rand, depth - 1);
      return obj;
    }
    const items = [];
    const count = Math.floor(rand() * 5);
    for (let i = 0; i < count; i += 1) items.push(randValue(rand, depth - 1));
    return items;
  }

  function randDoc(rand) {
    const doc = {};
    const count = Math.floor(rand() * 5);
    for (let i = 0; i < count; i += 1) doc[pickKey(rand)] = randValue(rand, 2);
    return doc;
  }

  // undefined 值的 key 视为不存在（diff 语义）；对象 key 顺序无关
  function normalize(value) {
    if (value === undefined) return { __undefined: true };
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(normalize);
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = normalize(value[key]);
    }
    return out;
  }

  // 深拷贝但保留 undefined（JSON 往返会把数组里的 undefined 变成 null，不能用来比「未修改」）
  function snapshotOf(value) {
    if (Array.isArray(value)) return value.map(snapshotOf);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) out[key] = snapshotOf(value[key]);
      return out;
    }
    return value;
  }

  it('500 组随机文档：round-trip 精确还原，且任何情况下都不返回 null', () => {
    const rand = seeded(20261007);
    for (let i = 0; i < 500; i += 1) {
      const prev = randDoc(rand);
      const next = randDoc(rand);
      const before = snapshotOf(prev);
      const ops = diff(prev, next);
      expect(Array.isArray(ops)).toBe(true);
      const applied = apply(prev, ops);
      expect(applied).not.toBeNull();
      expect(normalize(applied)).toEqual(normalize(next));
      // diff 不改入参
      expect(normalize(prev)).toEqual(normalize(before));
    }
  });

  it('1000 组随机「同形」文档（next 由 prev 派生）同样成立', () => {
    const rand = seeded(20261008);
    for (let i = 0; i < 1000; i += 1) {
      const prev = randDoc(rand);
      const next = JSON.parse(JSON.stringify(prev));
      // 随机增删改：覆盖 append / prepend / set / del 的混合路径
      const key = pickKey(rand);
      const roll = rand();
      if (roll < 0.3) next[key] = randValue(rand, 2);
      else if (roll < 0.5) delete next[key];
      else if (roll < 0.75 && Array.isArray(next[key])) next[key] = next[key].concat([randValue(rand, 1)]);
      else next[key] = randValue(rand, 2);
      const ops = diff(prev, next);
      const applied = apply(prev, ops);
      expect(applied).not.toBeNull();
      expect(normalize(applied)).toEqual(normalize(next));
    }
  });
});

describe('game-state-patch apply', () => {
  it('apply(prev, diff(prev, next)) 精确还原 next', () => {
    const cases = [
      [{ a: 1 }, { a: 2 }],
      [{ a: { b: 1 } }, { a: { b: 2, c: 3 } }],
      [{ a: 1, b: 2 }, { a: 1 }],
      [{ samples: [1, 2] }, { samples: [1, 2, 3, 4] }],
      [{ logs: [{ id: 2 }] }, { logs: [{ id: 3 }, { id: 2 }] }],
      [{ v: [1, 2, 3] }, { v: [7, 8] }],
      [{ s: { 'a.b': 1 } }, { s: { 'a.b': 2 } }],
      [null, { started: true }],
      [{ p: { q: { r: [1, { z: 1 }] } } }, { p: { q: { r: [1, { z: 2 }] } } }],
    ];
    cases.forEach(([prev, next]) => {
      const ops = diff(prev, next);
      expect(apply(prev, ops)).toEqual(next);
    });
  });

  it('apply 沿途克隆、未触及分支保持引用（结构共享）', () => {
    const shared = { keep: 1 };
    const prev = { touched: { hp: 1 }, shared: shared, list: [1, 2] };
    const next = { touched: { hp: 2 }, shared: shared, list: [1, 2, 3] };
    const result = apply(prev, diff(prev, next));
    expect(result).toEqual(next);
    expect(result.shared).toBe(shared);
    expect(result.list).not.toBe(prev.list);
    expect(prev.touched.hp).toBe(1);
  });

  it('del 不存在的 key 是空操作', () => {
    expect(apply({ a: 1 }, [{ op: 'del', path: 'missing' }])).toEqual({ a: 1 });
    expect(apply({ a: { b: 1 } }, [{ op: 'del', path: 'a.c' }])).toEqual({ a: { b: 1 } });
  });

  it('根 set 直接替换整个 state', () => {
    expect(apply({ a: 1 }, [{ op: 'set', path: '', value: { b: 2 } }]))
      .toEqual({ b: 2 });
    expect(apply(null, [{ op: 'set', path: '', value: [1, 2] }])).toEqual([1, 2]);
  });

  it('缺失的中间容器按当前段是否数字下标补建', () => {
    expect(apply({}, [{ op: 'set', path: 'a.b.c', value: 1 }]))
      .toEqual({ a: { b: { c: 1 } } });
    // 该段像数字下标 → 补数组
    expect(apply({}, [{ op: 'set', path: 'x.0', value: 9 }]))
      .toEqual({ x: [9] });
    expect(apply({}, [{ op: 'set', path: 'a.b.0', value: 9 }]))
      .toEqual({ a: { b: [9] } });
    // 容器已存在时保持原类型
    expect(apply({ a: {} }, [{ op: 'set', path: 'a.0', value: 9 }]))
      .toEqual({ a: { 0: 9 } });
  });

  it('append/prepend 目标不是数组时返回 null', () => {
    expect(apply({ logs: 'x' }, [{ op: 'append', path: 'logs', items: [1] }])).toBeNull();
    expect(apply({}, [{ op: 'prepend', path: 'logs', items: [1] }])).toBeNull();
  });

  it('append/prepend 在嵌套路径上生效', () => {
    expect(apply({ s: { logs: [2] } }, [{ op: 'prepend', path: 's.logs', items: [1] }]))
      .toEqual({ s: { logs: [1, 2] } });
    expect(apply({ s: { logs: [1] } }, [{ op: 'append', path: 's.logs', items: [2, 3] }]))
      .toEqual({ s: { logs: [1, 2, 3] } });
  });

  it('apply(state, []) 原样返回 state', () => {
    const state = { a: 1 };
    expect(apply(state, [])).toBe(state);
  });
});

describe('game-state-patch 坏输入与 isApplicable', () => {
  it('ops 不是数组时返回 null', () => {
    expect(apply({ a: 1 }, null)).toBeNull();
    expect(apply({ a: 1 }, undefined)).toBeNull();
    expect(apply({ a: 1 }, { op: 'set' })).toBeNull();
    expect(apply({ a: 1 }, 'set')).toBeNull();
  });

  it('未知 op、坏 path、坏 items 返回 null', () => {
    expect(apply({ a: 1 }, [{ op: 'merge', path: 'a', value: 2 }])).toBeNull();
    expect(apply({ a: 1 }, [{ op: 'set', path: 5, value: 2 }])).toBeNull();
    expect(apply({ a: 1 }, [{ op: 'set', path: 'a..b', value: 2 }])).toBeNull();
    expect(apply({ a: [] }, [{ op: 'append', path: 'a', items: 'x' }])).toBeNull();
    expect(apply({ a: 1 }, [null])).toBeNull();
    expect(apply({ a: 1 }, [{ op: 'del' }])).toBeNull();
  });

  it('isApplicable 只在 baseRev 等于本地 rev 时为真', () => {
    expect(isApplicable(3, { baseRev: 3 })).toBe(true);
    expect(isApplicable(3, { baseRev: 2 })).toBe(false);
    expect(isApplicable(3, { baseRev: '3' })).toBe(false);
  });

  it('isApplicable 对 null/undefined 本地 rev 或坏 patch 返回 false', () => {
    expect(isApplicable(null, { baseRev: 0 })).toBe(false);
    expect(isApplicable(undefined, { baseRev: 0 })).toBe(false);
    expect(isApplicable(0, null)).toBe(false);
    expect(isApplicable(0, undefined)).toBe(false);
    expect(isApplicable(0, {})).toBe(false);
  });
});
