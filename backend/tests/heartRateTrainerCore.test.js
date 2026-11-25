'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { HeartRateTrainerCore, PARAMS } = require('../games/heart-rate-trainer/game-core');
const coreResolver = require('../game-runtime/gameCoreResolver');
const { GameHostService } = require('../game-runtime/gameHostService');

const GAME_DIR = path.resolve(__dirname, '..', 'games', 'heart-rate-trainer');

function extractManifest() {
  const html = fs.readFileSync(path.join(GAME_DIR, 'index.html'), 'utf8');
  const match = html.match(/<script[^>]*id="game-manifest"[^>]*>([\s\S]*?)<\/script>/);
  expect(match).not.toBeNull();
  return JSON.parse(match[1]);
}

function hrmProp(name, value, extra = {}) {
  return {
    type: 'device-property',
    role: 'hrm',
    deviceId: 'hrm-1',
    name,
    value,
    ...extra,
  };
}

describe('heart-rate-trainer manifest、i18n 与解析器契约', () => {
  test('manifest 与核心 PARAMS 完全对齐，且遵循不隐藏参数规范', () => {
    const manifest = extractManifest();
    expect(manifest.id).toBe('heart-rate-trainer');
    expect(manifest.runtime).toBe('host');
    expect(manifest.core).toBe('game-core.js');
    expect(manifest.events).toBe('v2');

    expect(manifest.params.map((p) => p.key)).toEqual(PARAMS.map((p) => p.key));
    for (const p of manifest.params) {
      expect(p.hidden).toBeUndefined();
      const spec = PARAMS.find((s) => s.key === p.key);
      expect(p.default).toEqual(spec.default);
    }

    // 英文 i18n 覆盖全部设备与参数
    const en = manifest.i18n?.en;
    expect(en).toBeDefined();
    expect(en.title).toMatch(/Heart Rate/i);
    for (const dev of manifest.devices) {
      expect(typeof en.devices[dev.id]).toBe('string');
    }
    for (const p of manifest.params) {
      expect(typeof en.params[p.key]).toBe('string');
      expect(typeof en.paramDescriptions[p.key]).toBe('string');
    }
  });

  test('GameCoreResolver 发现并实例化包内核心', () => {
    expect(coreResolver.isHostGame('heart-rate-trainer')).toBe(true);
    const core = coreResolver.createCore('heart-rate-trainer', {
      params: { minHeartRate: 135, shockVoltage: 20 },
    });
    const snap = core.snapshot();
    expect(snap.gameId).toBe('heart-rate-trainer');
    expect(snap.minHeartRate).toBe(135);
    expect(snap.nextShockVoltage).toBe(20);
  });

  test('页内 i18n.js 注册英文翻译词条', () => {
    const gameI18nPath = path.resolve(__dirname, '..', 'public', 'game-i18n.js');
    const pageI18nPath = path.join(GAME_DIR, 'i18n.js');
    const ctx = {
      DeviceAPI: { locale: 'en' },
      location: { search: '' },
      URLSearchParams,
      document: { documentElement: { lang: '' }, querySelector: () => null, querySelectorAll: () => [] },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(gameI18nPath, 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(pageI18nPath, 'utf8'), ctx);
    expect(ctx.GameI18n.t('低心率电击提醒中（{v}V）', { v: 18 })).toBe('Shock reminder active (18V)');
    expect(ctx.GameI18n.t('电击冷却恢复期（{n}s）', { n: 12 })).toBe('Cooldown recovery (12s)');
  });
});

describe('heart-rate-trainer 核心状态机：热身、预警、电击与冷却期', () => {
  test('热身缓冲期内低心率不触发电击，可手动跳过热身', () => {
    const core = new HeartRateTrainerCore({
      params: {
        duration: 10,
        minHeartRate: 130,
        warmupSeconds: 30,
        belowThresholdGraceSeconds: 3,
        shockVoltage: 18,
      },
    });
    const started = core.start(1000);
    expect(started.ok).toBe(true);
    expect(started.snapshot.phase).toBe('WARMUP');
    expect(started.effects).toEqual([{ type: 'device.lock', role: 'lock', open: false }]);

    // 热身期上报 95 bpm（低于 130），满 10 秒也不电击
    core.step({ nowMs: 2000, events: [hrmProp('heart_rate', 95), hrmProp('hr_status', 'ok')] });
    const midWarmup = core.step({ nowMs: 15000, events: [] });
    expect(midWarmup.snapshot.phase).toBe('WARMUP');
    expect(midWarmup.snapshot.shockCount).toBe(0);
    expect(midWarmup.effects).toEqual([]);

    // 跳过热身 -> 立即进入低心率预警
    const skipped = core.action('skipWarmup', {}, 16000);
    expect(skipped.snapshot.phase).toBe('WARNING');
    expect(skipped.effects).toEqual([{ type: 'device.set-strength', role: 'motor', value: 80 }]);

    // 容忍期满 3 秒 -> 触发电击并停震动
    const shocked = core.step({ nowMs: 19000, events: [] });
    expect(shocked.snapshot.phase).toBe('SHOCKING');
    expect(shocked.snapshot.isShocking).toBe(true);
    expect(shocked.snapshot.shockCount).toBe(1);
    expect(shocked.effects).toEqual([
      { type: 'device.stop-strength', role: 'motor' },
      { type: 'device.shock', role: 'shock', voltage: 18, durationMs: 2000 },
    ]);
  });

  test('低心率容忍期内把心率拉回下限以上时，取消预警且不电击', () => {
    const core = new HeartRateTrainerCore({
      params: {
        duration: 5,
        minHeartRate: 125,
        warmupSeconds: 0,
        belowThresholdGraceSeconds: 5,
        warningMotorIntensity: 100,
      },
    });
    core.start(0);
    const low = core.step({ nowMs: 1000, events: [hrmProp('heart_rate', 110)] });
    expect(low.snapshot.phase).toBe('WARNING');
    expect(low.effects).toEqual([{ type: 'device.set-strength', role: 'motor', value: 100 }]);

    // 3 秒后（未满 5s）心率升至 132 bpm -> 停止震动，回到 ACTIVE_OK
    const recovered = core.step({ nowMs: 4000, events: [hrmProp('heart_rate', 132)] });
    expect(recovered.snapshot.phase).toBe('ACTIVE_OK');
    expect(recovered.snapshot.shockCount).toBe(0);
    expect(recovered.effects).toEqual([{ type: 'device.stop-strength', role: 'motor' }]);
  });

  test('电击结束后进入冷却期：冷却期内即使心率仍低也不重复电击，冷却期后重新评估', () => {
    const core = new HeartRateTrainerCore({
      params: {
        duration: 10,
        minHeartRate: 130,
        warmupSeconds: 0,
        belowThresholdGraceSeconds: 2,
        shockVoltage: 20,
        shockDurationSeconds: 2,
        cooldownSeconds: 10,
        warningMotorIntensity: 0,
      },
    });
    core.start(0);
    core.step({ nowMs: 1000, events: [hrmProp('heart_rate', 100)] });

    // t=3000 容忍期届满，开始 2s 电击（shockUntil=5000, cooldownUntil=15000）
    const s1 = core.step({ nowMs: 3000, events: [] });
    expect(s1.snapshot.phase).toBe('SHOCKING');
    expect(s1.snapshot.shockCount).toBe(1);

    // t=5000 电击结束，发 shock-stop，转入 10s COOLDOWN
    const coolStart = core.step({ nowMs: 5000, events: [] });
    expect(coolStart.snapshot.phase).toBe('COOLDOWN');
    expect(coolStart.snapshot.isShocking).toBe(false);
    expect(coolStart.snapshot.cooldownRemainingSec).toBe(10);
    expect(coolStart.effects).toEqual([{ type: 'device.shock-stop', role: 'shock' }]);

    // t=12000 仍在冷却期内，心率 95 bpm 不得触发电击
    const midCool = core.step({ nowMs: 12000, events: [hrmProp('heart_rate', 95)] });
    expect(midCool.snapshot.phase).toBe('COOLDOWN');
    expect(midCool.snapshot.shockCount).toBe(1);
    expect(midCool.effects).toEqual([]);

    // t=15000 冷却期结束，进入新一轮 2s WARNING
    const afterCool = core.step({ nowMs: 15000, events: [] });
    expect(afterCool.snapshot.phase).toBe('WARNING');
    expect(afterCool.snapshot.shockCount).toBe(1);

    // t=17000 再次触发第二次电击
    const s2 = core.step({ nowMs: 17000, events: [] });
    expect(s2.snapshot.phase).toBe('SHOCKING');
    expect(s2.snapshot.shockCount).toBe(2);
  });

  test('渐进电击递增、30V 安全上限与连续达标 3s 重置', () => {
    const core = new HeartRateTrainerCore({
      params: {
        duration: 10,
        minHeartRate: 120,
        warmupSeconds: 0,
        belowThresholdGraceSeconds: 0,
        shockVoltage: 26,
        shockDurationSeconds: 1,
        cooldownSeconds: 2,
        progressiveShock: true,
        progressiveStepVoltage: 5,
        maxShockVoltage: 50,
        allowUnsafeVoltage: false,
      },
    });
    core.start(0);

    // 第 1 次电击：26V
    const r1 = core.step({ nowMs: 1000, events: [hrmProp('heart_rate', 90)] });
    expect(r1.effects).toContainEqual({ type: 'device.shock', role: 'shock', voltage: 26, durationMs: 1000 });

    // 电击结束(2000) + 冷却结束(4000) -> 第 2 次电击：26+5=31V，受 allowUnsafeVoltage=false 钳制在 30V
    core.step({ nowMs: 2000, events: [] });
    const r2 = core.step({ nowMs: 4000, events: [] });
    expect(r2.effects).toContainEqual({ type: 'device.shock', role: 'shock', voltage: 30, durationMs: 1000 });

    // 开启 allowUnsafeVoltage 后，下次电击变为 26 + 2*5 = 36V
    core.setParams({ allowUnsafeVoltage: true });
    expect(core.snapshot().nextShockVoltage).toBe(36);

    // 电击结束(5000) + 冷却期恢复到 135 bpm 并稳定保持满 3s -> 连续电击计数归零，回落 26V
    core.step({ nowMs: 5000, events: [hrmProp('heart_rate', 135)] });
    core.step({ nowMs: 7000, events: [] });
    const resetSnap = core.step({ nowMs: 8500, events: [] }).snapshot;
    expect(resetSnap.consecutiveShocks).toBe(0);
    expect(resetSnap.nextShockVoltage).toBe(26);
  });
});

describe('heart-rate-trainer 传感器状态、角色隔离与暂停恢复', () => {
  test('仅读取 hrm 角色属性，其它设备的 battery 不覆盖心率带电量', () => {
    const core = new HeartRateTrainerCore({ params: { warmupSeconds: 0 } });
    core.start(0);
    core.step({
      nowMs: 1000,
      events: [
        hrmProp('heart_rate', 128),
        hrmProp('battery', 92),
        { type: 'device-property', role: 'shock', deviceId: 'shock-1', name: 'battery', value: 15 },
      ],
    });
    expect(core.snapshot().battery).toBe(92);
    expect(core.snapshot().heartRate).toBe(128);
  });

  test('心率带脱落（no_contact / stale / disconnected）立即停电且绝不误触发电击，支持 auto_pause', () => {
    const core = new HeartRateTrainerCore({
      params: {
        warmupSeconds: 0,
        minHeartRate: 120,
        belowThresholdGraceSeconds: 0,
        sensorLossPolicy: 'auto_pause',
        sensorLossGraceSeconds: 5,
        shockVoltage: 15,
        shockDurationSeconds: 4,
      },
    });
    core.start(0);
    // 先产生低心率进入电击中
    const s1 = core.step({ nowMs: 1000, events: [hrmProp('heart_rate', 95), hrmProp('hr_status', 'ok'), hrmProp('hr_contact', 1)] });
    expect(s1.snapshot.isShocking).toBe(true);
    expect(s1.snapshot.shockCount).toBe(1);

    // 电击中途脱落：hr_status = no_contact, hr_contact = 0 -> 必须立即发 shock-stop
    const lost = core.step({
      nowMs: 2000,
      events: [hrmProp('heart_rate', 0), hrmProp('hr_status', 'no_contact'), hrmProp('hr_contact', 0)],
    });
    expect(lost.snapshot.isShocking).toBe(false);
    expect(lost.effects).toContainEqual({ type: 'device.shock-stop', role: 'shock' });

    // 单条正 BPM（未恢复 hr_status='ok' 和 hr_contact=1）不得覆盖脱落状态
    const strayBpm = core.step({ nowMs: 3000, events: [hrmProp('heart_rate', 88)] });
    expect(strayBpm.snapshot.sensorConnected).toBe(false);
    expect(strayBpm.snapshot.heartRate).toBeNull();
    expect(strayBpm.effects).toEqual([]);

    // 仅恢复接触状态而无新心率帧时，绝不复活脱落前的旧 BPM
    const contactOnly = core.step({
      nowMs: 4000,
      events: [hrmProp('hr_contact', 1), hrmProp('hr_status', 'ok')],
    });
    expect(contactOnly.snapshot.sensorConnected).toBe(false);
    expect(contactOnly.snapshot.heartRate).toBeNull();
    expect(contactOnly.effects).toEqual([]);

    // 冷却结束后若仍处于信号丢失且超过宽限期 -> auto_pause 自动暂停训练并解锁，不电击
    core.step({ nowMs: 18000, events: [] });
    const autoPaused = core.step({ nowMs: 24000, events: [] });
    expect(autoPaused.snapshot.paused).toBe(true);
    expect(autoPaused.snapshot.phase).toBe('PAUSED');
    expect(autoPaused.snapshot.isLocked).toBe(false);
    expect(autoPaused.snapshot.shockCount).toBe(1);
    expect(autoPaused.effects).toEqual([
      { type: 'device.shock-stop', role: 'shock' },
      { type: 'device.lock', role: 'lock', open: true },
    ]);
  });

  test('安全边界：禁用手动电击、多 HRM 防串扰、宿主迟到不吞冷却、运行中收紧电压立即停电', () => {
    const core = new HeartRateTrainerCore({
      params: {
        warmupSeconds: 0,
        minHeartRate: 130,
        belowThresholdGraceSeconds: 0,
        shockVoltage: 45,
        maxShockVoltage: 25,
        progressiveShock: true,
        allowUnsafeVoltage: true,
        shockDurationSeconds: 2,
        cooldownSeconds: 10,
      },
    });
    core.start(1000);

    // 训练中拒绝手动电击动作
    const manual = core.action('shockOnce', {}, 1200);
    expect(manual.ok).toBe(false);
    expect(manual.effects).toEqual([]);

    // 多条 HRM 设备防串扰：首条绑定 hrm-1 后忽略 hrm-2
    core.step({
      nowMs: 1500,
      events: [
        hrmProp('heart_rate', 140, { deviceId: 'hrm-1' }),
        hrmProp('heart_rate', 70, { deviceId: 'hrm-2' }),
      ],
    });
    expect(core.snapshot().heartRate).toBe(140);
    expect(core.snapshot().phase).toBe('ACTIVE_OK');

    // progressiveShock=true 时 maxShockVoltage(25V) 作为真实上限钳制基础 45V
    const s1 = core.step({ nowMs: 2000, events: [hrmProp('heart_rate', 90, { deviceId: 'hrm-1' })] });
    expect(s1.effects).toContainEqual({ type: 'device.shock', role: 'shock', voltage: 25, durationMs: 2000 });

    // 运行中将 maxShockVoltage 收紧到 18V -> 正在进行的 25V 电击必须立即终止
    const tightened = core.setParams({ maxShockVoltage: 18 });
    expect(tightened.snapshot.isShocking).toBe(false);
    expect(tightened.effects).toContainEqual({ type: 'device.shock-stop', role: 'shock' });

    // 冷却结束触发第二次电击（18V），随后模拟宿主卡顿跨过电击结束+原冷却截止（t=30000）
    const s2 = core.step({ nowMs: 13000, events: [] });
    expect(s2.snapshot.isShocking).toBe(true);
    const delayedTick = core.step({ nowMs: 30000, events: [] });
    expect(delayedTick.effects).toEqual([{ type: 'device.shock-stop', role: 'shock' }]);
    expect(delayedTick.snapshot.phase).toBe('COOLDOWN');
    expect(delayedTick.snapshot.cooldownRemainingSec).toBe(10);
  });

  test('暂停中断当前电击并顺延计时，动态改短时长可立即正常完赛', () => {
    const core = new HeartRateTrainerCore({
      params: { duration: 5, warmupSeconds: 0, belowThresholdGraceSeconds: 0, cooldownSeconds: 10 },
    });
    core.start(1000);
    const shocking = core.step({ nowMs: 2000, events: [hrmProp('heart_rate', 90)] });
    expect(shocking.snapshot.isShocking).toBe(true);

    // 电击中途暂停：立即发 shock-stop 并开锁
    const paused = core.pause(2500);
    expect(paused.snapshot.paused).toBe(true);
    expect(paused.snapshot.isShocking).toBe(false);
    expect(paused.snapshot.isLocked).toBe(false);
    expect(paused.effects).toContainEqual({ type: 'device.shock-stop', role: 'shock' });
    expect(paused.effects).toContainEqual({ type: 'device.lock', role: 'lock', open: true });

    // 暂停 10 秒后恢复：结束时刻顺延 10s，重新上锁，且处于冷却保护期不会刚恢复就再电
    const resumed = core.resume(12500);
    expect(resumed.snapshot.endTimeMs).toBe(1000 + 5 * 60000 + 10000);
    expect(resumed.snapshot.isLocked).toBe(true);
    expect(resumed.effects).toContainEqual({ type: 'device.lock', role: 'lock', open: false });
    expect(resumed.snapshot.phase).toBe('COOLDOWN');

    // 前进到 75000ms（实际已运动 >1 分钟），将总时长改短为 1 分钟 -> 立即完赛并解锁
    core.step({ nowMs: 75000, events: [hrmProp('heart_rate', 135)] });
    const finished = core.setParams({ duration: 1 });
    expect(finished.snapshot.ended).toBe(true);
    expect(finished.snapshot.endReason).toBe('duration');
    expect(finished.effects).toEqual([
      { type: 'device.lock', role: 'lock', open: true },
      { type: 'device.stop-all' },
    ]);
  });
});

describe('heart-rate-trainer 宿主后台托管集成测试（GameHostService）', () => {
  test('脱离页面由宿主独立驱动：开局补发心率种子、低心率电击、定时自动停电与完赛复位', () => {
    let clock = 10000;
    const timers = [];
    let nextId = 1;
    const dataListeners = [];
    const invocations = [];

    const mockDevices = {
      'hrm-ble': { id: 'hrm-ble', type: 'HRM', connected: true, data: { heart_rate: 132, hr_status: 'ok', battery: 88 } },
      'shock-1': { id: 'shock-1', type: 'DIANJI', connected: true, data: { shock: 0, voltage: 0 } },
      'lock-1': { id: 'lock-1', type: 'ZIDONGSUO', connected: true, data: { open: 1 } },
    };

    const devicesSvc = {
      getDeviceById: (id) => mockDevices[id] || null,
      invokeDeviceCapability: (id, cap, action, input) => {
        invocations.push({ at: clock, id, cap, action, input });
      },
      onDeviceDataChange: (fn) => dataListeners.push(fn),
      onDeviceRawMessage: () => {},
    };

    const host = new GameHostService({
      devices: devicesSvc,
      virtualDevices: { isVirtualDevice: () => false },
      now: () => clock,
      setTimer: (fn, ms) => {
        const entry = { id: nextId++, at: clock + ms, fn, cleared: false };
        timers.push(entry);
        return entry.id;
      },
      clearTimer: (id) => {
        const found = timers.find((t) => t.id === id);
        if (found) found.cleared = true;
      },
      setRepeating: () => 999,
      clearRepeating: () => {},
    });

    const started = host.start({
      gameId: 'heart-rate-trainer',
      deviceMap: { hrm: ['hrm-ble'], shock: ['shock-1'], lock: ['lock-1'] },
      params: {
        duration: 1,
        minHeartRate: 120,
        warmupSeconds: 0,
        belowThresholdGraceSeconds: 2,
        shockVoltage: 16,
        shockDurationSeconds: 1.5,
        cooldownSeconds: 10,
      },
    });

    // 开局自动上锁，且 _seedSensor 已补发初始 132 bpm
    expect(started.runtimeMode).toBe('host');
    expect(host.getStatus().snapshot.heartRate).toBe(132);
    expect(host.getStatus().snapshot.phase).toBe('ACTIVE_OK');
    expect(invocations).toContainEqual({
      at: 10000,
      id: 'lock-1',
      cap: 'lock',
      action: 'setOpen',
      input: { open: false },
    });

    // 心率跌至 105 bpm -> 进入 WARNING
    clock = 12000;
    mockDevices['hrm-ble'].data.heart_rate = 105;
    dataListeners.forEach((fn) => fn({ deviceId: 'hrm-ble', changes: { heart_rate: { old: 132, new: 105 } } }));
    expect(host.getStatus().snapshot.phase).toBe('WARNING');

    // 2 秒后台 tick 到点 -> 触发 16V 电击并挂载 1500ms 宿主自动停电定时器
    clock = 14000;
    host.tick(clock);
    expect(host.getStatus().snapshot.isShocking).toBe(true);
    expect(invocations).toContainEqual({
      at: 14000,
      id: 'shock-1',
      cap: 'shock',
      action: 'start',
      input: { voltage: 16 },
    });

    // 1500ms 后宿主 shockTimer 与核心同时停电
    clock = 15500;
    timers.filter((t) => !t.cleared && t.at <= clock).forEach((t) => { t.cleared = true; t.fn(); });
    host.tick(clock);
    expect(host.getStatus().snapshot.phase).toBe('COOLDOWN');
    expect(invocations.some((c) => c.id === 'shock-1' && c.cap === 'shock' && c.action === 'stop')).toBe(true);

    // 运动满 1 分钟（clock = 70000）-> 自动完赛、开锁并安全停机
    clock = 70000;
    const endStatus = host.tick(clock);
    expect(endStatus.active).toBe(false);
    expect(endStatus.ended).toBe(true);
    expect(endStatus.snapshot.endReason).toBe('duration');
    expect(invocations).toContainEqual({
      at: 70000,
      id: 'lock-1',
      cap: 'lock',
      action: 'setOpen',
      input: { open: true },
    });
  });

  test('无显式 ok 状态的开局 seed 不得触发电击，且心率带断连时宿主立即推送 disconnected 停电', () => {
    let clock = 5000;
    const invocations = [];
    const mockDevices = {
      'hrm-cached': { id: 'hrm-cached', type: 'HRM', connected: true, data: { heart_rate: 80 } },
      'hrm-extra': { id: 'hrm-extra', type: 'HRM', connected: true, data: { heart_rate: 150, hr_status: 'ok' } },
      'shock-1': { id: 'shock-1', type: 'DIANJI', connected: true, data: { shock: 0, voltage: 0 } },
    };
    const dataListeners = [];
    const host = new GameHostService({
      devices: {
        getDeviceById: (id) => mockDevices[id] || null,
        invokeDeviceCapability: (id, cap, action, input) => invocations.push({ at: clock, id, cap, action, input }),
        onDeviceDataChange: (fn) => dataListeners.push(fn),
        onDeviceRawMessage: () => {},
      },
      virtualDevices: { isVirtualDevice: () => false },
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => {},
      setRepeating: () => 2,
      clearRepeating: () => {},
    });

    const started = host.start({
      gameId: 'heart-rate-trainer',
      deviceMap: { hrm: ['hrm-cached', 'hrm-extra'], shock: ['shock-1'] },
      params: { warmupSeconds: 0, minHeartRate: 120, belowThresholdGraceSeconds: 0, shockDurationSeconds: 5 },
    });

    // maxDevices: 1 截断多余 HRM，且无 hr_status='ok' 的缓存 seed 仅保留展示，绝不开局即电击
    expect(started.deviceMap.hrm).toEqual(['hrm-cached']);
    expect(host.getStatus().snapshot.lastValidHeartRate).toBe(80);
    expect(host.getStatus().snapshot.heartRate).toBeNull();
    expect(host.getStatus().snapshot.isShocking).toBe(false);

    // 收到实时低心率帧 -> 进入电击
    clock = 6000;
    mockDevices['hrm-cached'].data.heart_rate = 95;
    mockDevices['hrm-cached'].data.hr_status = 'ok';
    dataListeners.forEach((fn) => fn({ deviceId: 'hrm-cached', changes: { heart_rate: { old: 80, new: 95 }, hr_status: { old: undefined, new: 'ok' } } }));
    expect(host.getStatus().snapshot.isShocking).toBe(true);

    // 心率带物理断连 -> 下一次 tick 宿主推送 disconnected，核心立即停电
    clock = 6500;
    mockDevices['hrm-cached'].connected = false;
    host.tick(clock);
    expect(host.getStatus().snapshot.isShocking).toBe(false);
    expect(host.getStatus().snapshot.hrStatus).toBe('disconnected');
    expect(invocations.some((c) => c.id === 'shock-1' && c.cap === 'shock' && c.action === 'stop')).toBe(true);
  });
});
