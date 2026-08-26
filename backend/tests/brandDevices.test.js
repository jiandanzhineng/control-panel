/**
 * 品牌设备测试：协议构造、连接适配器翻译、设备类型层集成。
 * 仅依赖纯模块（不引入 ws / noble / express），可在 npm install 后由 jest 运行。
 */
const dglab = require('../brands/protocols/dglab');
const ycy = require('../brands/protocols/ycy');
const { DGLabConnection } = require('../brands/dglabConnection');
const { YCYConnection } = require('../brands/ycyConnection');
const registry = require('../devices/registry');

// 模拟 WebSocket：立即 open，记录发送内容
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    MockWebSocket.last = this;
    setImmediate(() => { this.readyState = 1; this.onopen && this.onopen(); });
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose && this.onclose(); }
  ping() {}
}

const hex = (b) => b.toString('hex').toUpperCase();
const { mergeFjbState, toFjbStroke, scale255 } = require('../brands/capabilityMap');

describe('能力换算', () => {
  test('0-255 映射设备量程，strength 只正转', () => {
    expect(scale255(0, 20)).toBe(0);
    expect(scale255(255, 20)).toBe(20);
    expect(toFjbStroke({ value: 255, direction: 1 })).toBe(20);
    expect(toFjbStroke({ value: 255, direction: -1 })).toBe(40);
  });

  test('motors 未写的轴保持', () => {
    const next = mergeFjbState({ stroke: 10, vibe: 5, axis: 2 }, { vibe: { value: 255 } });
    expect(next).toEqual({ stroke: 10, vibe: 20, axis: 2 });
  });

  test('YCYConnection 把 setMotors 合成 setFjb', () => {
    const conn = new YCYConnection({ deviceId: 'x', mode: 'bridge' });
    const n = conn._normalize({
      brand: 'ycy', cmd: 'setMotors',
      channels: { stroke: { value: 255, direction: -1 } },
    });
    expect(n).toMatchObject({ cmd: 'setFjb', stroke: 40, vibe: 0, axis: 0 });
  });
});

describe('郊狼 DGLab 协议', () => {
  test('构造 set_pattern / stop_pattern / change_max_intensity', () => {
    expect(dglab.buildSetPattern({ pattern: '经典', intensity: 80, ticks: -1 }))
      .toEqual({ cmd: 'set_pattern', pattern_name: '经典', intensity: 80, ticks: -1 });
    expect(dglab.buildStopPattern()).toEqual({ cmd: 'stop_pattern' });
    expect(dglab.buildChangeMaxIntensity({ delta: 10 }))
      .toEqual({ cmd: 'change_max_intensity', delta_intensity: 10 });
  });

  test('连接适配器将品牌命令翻译为 App 帧', async () => {
    const conn = new DGLabConnection({ deviceId: 'dglab-1', host: '127.0.0.1', port: 60536, WebSocketClass: MockWebSocket });
    await conn.connect();
    conn.send({ brand: 'dglab', cmd: 'setPattern', pattern: '经典', intensity: 80, ticks: -1 });
    expect(JSON.parse(MockWebSocket.last.sent[0]))
      .toEqual({ cmd: 'set_pattern', pattern_name: '经典', intensity: 80, ticks: -1 });
    conn.disconnect();
  });
});

