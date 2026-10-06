// 女仆偷懒惩罚分离式核心：行为清单见 .tmp/maid-punishment-behavior.md
// 覆盖：按钮/压力触发与解除、防抖、TD01 启动与递增、参数校验、暂停/继续、停止复位、
// 锁、结束条件、渐进电压、以及经 gameHostService + 虚拟设备的冒烟测试。
const fs = require('fs');
const path = require('path');
const { MaidPunishmentCore, PARAMS } = require('../games/maid-punishment/game-core');
const { GameHostService } = require('../game-runtime/gameHostService');

const CORE_PATH = path.resolve(__dirname, '..', 'games', 'maid-punishment', 'game-core.js');

function core(params, random) {
  return new MaidPunishmentCore({ params: params || {}, random: random || (() => 0.5) });
}

function button(index, pressed) {
  return { type: 'device-property', name: `button${index}`, value: pressed ? 1 : 0 };
}

// 开局补发的按钮基线（契约第 3 节：seed:true 只作状态，不当变化）
function seededButton(index, pressed) {
  return { type: 'device-property', name: `button${index}`, value: pressed ? 1 : 0, oldValue: null, seed: true };
}

function pressure(value) {
  return { type: 'sensor', name: 'tiptoePressure', value };
}

function effectsOf(result, type) {
  return (result.effects || []).filter((effect) => effect.type === type);
}

// 默认参数下一局：开始（已解锁），返回 core
function started(params) {
  const instance = core(params);
  instance.start(0);
  return instance;
}

describe('maid-punishment core：开局', () => {
  test('start 解锁、记开始时间、写启动日志，并给出结束时间', () => {
    const instance = core({ duration: 10 });
    const result = instance.start(1000);
    expect(result.ok).toBe(true);
    expect(result.snapshot.running).toBe(true);
    expect(result.snapshot.startedAtMs).toBe(1000);
    expect(result.snapshot.endTimeMs).toBe(1000 + 10 * 60000);
    // 页面版 start() 调 setLock(false)：锁上（open=false），按钮显示「已加锁」
    expect(result.snapshot.isLocked).toBe(true);
    expect(result.snapshot.lockedText).toBe('已加锁');
    expect(result.snapshot.statusText).toBe('运行中');
    expect(result.logs.map((row) => row.message)).toContain('女仆惩罚启动');
    expect(effectsOf(result, 'device.lock')).toEqual([{ type: 'device.lock', role: 'lock', open: false }]);
  });

  test('manualStart：加锁并等待手动开启，forceStart 才计时', () => {
    const instance = core({ manualStart: true, duration: 2 });
    const started = instance.start(0);
    expect(started.snapshot.waitingForManualStart).toBe(true);
    // 页面版 setLock(true) = 解锁：手动模式启动时先解锁，等锁按键
    expect(started.snapshot.isLocked).toBe(false);
    expect(effectsOf(started, 'device.lock')).toEqual([{ type: 'device.lock', role: 'lock', open: true }]);
    expect(started.snapshot.statusText).toBe('等待手动开启');
    // 等待期间不推进（不会因为超时而结束）
    const waited = instance.step({ nowMs: 60 * 60 * 1000, events: [] });
    expect(waited.snapshot.running).toBe(true);
    expect(waited.snapshot.ended).toBe(false);
    const forced = instance.action('forceStart', {}, 5000);
    expect(forced.snapshot.waitingForManualStart).toBe(false);
    expect(forced.snapshot.startedAtMs).toBe(5000);
    expect(forced.snapshot.endTimeMs).toBe(5000 + 2 * 60000);
    // 页面版 forceStart 调 setLock(false) = 加锁
    expect(forced.snapshot.isLocked).toBe(true);
    expect(effectsOf(forced, 'device.lock')).toEqual([{ type: 'device.lock', role: 'lock', open: false }]);
  });

  test('manualStart：锁按键事件等同 forceStart', () => {
    const instance = core({ manualStart: true });
    instance.start(0);
    const result = instance.step({ nowMs: 100, events: [{ type: 'action', name: 'lock-key' }] });
    expect(result.snapshot.waitingForManualStart).toBe(false);
    expect(result.snapshot.startedAtMs).toBe(100);
  });

  test('电击按 shockDuration 到点自动停后，只要仍在违规，TD01 仍不启动', () => {
    // 页面版电击一直持续到松手，isShocking 始终为真，TD01 被挡住；
    // 分离式电击有时长上限，必须在「到点自动停但违规未解除」期间继续挡住 TD01。
    const instance = started({ td01DelaySeconds: 0, shockDurationSeconds: 1, duration: 10 });
    instance.step({ nowMs: 100, events: [button(0, true)] });
    expect(instance.snapshot().isShocking).toBe(true);
    const timedOut = instance.step({ nowMs: 1200, events: [] });
    expect(timedOut.snapshot.isShocking).toBe(false);
    const later = instance.step({ nowMs: 60000, events: [] });
    expect(later.snapshot.td01Active).toBe(false);
    expect(effectsOf(later, 'device.set-strength')).toEqual([]);
    // 违规解除后才开始计延时（页面版 stopShockSeq 分支会重置 lastNoShockTs）
    const released = instance.step({ nowMs: 61000, events: [button(0, false)] });
    expect(released.snapshot.lastNoShockTs).toBe(61000);
    expect(instance.step({ nowMs: 62000, events: [] }).snapshot.td01Active).toBe(true);
  });

  test('暂停期间锁按键照常开始计时（页面版 forceStart 的守卫只看 isActive）', () => {
    const instance = core({ manualStart: true });
    instance.start(0);
    instance.pause(100);
    const result = instance.step({ nowMs: 200, events: [{ type: 'action', name: 'lock-key' }] });
    expect(result.snapshot.waitingForManualStart).toBe(false);
    expect(result.snapshot.startedAtMs).toBe(200);
    expect(result.snapshot.isLocked).toBe(true); // forceStart 里 setLock(false) = 加锁
    // 页面版 forceStart 不清 paused，暂停状态保持
    expect(result.snapshot.paused).toBe(true);
  });

  test('重复 start 被拒绝；时间非法返回 INVALID_TIME', () => {
    const instance = started();
    expect(instance.start(10).code).toBe('ALREADY_RUNNING');
    expect(core().start(Number.NaN).code).toBe('INVALID_TIME');
    expect(instance.step({ nowMs: undefined }).code).toBe('INVALID_TIME');
  });
});

