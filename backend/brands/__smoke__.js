/**
 * 品牌设备逻辑冒烟测试（无需 jest / 外部依赖，可直接 node 运行）。
 * 覆盖：协议帧构造、连接适配器翻译、设备类型层发出品牌命令。
 */
const assert = require('assert');
const dglab = require('./protocols/dglab');
const ycy = require('./protocols/ycy');
const { DGLabConnection } = require('./dglabConnection');
const { YCYConnection } = require('./ycyConnection');
const registry = require('../devices/registry');

// ---- 模拟 WebSocket（立即 open，记录发送内容）----
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

function hex(buf) { return buf.toString('hex').toUpperCase(); }

process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e && e.stack ? e.stack : e); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED REJECTION:', e && e.stack ? e.stack : e); });

async function run() {
  // ===== 1. 郊狼协议构造 =====
  assert.deepStrictEqual(
    dglab.buildSetPattern({ pattern: '经典', intensity: 80, ticks: -1 }),
    { cmd: 'set_pattern', pattern_name: '经典', intensity: 80, ticks: -1 }
  );
  assert.deepStrictEqual(dglab.buildStopPattern(), { cmd: 'stop_pattern' });
  assert.deepStrictEqual(dglab.buildChangeMaxIntensity({ delta: 10 }), { cmd: 'change_max_intensity', delta_intensity: 10 });

  // ===== 2. 郊狼连接适配器翻译 =====
  const dg = new DGLabConnection({ deviceId: 'dglab-1', host: '127.0.0.1', port: 60536, WebSocketClass: MockWebSocket });
  await dg.connect();
  const frame = dg.send({ brand: 'dglab', cmd: 'setPattern', pattern: '经典', intensity: 80, ticks: -1 });
  assert.strictEqual(MockWebSocket.last.sent.length, 1);
  assert.deepStrictEqual(JSON.parse(MockWebSocket.last.sent[0]), { cmd: 'set_pattern', pattern_name: '经典', intensity: 80, ticks: -1 });
  dg.disconnect();

  // ===== 3. 役次元 BLE 帧构造（依据 YSKJ_*_BLE 协议）=====
  assert.strictEqual(hex(ycy.buildEmsStrength({ channel: 'A', value: 100 })), 'AA010164006655'.toUpperCase());
  assert.strictEqual(hex(ycy.buildEmsStop()), 'AA030000000355'.toUpperCase());
  assert.strictEqual(hex(ycy.buildToySpeed({ motor: 'A', speed: 10 })), 'AA11010A001C55');
  assert.strictEqual(hex(ycy.buildToyMode({ motor: 'B', mode: 2 })), 'AA120202001655');

  // ===== 4. 役次元桥接消息构造 + 连接适配器翻译 =====
  assert.deepStrictEqual(
    ycy.buildBridgeSendCommand({ commandId: '_stop_all', token: 't1' }),
    { type: 'sendCommand', commandId: '_stop_all', token: 't1' }
  );
  assert.deepStrictEqual(ycy.parseConnectCode('game_5 mytoken'), { uid: 'game_5', token: 'mytoken' });

  const yb = new YCYConnection({ deviceId: 'ycy-1', mode: 'bridge', WebSocketClass: MockWebSocket });
  await yb.connect({ host: '127.0.0.1', port: 3001, connectCode: 'game_5 mytoken' });
  yb.send({ brand: 'ycy', cmd: 'stopAll' });
  assert.deepStrictEqual(JSON.parse(MockWebSocket.last.sent[MockWebSocket.last.sent.length - 1]),
    { type: 'sendCommand', commandId: '_stop_all', token: 'mytoken' });
  yb.send({ brand: 'ycy', cmd: 'triggerInstruction', commandId: 'player_hurt', token: 'mytoken' });
  assert.deepStrictEqual(JSON.parse(MockWebSocket.last.sent[MockWebSocket.last.sent.length - 1]),
    { type: 'sendCommand', commandId: 'player_hurt', token: 'mytoken' });
  yb.disconnect();

  // BLE 直连路径的帧翻译（不真正连蓝牙，直接校验 toBleFrame）
  assert.strictEqual(hex(ycy.toBleFrame({ brand: 'ycy', cmd: 'setStrength', channel: 'A', value: 50 })),
    hex(ycy.buildEmsStrength({ channel: 'A', value: 50 })));

  // ===== 5. 设备类型层发出品牌命令（接入既有 bridge / devicemap）=====
  const cap = (type, capKey, action, params) => {
    let captured = null;
    registry.getDeviceType(type).invokeCapability('devX', capKey, action, params, (id, msg) => { captured = msg; return msg; });
    return captured;
  };
  const d1 = cap('DGLAB', 'shock', 'start', { voltage: 50 });
  assert.strictEqual(d1.brand, 'dglab');
  assert.strictEqual(d1.cmd, 'setPattern');
  assert.strictEqual(d1.intensity, 50);

  const d2 = cap('DGLAB', 'shock', 'stop', {});
  assert.deepStrictEqual(d2, { brand: 'dglab', cmd: 'stopPattern' });

  const c1 = cap('YCY_EMS', 'shock', 'start', { voltage: 30 });
  assert.strictEqual(c1.brand, 'ycy');
  assert.strictEqual(c1.cmd, 'setStrength');
  assert.strictEqual(c1.channel, 'A');
  assert.strictEqual(c1.value, 30);

  const c2 = cap('YCY_EMS', 'strength', 'set', { value: 70 });
  assert.strictEqual(c2.channel, 'B');
  assert.strictEqual(c2.value, 70);

  const t1 = cap('YCY_TOY', 'strength', 'set', { value: 50 });
  assert.strictEqual(t1.cmd, 'setSpeed');
  assert.strictEqual(t1.motor, 'A');
  assert.strictEqual(t1.speed, 10); // 50/100*20

  const t2 = cap('YCY_TOY', 'strength', 'stop', {});
  assert.deepStrictEqual(t2, { brand: 'ycy', cmd: 'stopToy' });

  // 设备类型已在注册表
  assert.ok(registry.isValidDeviceType('DGLAB'));
  assert.ok(registry.isValidDeviceType('YCY_EMS'));
  assert.ok(registry.isValidDeviceType('YCY_TOY'));

  console.log('ALL BRAND SMOKE TESTS PASSED');
}

run().catch((e) => { console.error('SMOKE TEST FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