describe('役次元 YCY 协议', () => {
  test('BLE 帧构造（权威 0x35 族，对齐官方开源 + PyDGLab-WS-for-YCY）', () => {
    // 电刺激握手（APK 提取，无校验和）
    expect(hex(ycy.buildEmsHandshake())).toBe('351401');
    // 电刺激停止：关闭 AB 双通道（35 11 03 00 00 00 01 00 00 + 校验和 4A）
    expect(hex(ycy.buildEmsStop())).toBe('3511030000000100004A');
    // 玩具电机停止 / 速度 10（35 12 + 1B + 校验和）
    expect(hex(ycy.buildMotor({ speed: 0 }))).toBe('35120047');
    expect(hex(ycy.buildMotor({ speed: 10 }))).toBe('35120A51');
    // 通道控制（A 通道，强度 50→映射为设备量纲；35 11 01 01 .. .. 01 00 00 + 校验和）
    const ch = ycy.buildEmsStrength({ channel: 'A', value: 50 });
    expect(ch[0]).toBe(0x35);
    expect(ch[1]).toBe(0x11);
    expect(ch[2]).toBe(0x01); // 通道 A
    expect(ch[3]).toBe(0x01); // 开启
    // 强度应为 1–276 之间（value 50 → 约 139）
    const strength = (ch[4] << 8) | ch[5];
    expect(strength).toBeGreaterThanOrEqual(1);
    expect(strength).toBeLessThanOrEqual(276);
    // 末字节为校验和
    expect(ch[ch.length - 1]).toBe(ycy.checksum ? ycy.checksum(ch.slice(0, -1)) : (Buffer.from(ch).reduce((s, b) => (s + b) & 0xff, 0) - ch[ch.length - 1] + ch[ch.length - 1]) & 0xff);
    // pump_v3 停止（明文 35 12 00 00 00 + 校验和 47）
    expect(hex(ycy.buildPumpV3({ scene: 'stop' }))).toBe('351200000047');
    // YCY-FJB-03：6 字节 35 12 旋转 震动 轴 校验（真机对拍）
    expect(hex(ycy.buildFjb03({ stroke: 15, vibe: 0, axis: 0 }))).toBe('35120F000056');
    expect(hex(ycy.buildFjb03({ stroke: 0, vibe: 0, axis: 0 }))).toBe('351200000047');
  });

  test('桥接消息构造与连接翻译', async () => {
    expect(ycy.parseConnectCode('game_5 mytoken')).toEqual({ uid: 'game_5', token: 'mytoken' });
    expect(ycy.buildBridgeSendCommand({ commandId: '_stop_all', token: 't1' }))
      .toEqual({ type: 'sendCommand', commandId: '_stop_all', token: 't1' });

    const conn = new YCYConnection({ deviceId: 'ycy-1', mode: 'bridge', WebSocketClass: MockWebSocket });
    await conn.connect({ host: '127.0.0.1', port: 3001, connectCode: 'game_5 mytoken' });
    conn.send({ brand: 'ycy', cmd: 'stopAll' });
    expect(JSON.parse(MockWebSocket.last.sent[MockWebSocket.last.sent.length - 1]))
      .toEqual({ type: 'sendCommand', commandId: '_stop_all', token: 'mytoken' });
    conn.send({ brand: 'ycy', cmd: 'triggerInstruction', commandId: 'player_hurt', token: 'mytoken' });
    expect(JSON.parse(MockWebSocket.last.sent[MockWebSocket.last.sent.length - 1]))
      .toEqual({ type: 'sendCommand', commandId: 'player_hurt', token: 'mytoken' });
    conn.disconnect();
  });

  test('BLE 路径 toBleFrame 与帧构造一致', () => {
    expect(hex(ycy.toBleFrame({ brand: 'ycy', cmd: 'stopAll' }))).toBe(hex(ycy.buildEmsStop()));
    expect(hex(ycy.toBleFrame({ brand: 'ycy', cmd: 'setSpeed', speed: 10 })))
      .toBe(hex(ycy.buildMotor({ speed: 10 })));
    expect(hex(ycy.toBleFrame({ brand: 'ycy', cmd: 'setFjb', stroke: 15 })))
      .toBe('35120F000056');
    expect(hex(ycy.toBleFrame({ brand: 'ycy', cmd: 'stopFjb' }))).toBe('351200000047');
  });

  test('pump v1/v2 加密帧：AES-128-ECB + 16 字节密文', async () => {
    const ct = ycy.buildPumpEncrypted({ protocol: 'v1', scene: 'stop' });
    expect(Buffer.isBuffer(ct)).toBe(true);
    expect(ct.length).toBe(16); // 单块 AES-128 密文
    // 相同输入应得相同密文（确定性，无 IV）
    const ct2 = ycy.buildPumpEncrypted({ protocol: 'v1', scene: 'stop' });
    expect(hex(ct)).toBe(hex(ct2));
    // toBleFrame 同样产出 16 字节密文
    const frame = ycy.toBleFrame({ brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'stop' });
    expect(frame.length).toBe(16);
    // 桥接模式不支持原始泵帧，提示改用 BLE 直连
    const bridgeConn = new YCYConnection({ deviceId: 'ycy-cup', mode: 'bridge', WebSocketClass: MockWebSocket });
    await bridgeConn.connect({ host: '127.0.0.1', port: ycy.BRIDGE_DEFAULT_PORT, connectCode: 'game_5 mytoken' });
    expect(() => bridgeConn.send({ brand: 'ycy', cmd: 'pump', protocol: 'v1', scene: 'stop' }))
      .toThrow(/BLE 直连/);
    bridgeConn.disconnect();
  });
});