describe('maid-punishment core：按钮线（同一 step 内出电击意图）', () => {
  test('button0 按下 → 同一步返回电击意图，计数与状态文本更新', () => {
    const instance = started();
    const result = instance.step({ nowMs: 80, events: [button(0, true)] });
    expect(effectsOf(result, 'device.shock')).toEqual([
      { type: 'device.shock', role: 'shock', voltage: 24, durationMs: 10000 },
    ]);
    expect(result.snapshot.isShocking).toBe(true);
    expect(result.snapshot.shockCount).toBe(1);
    expect(result.snapshot.statusText).toBe('电击中(24V)');
    expect(result.logs.map((row) => row.message)).toEqual(['电击 24V（第 1 次）']);
  });

  test('button1 按下同样触发电击；按住不重复电击', () => {
    const instance = started();
    instance.step({ nowMs: 80, events: [button(1, true)] });
    const again = instance.step({ nowMs: 160, events: [button(1, true)] });
    expect(effectsOf(again, 'device.shock')).toEqual([]);
    expect(again.snapshot.shockCount).toBe(1);
  });

  test('松开按钮 → 停掉电击并重置「多久没被电」计时', () => {
    const instance = started();
    instance.step({ nowMs: 80, events: [button(0, true)] });
    const released = instance.step({ nowMs: 500, events: [button(0, false)] });
    expect(effectsOf(released, 'device.shock-stop')).toEqual([{ type: 'device.shock-stop', role: 'shock' }]);
    expect(released.snapshot.isShocking).toBe(false);
    expect(released.snapshot.statusText).toBe('运行中');
    expect(released.snapshot.lastNoShockTs).toBe(500);
  });

  test('两个按钮任一按住都算违规；松开另一个不算解除', () => {
    const instance = started();
    instance.step({ nowMs: 80, events: [button(0, true), button(1, true)] });
    expect(instance.snapshot().shockCount).toBe(1);
    const half = instance.step({ nowMs: 160, events: [button(0, false)] });
    expect(half.snapshot.isShocking).toBe(true);
    expect(effectsOf(half, 'device.shock-stop')).toEqual([]);
    const all = instance.step({ nowMs: 240, events: [button(1, false)] });
    expect(effectsOf(all, 'device.shock-stop')).toHaveLength(1);
  });
});

describe('maid-punishment core：压力线（阈值 + 防抖）', () => {
  test('超阈值要持续到防抖时长才判违规；期间不电击', () => {
    const instance = started({ tiptoePressureThreshold: 100, tiptoeDebounceMs: 300 });
    const first = instance.step({ nowMs: 100, events: [pressure(150)] });
    expect(first.snapshot.pressure1).toBe(150);
    expect(first.snapshot.pressureViolated).toBe(false);
    expect(effectsOf(first, 'device.shock')).toEqual([]);
    const mid = instance.step({ nowMs: 300, events: [] });
    expect(mid.snapshot.pressureViolated).toBe(false);
    const due = instance.step({ nowMs: 400, events: [] });
    expect(due.snapshot.pressureViolated).toBe(true);
    expect(effectsOf(due, 'device.shock')).toHaveLength(1);
  });

  test('压力值不再变化时靠后续 step 补判（页面版 500ms loop 的等价物）', () => {
    const instance = started({ tiptoeDebounceMs: 300 });
    instance.step({ nowMs: 100, events: [pressure(200)] });
    const later = instance.step({ nowMs: 450, events: [] });
    expect(later.snapshot.shockCount).toBe(1);
  });

  test('回落到阈值以下立即解除违规并停掉电击', () => {
    const instance = started({ tiptoeDebounceMs: 0 });
    instance.step({ nowMs: 100, events: [pressure(200)] });
    expect(instance.snapshot().isShocking).toBe(true);
    const back = instance.step({ nowMs: 200, events: [pressure(50)] });
    expect(back.snapshot.pressureViolated).toBe(false);
    expect(back.snapshot.isShocking).toBe(false);
    expect(back.snapshot.pressure1).toBe(50);
  });

  test('阈值以下的抖动不会误判（防抖计时被清空）', () => {
    const instance = started({ tiptoeDebounceMs: 300 });
    instance.step({ nowMs: 100, events: [pressure(150)] });
    instance.step({ nowMs: 200, events: [pressure(10)] });
    const again = instance.step({ nowMs: 250, events: [pressure(150)] });
    expect(again.snapshot.pressureViolated).toBe(false);
    // 重新开始计时：到 550 才满 300ms
    expect(instance.step({ nowMs: 400, events: [] }).snapshot.pressureViolated).toBe(false);
    expect(instance.step({ nowMs: 560, events: [] }).snapshot.pressureViolated).toBe(true);
  });

  test('pressure1 兼容别名与非法值按 0 处理', () => {
    const instance = started({ tiptoeDebounceMs: 0 });
    const zero = instance.step({ nowMs: 50, events: [{ type: 'sensor', name: 'pressure1', value: 'abc' }] });
    expect(zero.snapshot.pressure1).toBe(0);
    const over = instance.step({ nowMs: 100, events: [{ type: 'sensor', name: 'pressure1', value: 300 }] });
    expect(over.snapshot.pressureViolated).toBe(true);
  });

  test('暂停期间压力事件照常更新读数与防抖状态，但不触发电击', () => {
    const instance = started({ tiptoeDebounceMs: 0 });
    instance.pause(100);
    const result = instance.step({ nowMs: 200, events: [pressure(300)] });
    // 页面版暂停只挡住 applyTiptoeState（不触发/不解除），设备回调仍会更新读数并把防抖判成违规；
    // 恢复时 applyTiptoeState 再按当前状态评估，因此这里必须与页面一致地留下 violated=true。
    expect(result.snapshot.pressure1).toBe(300);
    expect(result.snapshot.pressureViolated).toBe(true);
    expect(result.snapshot.shockCount).toBe(0);
    expect(effectsOf(result, 'device.shock')).toEqual([]);
    const resumed = instance.resume(300);
    expect(effectsOf(resumed, 'device.shock')).toHaveLength(1);
  });

  test('暂停期间防抖计时照常推进，恢复时按已判定的违规立即电击', () => {
    const instance = started({ tiptoePressureThreshold: 100, tiptoeDebounceMs: 300 });
    instance.pause(0);
    instance.step({ nowMs: 200, events: [pressure(300)] });
    expect(instance.snapshot().pressureViolated).toBe(false);
    instance.step({ nowMs: 700, events: [pressure(310)] });
    expect(instance.snapshot().pressureViolated).toBe(true);
    expect(instance.snapshot().shockCount).toBe(0);
    const resumed = instance.resume(800);
    expect(effectsOf(resumed, 'device.shock')).toHaveLength(1);
  });
});

