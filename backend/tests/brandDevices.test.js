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
  test('BLE 帧构造（YSKJ_*_BLE 数值范围与通道语义）', () => {
    expect(hex(ycy.buildEmsStrength({ channel: 'A', value: 100 }))).toBe('AA010164006655');
    expect(hex(ycy.buildEmsStop())).toBe('AA030000000355');
    expect(hex(ycy.buildToySpeed({ motor: 'A', speed: 10 }))).toBe('AA11010A001C55');
    expect(hex(ycy.buildToyMode({ motor: 'B', mode: 2 }))).toBe('AA120202001655');
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
    expect(hex(ycy.toBleFrame({ brand: 'ycy', cmd: 'setStrength', channel: 'A', value: 50 })))
      .toBe(hex(ycy.buildEmsStrength({ channel: 'A', value: 50 })));
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

  test('YCY_EMS shock.start → setStrength channel A', () => {
    const m = emit('YCY_EMS', 'shock', 'start', { voltage: 30 });
    expect(m).toMatchObject({ brand: 'ycy', cmd: 'setStrength', channel: 'A', value: 30 });
  });

  test('YCY_EMS strength.set → setStrength channel B', () => {
    const m = emit('YCY_EMS', 'strength', 'set', { value: 70 });
    expect(m).toMatchObject({ brand: 'ycy', cmd: 'setStrength', channel: 'B', value: 70 });
  });

  test('YCY_TOY strength.set → setSpeed（0-100 映射到 0-20）', () => {
    const m = emit('YCY_TOY', 'strength', 'set', { value: 50 });
    expect(m).toMatchObject({ brand: 'ycy', cmd: 'setSpeed', motor: 'A', speed: 10 });
  });

  test('YCY_TOY strength.stop → stopToy', () => {
    expect(emit('YCY_TOY', 'strength', 'stop', {})).toEqual({ brand: 'ycy', cmd: 'stopToy' });
  });

  test('品牌设备类型已注册', () => {
    expect(registry.isValidDeviceType('DGLAB')).toBe(true);
    expect(registry.isValidDeviceType('YCY_EMS')).toBe(true);
    expect(registry.isValidDeviceType('YCY_TOY')).toBe(true);
  });
});