describe('设备类型层发出品牌命令（接入 Bridge / 设备映射）', () => {
  const emit = (type, cap, action, params) => {
    let captured = null;
    registry.getDeviceType(type).invokeCapability('devX', cap, action, params, (id, msg) => { captured = msg; return msg; });
    return captured;
  };

  test('DGLAB shock.start → setPattern', () => {
    const m = emit('DGLAB', 'shock', 'start', { voltage: 50 });
    expect(m).toMatchObject({ brand: 'dglab', cmd: 'setPattern', intensity: 50 });
  });

  test('DGLAB shock.stop → stopPattern', () => {
    expect(emit('DGLAB', 'shock', 'stop', {})).toEqual({ brand: 'dglab', cmd: 'stopPattern' });
  });

  test('YCY_EMS shock.start → setStrength channel AB', () => {
    const m = emit('YCY_EMS', 'shock', 'start', { voltage: 30 });
    expect(m).toMatchObject({ brand: 'ycy', cmd: 'setStrength', channel: 'AB', value: 30 });
  });

  test('YCY_EMS estim.set → setEstim', () => {
    const m = emit('YCY_EMS', 'estim', 'set', { channel: 'a', intensity: 128, wave: '3' });
    expect(m).toMatchObject({ brand: 'ycy', cmd: 'setEstim', channel: 'A', intensity: 128, wave: '3' });
  });

  test('YCY_TOY strength.set → setMotors a', () => {
    const m = emit('YCY_TOY', 'strength', 'set', { value: 128 });
    expect(m).toMatchObject({
      brand: 'ycy', cmd: 'setMotors',
      channels: { a: { value: 128, direction: 1 } },
    });
  });

  test('YCY_TOY strength.stop → stopToy', () => {
    expect(emit('YCY_TOY', 'strength', 'stop', {})).toEqual({ brand: 'ycy', cmd: 'stopToy' });
  });

  test('品牌设备类型已注册', () => {
    expect(registry.isValidDeviceType('DGLAB')).toBe(true);
    expect(registry.isValidDeviceType('YCY_EMS')).toBe(true);
    expect(registry.isValidDeviceType('YCY_TOY')).toBe(true);
    expect(registry.isValidDeviceType('YCY_CUP')).toBe(true);
    expect(registry.isValidDeviceType('YCY_ENEMA')).toBe(true);
  });

  test('YCY_CUP 触发指令 → triggerInstruction', () => {
    let captured = null;
    registry.getDeviceType('YCY_CUP').invokeOperation('devCup', 'trigger', { commandId: 'cup_on' }, (id, msg) => { captured = msg; return msg; });
    expect(captured).toEqual({ brand: 'ycy', cmd: 'triggerInstruction', commandId: 'cup_on' });
  });

  test('YCY_CUP 触发缺少 commandId 抛错', () => {
    expect(() => registry.getDeviceType('YCY_CUP').invokeOperation('devCup', 'trigger', {}, (id, msg) => msg))
      .toThrow(/commandId/);
  });

  test('YCY_CUP 全部停止 → stopFjb', () => {
    let captured = null;
    registry.getDeviceType('YCY_CUP').invokeOperation('devCup', 'stop', {}, (id, msg) => { captured = msg; return msg; });
    expect(captured).toEqual({ brand: 'ycy', cmd: 'stopFjb' });
  });

  test('YCY_CUP strength.set → setMotors 只改旋转正转', () => {
    const m = emit('YCY_CUP', 'strength', 'set', { value: 128 });
    expect(m).toMatchObject({
      brand: 'ycy', cmd: 'setMotors',
      channels: { stroke: { value: 128, direction: 1 } },
    });
  });

  test('YCY_CUP motors.set 带方向', () => {
    const m = emit('YCY_CUP', 'motors', 'set', {
      channels: { stroke: { value: 128, direction: -1 }, vibe: { value: 64 } },
    });
    expect(m.cmd).toBe('setMotors');
    expect(m.channels.stroke.direction).toBe(-1);
  });

  test('YCY_ENEMA pump.start → pump guan', () => {
    const m = emit('YCY_ENEMA', 'pump', 'start', { scene: 'guan' });
    expect(m).toMatchObject({ brand: 'ycy', cmd: 'pump', scene: 'guan' });
  });

  test('DGLAB 有 shock+estim，无 strength', () => {
    expect(registry.hasCapability('DGLAB', 'shock')).toBe(true);
    expect(registry.hasCapability('DGLAB', 'estim')).toBe(true);
    expect(registry.hasCapability('DGLAB', 'strength')).toBe(false);
  });

  test('YCY_ENEMA 触发指令 → triggerInstruction', () => {
    let captured = null;
    registry.getDeviceType('YCY_ENEMA').invokeOperation('devE', 'trigger', { commandId: 'enema_on' }, (id, msg) => { captured = msg; return msg; });
    expect(captured).toEqual({ brand: 'ycy', cmd: 'triggerInstruction', commandId: 'enema_on' });
  });

  test('YCY_ENEMA 全部停止 → stopAll', () => {
    let captured = null;
    registry.getDeviceType('YCY_ENEMA').invokeOperation('devE', 'stop', {}, (id, msg) => { captured = msg; return msg; });
    expect(captured).toEqual({ brand: 'ycy', cmd: 'stopAll' });
  });
});

describe('役次元 设备类型推断（resolveDeviceType）', () => {
  const { resolveDeviceType } = require('../brands/brandService');

  test('显式 type 覆盖优先（杯 / 灌肠机）', () => {
    expect(resolveDeviceType('ycy', { mode: 'bridge', type: 'YCY_CUP' })).toBe('YCY_CUP');
    expect(resolveDeviceType('ycy', { mode: 'bridge', type: 'YCY_ENEMA' })).toBe('YCY_ENEMA');
  });

  test('bridge 模式按名称细分（杯 / 灌肠机）', () => {
    expect(resolveDeviceType('ycy', { mode: 'bridge', model: '灌肠机' })).toBe('YCY_ENEMA');
    expect(resolveDeviceType('ycy', { mode: 'bridge', model: '智能杯' })).toBe('YCY_CUP');
    expect(resolveDeviceType('ycy', { mode: 'bridge' })).toBe('YCY_EMS');
  });

  test('ble 模式 FJB 归为杯，不再当成玩具电机', () => {
    expect(resolveDeviceType('ycy', { mode: 'ble', model: 'YCY-FJB-03' })).toBe('YCY_CUP');
  });
});