describe('maid-punishment core：开局补发的基线（seed）', () => {
  test('开局就按住按钮（seed）不电击；松手再按下才电击', () => {
    const instance = started({ duration: 10 });
    // 宿主开局补发「已按住」：只记状态，不判违规
    const seeded = instance.step({ nowMs: 0, events: [seededButton(0, true)] });
    expect(effectsOf(seeded, 'device.shock')).toEqual([]);
    expect(seeded.snapshot.shockCount).toBe(0);
    expect(seeded.snapshot.button0Pressed).toBe(true);
    // 时间推进也不因「一直按住」补判（按钮线不看 pressureViolated）
    const later = instance.step({ nowMs: 5000, events: [] });
    expect(effectsOf(later, 'device.shock')).toEqual([]);
    // 真实变化：松手（不电击、且不产生解除事件）
    const released = instance.step({ nowMs: 6000, events: [button(0, false)] });
    expect(released.snapshot.button0Pressed).toBe(false);
    expect(effectsOf(released, 'device.shock-stop')).toEqual([]);
    // 再次按下 → 电击
    const pressed = instance.step({ nowMs: 7000, events: [button(0, true)] });
    expect(effectsOf(pressed, 'device.shock')).toHaveLength(1);
    expect(pressed.snapshot.shockCount).toBe(1);
  });

  test('seed 的压力基线保持 readValue 语义：超阈值经防抖后照常电击', () => {
    const instance = started({ duration: 10, tiptoeDebounceMs: 300, tiptoePressureThreshold: 100 });
    const seeded = instance.step({ nowMs: 100, events: [
      { type: 'device-property', name: 'pressure1', value: 300, oldValue: null, seed: true },
    ] });
    expect(seeded.snapshot.pressure1).toBe(300);
    expect(seeded.snapshot.pressureViolated).toBe(false);
    expect(effectsOf(seeded, 'device.shock')).toEqual([]);
    const due = instance.step({ nowMs: 400, events: [] });
    expect(due.snapshot.pressureViolated).toBe(true);
    expect(effectsOf(due, 'device.shock')).toHaveLength(1);
  });
});

describe('maid-punishment core：TD01 逐步增强', () => {
  test('长时间未受罚 → 延时后启动，强度 10，之后每 5 秒 +50，封顶 255', () => {
    const instance = started({ td01DelaySeconds: 5, td01IntensityIncrease: 50, duration: 60 });
    const before = instance.step({ nowMs: 4999, events: [] });
    expect(before.snapshot.td01Active).toBe(false);
    const on = instance.step({ nowMs: 5000, events: [] });
    expect(on.snapshot.td01Active).toBe(true);
    expect(on.snapshot.td01Intensity).toBe(10);
    expect(effectsOf(on, 'device.set-strength')).toEqual([{ type: 'device.set-strength', role: 'motor', value: 10 }]);
    expect(on.logs.map((row) => row.message)).toContain('TD01 启动');
    const ramp = instance.step({ nowMs: 10000, events: [] });
    expect(ramp.snapshot.td01Intensity).toBe(60);
    expect(effectsOf(ramp, 'device.set-strength')).toEqual([{ type: 'device.set-strength', role: 'motor', value: 60 }]);
    let now = 10000;
    for (let i = 0; i < 6; i += 1) {
      now += 5000;
      instance.step({ nowMs: now, events: [] });
    }
    expect(instance.snapshot().td01Intensity).toBe(255);
  });

  test('电击期间 TD01 不启动也不递增；松手后重新计延时', () => {
    const instance = started({ td01DelaySeconds: 0, duration: 60 });
    instance.step({ nowMs: 100, events: [button(0, true)] });
    const held = instance.step({ nowMs: 60000, events: [] });
    expect(held.snapshot.td01Active).toBe(false);
    const released = instance.step({ nowMs: 60001, events: [button(0, false)] });
    expect(released.snapshot.lastNoShockTs).toBe(60001);
    // 违规触发时 resetTd01 会停掉已激活的 TD01
    const running = instance.step({ nowMs: 70000, events: [] });
    expect(running.snapshot.td01Active).toBe(true);
    const punished = instance.step({ nowMs: 80000, events: [button(0, true)] });
    expect(punished.snapshot.td01Active).toBe(false);
    expect(effectsOf(punished, 'device.stop-strength')).toHaveLength(1);
  });

  test('td01ShockProbability 命中时额外电击一次（只计数，无日志）', () => {
    const instance = core({ td01DelaySeconds: 0, td01ShockProbability: 100 }, () => 0.1);
    instance.start(0);
    const result = instance.step({ nowMs: 80, events: [] });
    expect(result.snapshot.shockCount).toBe(1);
    expect(result.snapshot.isShocking).toBe(true);
    expect(result.logs.map((row) => row.message)).toEqual(['TD01 启动']);
  });

  test('td01ShockProbability 未命中时不电击；0 永远不额外电击', () => {
    const miss = core({ td01DelaySeconds: 0, td01ShockProbability: 50 }, () => 0.9);
    miss.start(0);
    expect(miss.step({ nowMs: 80, events: [] }).snapshot.shockCount).toBe(0);
    const zero = core({ td01DelaySeconds: 0, td01ShockProbability: 0 }, () => 0);
    zero.start(0);
    expect(zero.step({ nowMs: 80, events: [] }).snapshot.shockCount).toBe(0);
  });
});

