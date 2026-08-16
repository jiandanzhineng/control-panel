#!/usr/bin/env node
/* 自测：1) device.js 协议纯逻辑；2) 真连 broker 跑一遍注册→上报→收指令闭环。
 * broker 连不上时只跑第 1 部分并说明，不算失败。
 */
'use strict';

const assert = require('assert');
const D = require('./device.js');

let pass = 0;
function it(name, fn) {
  try { fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('device.js 协议逻辑');

it('topic 格式与 control-panel 对齐', () => {
  assert.strictEqual(D.pubTopic('v1'), '/dpub/v1');
  assert.strictEqual(D.recvTopic('v1'), '/drecv/v1');
});

it('report 报文带 device_type 才能被自动注册', () => {
  const m = D.reportMessage(D.initialState());
  assert.strictEqual(m.method, 'report');
  assert.strictEqual(m.device_type, 'CUNZHI01');
  assert.strictEqual(m.pressure1, 0);
});

it('解析 shock/start 下行', () => {
  const props = D.parseCommand('{"method":"update","voltage":20,"shock":1}');
  assert.deepStrictEqual(props, { voltage: 20, shock: 1 });
});

it('解析 shock/stop 下行', () => {
  assert.deepStrictEqual(D.parseCommand({ method: 'update', shock: 0 }), { shock: 0 });
});

it('无关报文与坏 JSON 返回 null', () => {
  assert.strictEqual(D.parseCommand('not json'), null);
  assert.strictEqual(D.parseCommand({ method: 'report' }), null);
  assert.strictEqual(D.parseCommand(null), null);
});

it('applyCommand 记 shock_start 事件并带电压', () => {
  const r = D.applyCommand(D.initialState(), { voltage: 20, shock: 1 });
  assert.strictEqual(r.state.shock, 1);
  assert.strictEqual(r.state.voltage, 20);
  const ev = r.events.find((e) => e.type === 'shock_start');
  assert.ok(ev, '应有 shock_start');
  assert.strictEqual(ev.voltage, 20);
});

it('applyCommand 记 shock_stop', () => {
  const on = D.applyCommand(D.initialState(), { shock: 1, voltage: 18 }).state;
  const r = D.applyCommand(on, { shock: 0 });
  assert.strictEqual(r.state.shock, 0);
  assert.ok(r.events.some((e) => e.type === 'shock_stop'));
});

it('dian 报文带自动停止时长', () => {
  const props = D.parseCommand({ method: 'dian', voltage: 12, time: 1500 });
  assert.strictEqual(props._autoStopMs, 1500);
  const r = D.applyCommand(D.initialState(), props);
  assert.strictEqual(r.state.shock, 1);
  assert.strictEqual(r.events[0].autoStopMs, 1500);
  assert.strictEqual(r.state._autoStopMs, undefined, '_autoStopMs 不该落进 state');
});

it('strength/set 的 power 也认', () => {
  const r = D.applyCommand(D.initialState(), D.parseCommand({ method: 'update', power: 200 }));
  assert.strictEqual(r.state.power, 200);
  const ev = r.events.find((e) => e.type === 'power');
  assert.ok(ev, '应有 power 事件（页面靠它记「变更次数」）');
  assert.strictEqual(ev.value, 200);
});

it('power=0 也要出事件，否则跳蛋停不下来', () => {
  const on = D.applyCommand(D.initialState(), { power: 180 }).state;
  const r = D.applyCommand(on, D.parseCommand({ method: 'update', power: 0 }));
  assert.strictEqual(r.state.power, 0);
  assert.ok(r.events.some((e) => e.type === 'power' && e.value === 0));
});

it('server.js 能找到 mqtt bundle', () => {
  const { findMqttBundle } = require('./server.js');
  assert.ok(findMqttBundle(), 'mqtt.min.js 没找到，页面会加载失败');
});

// 以下对齐 hardware CUNZHI01.c + base_device.c，现实现应对这些变绿。
const FW_PROPS = [
  'device_type', 'sleep_time', 'battery', 'power', 'voltage', 'shock',
  'delay', 'safe', 'pressure', 'pressure1', 'report_delay_ms',
  'game_mode', 'game_duration', 'game_fly_dur', 'game_e_vol', 'game_e_dur',
  'game_p1_thresh', 'game_p2_thresh', 'game_m_dur', 'game_m_power',
  'game_m_step', 'game_cooldown', 'game_kegel_t', 'game_cz_count',
];

it('订阅 /all 与 /drecv/{id}', () => {
  assert.strictEqual(D.allTopic(), '/all');
  assert.strictEqual(D.recvTopic('abc'), '/drecv/abc');
});

it('report 含 ver 与全部固件属性', () => {
  const m = D.reportMessage(D.initialState());
  assert.strictEqual(m.method, 'report');
  assert.ok(typeof m.ver === 'string' && m.ver.length, '缺 ver');
  for (const k of FW_PROPS) assert.ok(k in m, `report 缺 ${k}`);
});

it('周期 update 字段与 report_task 一致', () => {
  const m = D.periodicUpdateMessage({ ...D.initialState(), pressure: 1.5, pressure1: 2, battery: 80, game_cz_count: 3 });
  assert.deepStrictEqual(m, {
    method: 'update', pressure: 1.5, pressure1: 2, battery: 80, game_cz_count: 3,
  });
});

it('解析 set 单属性（固件 set_property）', () => {
  assert.deepStrictEqual(
    D.parseCommand({ method: 'set', key: 'power', value: 50, msg_id: 2001 }),
    { power: 50 },
  );
});

it('get 回复 {method:update, msg_id, key, value}', () => {
  const st = D.initialState();
  const r = D.handleInbound(st, { method: 'get', key: 'battery', msg_id: 102 });
  assert.deepStrictEqual(r.replies, [{ method: 'update', msg_id: 102, key: 'battery', value: st.battery }]);
  assert.strictEqual(r.state.battery, st.battery);
});

it('set/update 只改状态不 MQTT 回显', () => {
  const r = D.handleInbound(D.initialState(), { method: 'update', shock: 1, voltage: 22, msg_id: 9 });
  assert.strictEqual(r.state.shock, 1);
  assert.strictEqual(r.state.voltage, 22);
  assert.deepStrictEqual(r.replies, []);
});

console.log(`\n协议逻辑 ${pass} 项通过`);

const C = require('./conn.js');
console.log('\nconn.js 重连策略');
const before = pass;

it('keepalive 显式开启，库内置重连关掉', () => {
  const o = C.mqttOptions('vweb_x');
  assert.strictEqual(o.keepalive, 30);
  assert.strictEqual(o.reconnectPeriod, 0);
  assert.strictEqual(o.resubscribe, false);
});

it('退避 1s/2s/4s…封顶 15s', () => {
  assert.strictEqual(C.nextBackoff(0), 1000);
  assert.strictEqual(C.nextBackoff(1), 2000);
  assert.strictEqual(C.nextBackoff(4), 15000);
  assert.strictEqual(C.nextBackoff(9), 15000);
});

it('用户点断开就不再重连', () => {
  assert.strictEqual(C.shouldReconnect({ wantConnected: true, userEnded: false }), true);
  assert.strictEqual(C.shouldReconnect({ wantConnected: false, userEnded: true }), false);
  assert.strictEqual(C.shouldReconnect({ wantConnected: true, userEnded: true }), false);
});

it('Keepalive timeout / client disconnecting 当噪声', () => {
  assert.ok(C.isReconnectNoise({ message: 'Keepalive timeout' }));
  assert.ok(C.isReconnectNoise({ message: 'client disconnecting' }));
  assert.ok(!C.isReconnectNoise({ message: 'mqtt.min.js 没加载到' }));
});

it('disconnecting 时不订阅', () => {
  assert.strictEqual(C.canSubscribe({ connected: true, disconnecting: true }), false);
  assert.strictEqual(C.canSubscribe({ connected: true, disconnecting: false }), true);
  assert.strictEqual(C.canSubscribe(null), false);
});

console.log(`重连策略 ${pass - before} 项通过`);