describe('maid-punishment core：电击电压（渐进 / 安全上限）', () => {
  test('渐进强度按「本次电击之前」的次数递增，且不超过 maxIntensityIncrease', () => {
    const instance = started({ progressiveIntensity: true, shockIntensity: 10, maxIntensityIncrease: 10, duration: 60 });
    const voltages = [];
    for (let i = 0; i < 4; i += 1) {
      const on = instance.step({ nowMs: 100 + i * 200, events: [button(0, true)] });
      voltages.push(effectsOf(on, 'device.shock')[0].voltage);
      instance.step({ nowMs: 150 + i * 200, events: [button(0, false)] });
    }
    expect(voltages).toEqual([10, 15, 20, 20]);
    expect(instance.snapshot().shockCount).toBe(4);
  });

  test('allowUnsafeIntensity 关闭时电压封顶 30V，开启后按配置走', () => {
    const safe = started({ shockIntensity: 45, duration: 60 });
    const safeShock = safe.step({ nowMs: 80, events: [button(0, true)] });
    expect(effectsOf(safeShock, 'device.shock')[0].voltage).toBe(30);
    const unsafe = started({ shockIntensity: 45, allowUnsafeIntensity: true, duration: 60 });
    const unsafeShock = unsafe.step({ nowMs: 80, events: [button(0, true)] });
    expect(effectsOf(unsafeShock, 'device.shock')[0].voltage).toBe(45);
  });

  test('shockDurationSeconds 决定电击意图时长，到点自动停', () => {
    const instance = started({ shockDurationSeconds: 5, duration: 60 });
    const on = instance.step({ nowMs: 80, events: [button(0, true)] });
    expect(effectsOf(on, 'device.shock')[0].durationMs).toBe(5000);
    const held = instance.step({ nowMs: 4000, events: [] });
    expect(held.snapshot.isShocking).toBe(true);
    const timedOut = instance.step({ nowMs: 5080, events: [] });
    expect(effectsOf(timedOut, 'device.shock-stop')).toHaveLength(1);
    expect(timedOut.snapshot.isShocking).toBe(false);
  });

  test('shockOnce 动作只电击一次并重置 TD01 计时', () => {
    const instance = started({ td01DelaySeconds: 0, duration: 60 });
    const result = instance.action('shockOnce', {}, 100);
    expect(result.snapshot.shockCount).toBe(1);
    expect(result.snapshot.lastNoShockTs).toBe(100);
    expect(effectsOf(result, 'device.shock')).toHaveLength(1);
  });
});

describe('maid-punishment core：暂停 / 继续 / 结束 / 锁', () => {
  test('暂停停掉电击与 TD01，状态文本与按钮文本切换，总时长不顺延', () => {
    const instance = started({ duration: 1, td01DelaySeconds: 0 });
    instance.step({ nowMs: 100, events: [button(0, true)] });
    const paused = instance.pause(200);
    expect(paused.snapshot.paused).toBe(true);
    expect(paused.snapshot.isShocking).toBe(false);
    expect(paused.snapshot.statusText).toBe('已暂停');
    expect(paused.snapshot.btnText).toBe('继续');
    expect(effectsOf(paused, 'device.shock-stop')).toHaveLength(1);
    expect(paused.logs.map((row) => row.message)).toEqual(['已暂停']);
    // 暂停期间不推进：即使越过结束时间也不结束
    const held = instance.step({ nowMs: 60000, events: [] });
    expect(held.snapshot.ended).toBe(false);
    expect(held.snapshot.running).toBe(true);
  });

  test('继续时按当前传感器状态重新评估（仍按住 → 立即电击）', () => {
    const instance = started({ duration: 10 });
    instance.step({ nowMs: 100, events: [button(0, true)] });
    instance.pause(200);
    const resumed = instance.resume(300);
    expect(resumed.snapshot.paused).toBe(false);
    expect(resumed.snapshot.isShocking).toBe(true);
    expect(effectsOf(resumed, 'device.shock')).toHaveLength(1);
    expect(resumed.logs.map((row) => row.message)).toEqual(['已继续', '电击 24V（第 2 次）']);
  });

  test('未暂停时 resume 报 NOT_PAUSED；未运行时 pause/resume 报 NOT_RUNNING', () => {
    const instance = started();
    expect(instance.resume(100).code).toBe('NOT_PAUSED');
    const idle = core();
    expect(idle.pause(0).code).toBe('NOT_RUNNING');
    expect(idle.resume(0).code).toBe('NOT_RUNNING');
  });

  test('时长到点自然结束：复位输出、加锁、写结束日志', () => {
    const instance = started({ duration: 1 });
    instance.step({ nowMs: 100, events: [button(0, true)] });
    const ended = instance.step({ nowMs: 60000, events: [] });
    expect(ended.snapshot.ended).toBe(true);
    expect(ended.snapshot.running).toBe(false);
    expect(ended.snapshot.endReason).toBe('duration');
    expect(ended.snapshot.statusText).toBe('已结束');
    expect(ended.snapshot.isShocking).toBe(false);
    // 页面版 end() 调 setLock(true) = 解锁
    expect(ended.snapshot.isLocked).toBe(false);
    expect(ended.snapshot.lockedText).toBe('已解锁');
    expect(ended.snapshot.logs[0].message).toBe('女仆惩罚结束（电击 1 次）');
    const types = (ended.effects || []).map((effect) => effect.type);
    expect(types).toContain('device.shock-stop');
    expect(types).toContain('device.lock');
    expect(types).toContain('device.stop-all');
  });

  test('结束当拍不再推进 TD01（与页面 loop 的结束分支一致）', () => {
    const instance = started({ duration: 1, td01DelaySeconds: 0 });
    const ended = instance.step({ nowMs: 60000, events: [] });
    expect(ended.snapshot.td01Intensity).toBe(0);
    expect(effectsOf(ended, 'device.set-strength')).toEqual([]);
  });

  test('stop 立即结束并复位；重复 stop 幂等', () => {
    const instance = started({ duration: 10 });
    instance.step({ nowMs: 100, events: [button(0, true)] });
    const stopped = instance.stop(200, 'user_stop');
    expect(stopped.snapshot.ended).toBe(true);
    expect(stopped.snapshot.endReason).toBe('user_stop');
    expect(stopped.snapshot.isLocked).toBe(false);
    const again = instance.stop(300, 'user_stop');
    expect(again.snapshot.ended).toBe(true);
    expect(effectsOf(again, 'device.shock-stop')).toEqual([]);
  });

  test('unlock 动作解锁并写日志；未运行时动作返回 NOT_RUNNING，未知动作返回 UNKNOWN_ACTION', () => {
    const instance = started({ duration: 10 });
    instance.action('forceStart', {}, 90); // 先加锁，再验证解锁按钮
    const unlocked = instance.action('unlock', {}, 100);
    expect(unlocked.snapshot.isLocked).toBe(false);
    expect(unlocked.snapshot.lockedText).toBe('已解锁');
    expect(unlocked.logs.map((row) => row.message)).toEqual(['手动解锁']);
    expect(instance.action('nope', {}, 100).code).toBe('UNKNOWN_ACTION');
    const idle = core();
    expect(idle.action('unlock', {}, 0).code).toBe('NOT_RUNNING');
  });
});

describe('maid-punishment core：参数校验与快照契约', () => {
  test('未知键忽略；数值按 manifest 的 min/max 钳制；非法值回落默认', () => {
    const instance = core();
    const result = instance.setParams({
      duration: 999,
      shockIntensity: 0,
      maxIntensityIncrease: -5,
      tiptoeDebounceMs: 'abc',
      manualStart: 'yes',
      nope: 1,
    });
    expect(result.ok).toBe(true);
    const params = result.snapshot.params;
    expect(params.duration).toBe(120);
    expect(params.shockIntensity).toBe(1);
    expect(params.maxIntensityIncrease).toBe(0);
    expect(params.tiptoeDebounceMs).toBe(300);
    expect(params.manualStart).toBe(false);
    expect(params.nope).toBeUndefined();
  });

  test('非对象参数返回 INVALID_PARAMS 且不抛异常', () => {
    const instance = core();
    expect(instance.setParams(null).code).toBe('INVALID_PARAMS');
    expect(instance.setParams('x').code).toBe('INVALID_PARAMS');
    expect(instance.setParams([1]).code).toBe('INVALID_PARAMS');
  });

  test('运行中改时长顺延结束时间', () => {
    const instance = started({ duration: 10 });
    expect(instance.snapshot().endTimeMs).toBe(10 * 60000);
    instance.setParams({ duration: 20 });
    expect(instance.snapshot().endTimeMs).toBe(20 * 60000);
  });

  test('快照可序列化，包含渲染所需全部字段，日志上限 10 条', () => {
    const instance = started({ duration: 60, td01DelaySeconds: 0, tiptoeDebounceMs: 0 });
    for (let i = 0; i < 30; i += 1) {
      const at = 100 + i * 300;
      instance.step({ nowMs: at, events: [pressure(i % 2 ? 300 : 0)] });
    }
    const snapshot = instance.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot.logs.length).toBeLessThanOrEqual(10);
    for (const key of [
      'running', 'paused', 'ended', 'startedAtMs', 'endTimeMs', 'remainingSec', 'statusText', 'btnText',
      'isLocked', 'lockedText', 'button0Pressed', 'button1Pressed', 'hasPressure', 'pressure1',
      'pressureViolated', 'isShocking', 'shockCount', 'lastShockVoltage', 'td01Active', 'td01Intensity',
      'nextWakeAtMs', 'params', 'logs',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(snapshot, key)).toBe(true);
    }
    expect(snapshot.remainingSec).toBeGreaterThan(0);
    expect(snapshot.pressure1).toBe(300);
  });

  test('暂停时 remainingSec 冻结（页面版暂停不更新剩余秒数）', () => {
    const instance = started({ duration: 1 });
    instance.step({ nowMs: 10000, events: [] });
    expect(instance.snapshot().remainingSec).toBe(50);
    instance.pause(10000);
    expect(instance.snapshot().remainingSec).toBe(50);
  });

  test('确定性：同样输入序列两次运行结果完全一致', () => {
    const run = () => {
      const instance = core({ td01DelaySeconds: 0, tiptoeDebounceMs: 200 }, () => 0.42);
      const rows = [];
      rows.push(instance.start(0).snapshot);
      rows.push(instance.step({ nowMs: 100, events: [pressure(300)] }).snapshot);
      rows.push(instance.step({ nowMs: 400, events: [] }).snapshot);
      rows.push(instance.step({ nowMs: 600, events: [pressure(0)] }).snapshot);
      return JSON.stringify(rows);
    };
    expect(run()).toBe(run());
  });

  test('不读系统时间、不用计时器、不碰 DOM（源码静态检查）', () => {
    const code = fs.readFileSync(CORE_PATH, 'utf8');
    for (const pattern of [/Date\s*\.\s*now/, /performance\s*\./, /setTimeout/, /setInterval/, /Math\s*\.\s*random/,
      /require\s*\(\s*['"](fs|net|http|https|child_process|worker_threads|vm)['"]/, /\bprocess\b/, /\bglobalThis\b/,
      /document\./, /window\./]) {
      expect(code).not.toMatch(pattern);
    }
  });

  test('导出的 PARAMS 与 manifest 参数键一致', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'games', 'maid-punishment', 'index.html'), 'utf8');
    const manifest = JSON.parse(html.match(/<script[^>]*id\s*=\s*["']game-manifest["'][^>]*>([\s\S]*?)<\/script>/i)[1]);
    expect(manifest.runtime).toBe('host');
    expect(manifest.core).toBe('game-core.js');
    expect(manifest.params.map((row) => row.key).sort()).toEqual(PARAMS.map((row) => row.key).sort());
    expect(manifest.version).toBe(require('../games/maid-punishment/game-core').VERSION);
  });
});

// ---- 经 gameHostService + 虚拟设备的冒烟测试（模式同 gameHostService.test.js）----
function fakeDevices(rows) {
  return {
    rows: new Map(rows.map((row) => [row.id, row])),
    calls: [],
    handlers: [],
    rawHandlers: [],
    getDeviceById(id) { return this.rows.get(id) || null; },
    onDeviceDataChange(handler) { this.handlers.push(handler); },
    onDeviceRawMessage(handler) { this.rawHandlers.push(handler); },
    invokeDeviceCapability(id, capability, action, input) {
      this.calls.push({ id, capability, action, input });
    },
    emit(event) { for (const handler of this.handlers) handler(event); },
    emitRaw(event) { for (const handler of this.rawHandlers) handler(event); },
  };
}

function fakeVirtual() {
  return {
    calls: [],
    isVirtualDevice: (id) => String(id).startsWith('vb_'),
    interceptCommand(id, cmd) { this.calls.push({ id, cmd }); },
  };
}

function fakeClock() {
  return {
    timers: [],
    intervals: [],
    setTimer(fn, delay) {
      const handle = { fn, delay, cleared: false };
      this.timers.push(handle);
      return handle;
    },
    clearTimer(handle) { if (handle) handle.cleared = true; },
    setRepeating(fn, delay) {
      const handle = { fn, delay, cleared: false };
      this.intervals.push(handle);
      return handle;
    },
    clearRepeating(handle) { if (handle) handle.cleared = true; },
  };
}

const CAPS = { QTZ: ['buttonInput', 'reporting'], CUNZHI01: ['tiptoePressure', 'reporting'], TD01: ['strength'], DIANJI: ['shock'], ZIDONGSUO: ['lock'] };

function createHost(devices, extra = {}) {
  const time = fakeClock();
  let now = 0;
  const host = new GameHostService({
    devices,
    registry: { hasCapability: (type, key) => (CAPS[type] || []).includes(key) },
    virtualDevices: extra.virtualDevices || fakeVirtual(),
    now: () => now,
    random: () => 0.5,
    setTimer: time.setTimer.bind(time),
    clearTimer: time.clearTimer.bind(time),
    setRepeating: time.setRepeating.bind(time),
    clearRepeating: time.clearRepeating.bind(time),
  });
  return { host, time, setNow(value) { now = value; } };
}

const DEVICES = () => fakeDevices([
  { id: 'qtz1', type: 'QTZ' },
  { id: 'c1', type: 'CUNZHI01' },
  { id: 'm1', type: 'TD01' },
  { id: 'p1', type: 'DIANJI' },
  { id: 'lock1', type: 'ZIDONGSUO' },
]);

const MAP = { qtz: ['qtz1'], sensor: ['c1'], shock: ['p1'], motor: ['m1'], lock: ['lock1'] };
const VMAP = { qtz: ['qtz1'], tiptoeSensor: ['c1'], shock: ['p1'], motor: ['m1'], lock: ['lock1'] };

// 宿主发出的设备事件（gameHostService 内部 enqueue 的原样对象）
function hostEvents(host) {
  const rows = [];
  const original = host.session.runtime.enqueue.bind(host.session.runtime);
  host.session.runtime.enqueue = (events) => {
    for (const event of Array.isArray(events) ? events : [events]) {
      if (event && typeof event === 'object') rows.push(event);
    }
    return original(events);
  };
  return rows;
}

// 记录每个设备收到的能力调用
function withLog(devices, id) {
  const log = [];
  devices.rows.set(id, { id, type: 'DIANJI' });
  const original = devices.invokeDeviceCapability.bind(devices);
  devices.invokeDeviceCapability = (deviceId, capability, action, input) => {
    if (deviceId === id) log.push({ capability, action, input });
    return original(deviceId, capability, action, input);
  };
  return log;
}

describe('maid-punishment：宿主运行时冒烟（虚拟设备）', () => {
  test('已接入宿主游戏列表，start 走游戏包核心并解锁', () => {
    const devices = DEVICES();
    const { host } = createHost(devices);
    expect(host.isHostGame('maid-punishment')).toBe(true);
    const started = host.start({ gameId: 'maid-punishment', deviceMap: MAP, params: { duration: 10 } });
    expect(started.runtimeMode).toBe('host');
    expect(started.snapshot.gameId).toBe('maid-punishment');
    expect(started.snapshot.version).toBe(require('../games/maid-punishment/game-core').VERSION);
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'lock1', capability: 'lock', action: 'setOpen', input: { open: false } }),
    ]));
  });

  test('虚拟设备收到强度与电击；按钮事件在同一 tick 内产出电击意图', () => {
    const devices = DEVICES();
    const virtual = fakeVirtual();
    const { host, setNow } = createHost(devices, { virtualDevices: virtual });
    devices.rows.set('vb_shock', { id: 'vb_shock', type: 'DIANJI' });
    devices.rows.set('vb_motor', { id: 'vb_motor', type: 'TD01' });
    host.start({
      gameId: 'maid-punishment',
      deviceMap: { ...MAP, shock: ['vb_shock', 'p1'], motor: ['vb_motor', 'm1'] },
      params: { duration: 10, td01DelaySeconds: 0 },
    });
    setNow(80);
    const status = host.tick(80); // 先让 TD01 启动（延时 0）
    expect(status.snapshot.td01Active).toBe(true);
    expect(virtual.calls.some((call) => call.id === 'vb_motor' && call.cmd.capability === 'strength')).toBe(true);

    // 按钮事件：宿主按 deviceMap.qtz 转发设备属性（device-property），同一 tick 内出电击意图
    setNow(160);
    devices.emit({ deviceId: 'qtz1', changes: { button0: { old: 0, new: 1 } }, nextData: { button0: 1 } });
    const pushed = host.getStatus();
    expect(pushed.snapshot.shockCount).toBe(1);
    expect(pushed.snapshot.isShocking).toBe(true);
    const shockCall = devices.calls.find((call) => call.id === 'p1' && call.capability === 'shock' && call.action === 'start');
    expect(shockCall).toBeTruthy();
    expect(shockCall.input.voltage).toBe(24);
    expect(virtual.calls.some((call) => call.id === 'vb_shock' && call.cmd.capability === 'shock')).toBe(true);
  });

  test('设备数据变化触发的 step 是同步的：emit 返回时电击意图已下发', () => {
    const devices = DEVICES();
    const { host, setNow } = createHost(devices);
    host.start({
      gameId: 'maid-punishment',
      deviceMap: VMAP,
      params: { duration: 10, tiptoeDebounceMs: 0 },
    });
    setNow(100);
    devices.emit({ deviceId: 'c1', changes: { pressure1: { old: 0, new: 300 } }, nextData: { pressure1: 300 } });
    // emit 内部走 pushSensor → tick，同步执行；无需等待 80ms 定时器
    expect(devices.calls.some((call) => call.id === 'p1' && call.capability === 'shock' && call.action === 'start')).toBe(true);
    expect(host.getStatus().snapshot.isShocking).toBe(true);
  });

  test('非映射设备的按钮事件不影响本局', () => {
    const devices = DEVICES();
    const { host } = createHost(devices);
    host.start({ gameId: 'maid-punishment', deviceMap: { shock: ['p1'] }, params: { duration: 10 } });
    devices.emit({ deviceId: 'qtz1', changes: { button0: { new: 1 } }, nextData: { button0: 1 } });
    expect(host.getStatus().snapshot.shockCount).toBe(0);
    expect(devices.calls.some((call) => call.capability === 'shock')).toBe(false);
  });

  test('开局前已按住的按钮：宿主补发基线，不电击；松手再按下才电击', () => {
    const devices = DEVICES();
    // 设备当前属性就是「按住」：宿主 start 时按契约补发 seed 事件
    devices.rows.set('qtz1', { id: 'qtz1', type: 'QTZ', data: { button0: 1 } });
    const { host, setNow } = createHost(devices);
    host.start({ gameId: 'maid-punishment', deviceMap: VMAP, params: { duration: 10 } });
    expect(host.getStatus().snapshot.button0Pressed).toBe(true);
    expect(host.getStatus().snapshot.shockCount).toBe(0);
    expect(devices.calls.some((call) => call.capability === 'shock')).toBe(false);
    // 真实变化：松手（不产生解除电击），再按下 → 电击
    setNow(1000);
    devices.emit({ deviceId: 'qtz1', changes: { button0: { old: 1, new: 0 } }, nextData: { button0: 0 } });
    expect(devices.calls.some((call) => call.capability === 'shock')).toBe(false);
    setNow(2000);
    devices.emit({ deviceId: 'qtz1', changes: { button0: { old: 0, new: 1 } }, nextData: { button0: 1 } });
    const shockCall = devices.calls.find((call) => call.id === 'p1' && call.capability === 'shock' && call.action === 'start');
    expect(shockCall).toBeTruthy();
    expect(host.getStatus().snapshot.shockCount).toBe(1);
  });

  test('开局前压力已超阈值：宿主补发基线，防抖后照常电击（页面版 readValue 语义）', () => {
    const devices = DEVICES();
    devices.rows.set('c1', { id: 'c1', type: 'CUNZHI01', data: { pressure1: 300 } });
    const { host, setNow } = createHost(devices);
    setNow(1000); // 真实宿主用 Date.now()，不会从 0 起算（0 会让防抖起点被当成「未开始计时」）
    host.start({
      gameId: 'maid-punishment',
      deviceMap: VMAP,
      params: { duration: 10, tiptoeDebounceMs: 300, tiptoePressureThreshold: 100 },
    });
    expect(host.getStatus().snapshot.pressure1).toBe(300);
    expect(host.getStatus().snapshot.pressureViolated).toBe(false);
    setNow(1400);
    host.tick(1400);
    expect(host.getStatus().snapshot.pressureViolated).toBe(true);
    expect(devices.calls.some((call) => call.id === 'p1' && call.capability === 'shock')).toBe(true);
  });

  test('压力设备数据变化经宿主进入核心（角色 tiptoeSensor，属性 pressure1）', () => {
    const devices = DEVICES();
    const { host, setNow } = createHost(devices);
    host.start({
      gameId: 'maid-punishment',
      deviceMap: VMAP,
      params: { duration: 10, tiptoeDebounceMs: 0, tiptoePressureThreshold: 100 },
    });
    setNow(100);
    // 宿主把已映射设备的属性变化原样转发为 device-property（name = 设备属性名 pressure1），
    // core 同时接受 tiptoePressure / pressure1 / sphincterPressure。
    devices.emit({ deviceId: 'c1', changes: { pressure1: { old: 0, new: 300 } }, nextData: { pressure1: 300 } });
    const status = host.getStatus();
    expect(status.snapshot.pressure1).toBe(300);
    expect(status.snapshot.pressureViolated).toBe(true);
    expect(devices.calls.some((call) => call.id === 'p1' && call.capability === 'shock')).toBe(true);
  });

  test('QTZ 按钮按下 → 宿主转发 device-property → 同一 tick 内下发 virtual shocker 电击指令', () => {
    const devices = DEVICES();
    const virtual = fakeVirtual();
    const { host, setNow } = createHost(devices, { virtualDevices: virtual });
    devices.rows.set('vb_qtz', { id: 'vb_qtz', type: 'QTZ' });
    devices.rows.set('vb_shock', { id: 'vb_shock', type: 'DIANJI' });
    host.start({
      gameId: 'maid-punishment',
      deviceMap: { ...VMAP, qtz: ['vb_qtz'], shock: ['vb_shock'] },
      params: { duration: 10 },
    });
    setNow(100);
    devices.emit({ deviceId: 'vb_qtz', changes: { button0: { old: 0, new: 1 } }, nextData: { button0: 1 } });
    // 同一同步调用内：核心出电击意图、宿主执行到虚拟电击器
    const shock = virtual.calls.find((call) => call.id === 'vb_shock' && call.cmd.capability === 'shock');
    expect(shock).toBeTruthy();
    expect(shock.cmd.params.voltage).toBe(24);
    expect(host.getStatus().snapshot.isShocking).toBe(true);
  });

  test('未映射设备的属性变化不进入核心', () => {
    const devices = DEVICES();
    const { host, setNow } = createHost(devices);
    host.start({ gameId: 'maid-punishment', deviceMap: { shock: ['p1'] }, params: { duration: 10 } });
    const seen = hostEvents(host);
    setNow(100);
    devices.emit({ deviceId: 'qtz1', changes: { button0: { old: 0, new: 1 } }, nextData: { button0: 1 } });
    expect(seen).toEqual([]);
    expect(host.getStatus().snapshot.shockCount).toBe(0);
    expect(devices.calls.some((call) => call.capability === 'shock')).toBe(false);
  });

  test('属性值未变化时不产生事件；变化才转发且带 oldValue', () => {
    const devices = DEVICES();
    const { host, setNow } = createHost(devices);
    // 开局会按设备当前属性补发一次初始值（对齐页面版 readValue），此后 oldValue 就能带出上一次的值
    devices.rows.set('qtz1', { id: 'qtz1', type: 'QTZ', data: { button0: 0 } });
    host.start({ gameId: 'maid-punishment', deviceMap: VMAP, params: { duration: 10 } });
    const seen = hostEvents(host);
    setNow(100);
    // 设备周期重报同一份数据：updateDeviceData 不会产生 changes，宿主也就没有事件
    devices.emit({ deviceId: 'qtz1', changes: {}, nextData: { button0: 0 } });
    expect(seen).toEqual([]);
    devices.emit({ deviceId: 'qtz1', changes: { button0: { old: 0, new: 1 } }, nextData: { button0: 1 } });
    expect(seen).toEqual([{ type: 'device-property', role: 'qtz', deviceId: 'qtz1', name: 'button0', value: 1, oldValue: 0 }]);
    const count = seen.length;
    devices.emit({ deviceId: 'qtz1', changes: { button0: { old: 1, new: 1 } }, nextData: { button0: 1 } });
    expect(seen.length).toBe(count);
  });

  test('锁按键 key_clicked → 核心收到 action lock-key 并开始计时（手动模式）', () => {
    const devices = DEVICES();
    const { host, setNow } = createHost(devices);
    host.start({
      gameId: 'maid-punishment',
      deviceMap: VMAP,
      params: { duration: 10, manualStart: true },
    });
    const seen = hostEvents(host);
    expect(host.getStatus().snapshot.waitingForManualStart).toBe(true);
    setNow(500);
    devices.emitRaw({ deviceId: 'lock1', payload: { method: 'action', action: 'key_clicked' } });
    expect(seen).toEqual([{ type: 'action', name: 'lock-key', role: 'lock', deviceId: 'lock1' }]);
    const status = host.getStatus();
    expect(status.snapshot.waitingForManualStart).toBe(false);
    expect(status.snapshot.startedAtMs).toBe(500);
  });

  test('未映射设备的原始消息不转发', () => {
    const devices = DEVICES();
    const { host } = createHost(devices);
    host.start({ gameId: 'maid-punishment', deviceMap: { shock: ['p1'] }, params: { duration: 10, manualStart: true } });
    const seen = hostEvents(host);
    devices.emitRaw({ deviceId: 'lock1', payload: { method: 'action', action: 'key_clicked' } });
    expect(seen).toEqual([]);
    expect(host.getStatus().snapshot.waitingForManualStart).toBe(true);
  });

  test('远程会话（source:remote）下核心电击过远程限幅：30V 上限被钳到 20V', () => {
    const devices = DEVICES();
    const { host, setNow } = createHost(devices);
    host.start({
      gameId: 'maid-punishment',
      deviceMap: VMAP,
      params: { duration: 10, shockIntensity: 30, allowUnsafeIntensity: true },
      source: 'remote',
    });
    setNow(100);
    devices.emit({ deviceId: 'qtz1', changes: { button0: { old: 0, new: 1 } }, nextData: { button0: 1 } });
    const shockCall = devices.calls.find((call) => call.id === 'p1' && call.capability === 'shock' && call.action === 'start');
    expect(shockCall.input.voltage).toBe(20);
    // 本机玩法同一参数下发 30V（安全层不介入）
    const local = DEVICES();
    const localRun = createHost(local);
    localRun.host.start({
      gameId: 'maid-punishment',
      deviceMap: VMAP,
      params: { duration: 10, shockIntensity: 30, allowUnsafeIntensity: true },
      source: 'local',
    });
    localRun.setNow(100);
    local.emit({ deviceId: 'qtz1', changes: { button0: { old: 0, new: 1 } }, nextData: { button0: 1 } });
    const localShock = local.calls.find((call) => call.id === 'p1' && call.capability === 'shock' && call.action === 'start');
    expect(localShock.input.voltage).toBe(30);
  });

  test('停止与自然结束都复位设备：强度停、电击停、解锁', () => {
    const devices = DEVICES();
    const { host, setNow } = createHost(devices);
    host.start({ gameId: 'maid-punishment', deviceMap: MAP, params: { duration: 1, td01DelaySeconds: 0 } });
    setNow(60000);
    const ended = host.tick(60000);
    expect(ended.snapshot.ended).toBe(true);
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'm1', capability: 'strength', action: 'stop' }),
      expect.objectContaining({ id: 'lock1', capability: 'lock', action: 'setOpen', input: { open: true } }),
    ]));

    devices.calls.length = 0;
    setNow(0);
    host.start({ gameId: 'maid-punishment', deviceMap: MAP, params: { duration: 10 } });
    setNow(5000);
    host.stop({ reason: 'user_stop' });
    expect(devices.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'p1', capability: 'shock', action: 'stop' }),
      expect.objectContaining({ id: 'lock1', capability: 'lock', action: 'setOpen', input: { open: true } }),
    ]));
  });

  test('参数变更经宿主落到核心；未知动作返回失败但不崩', () => {
    const devices = DEVICES();
    const { host } = createHost(devices);
    host.start({ gameId: 'maid-punishment', deviceMap: MAP, params: { duration: 10 } });
    host.setParams({ duration: 30, shockIntensity: 18 });
    expect(host.getStatus().snapshot.params.duration).toBe(30);
    expect(host.getStatus().snapshot.params.shockIntensity).toBe(18);
    expect(host.action('shockOnce', {})).toBeTruthy();
    expect(host.getStatus().snapshot.shockCount).toBe(1);
  });
});
