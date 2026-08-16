#!/usr/bin/env node
/* 真链路验证：连 broker 冒充设备 -> control-panel 自动注册 -> HTTP 读到压力
 * -> HTTP 下发电击 -> 设备侧收到 /drecv 报文。用完删掉设备。
 * 用法: node e2e.js [--broker ws://127.0.0.1:8083/mqtt] [--api http://127.0.0.1:3000]
 */
'use strict';

const mqtt = require('../backend/node_modules/mqtt');
const D = require('./device.js');

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const BROKER = arg('--broker', 'ws://127.0.0.1:8083/mqtt');
const API = arg('--api', 'http://127.0.0.1:3000');
const ID = arg('--id', `vweb-e2e-${Date.now().toString().slice(-6)}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const step = (ok, msg) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${msg}`);
  if (!ok) failed = true;
};

async function api(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

async function main() {
  console.log(`broker=${BROKER}\napi=${API}\nid=${ID}\n`);

  const received = [];
  const client = mqtt.connect(BROKER, { clientId: `e2e_${ID}`, connectTimeout: 5000 });

  await new Promise((res, rej) => {
    client.on('connect', res);
    client.on('error', rej);
    setTimeout(() => rej(new Error('broker 连接超时')), 6000);
  });
  step(true, 'broker 已连接');

  await new Promise((res, rej) =>
    client.subscribe(D.recvTopic(ID), (e) => (e ? rej(e) : res())));
  client.on('message', (t, p) => received.push(p.toString()));

  let state = { ...D.initialState(), pressure1: 42 };
  client.publish(D.pubTopic(ID), JSON.stringify(D.reportMessage(state)));
  await sleep(900);

  const dev = await api('GET', `/api/devices/${ID}`);
  step(dev.status === 200, `control-panel 自动注册设备 (HTTP ${dev.status})`);
  step(dev.json && dev.json.type === 'CUNZHI01', `设备类型识别为 CUNZHI01 (${dev.json && dev.json.type})`);

  client.publish(D.pubTopic(ID), JSON.stringify(D.updateMessage({ pressure1: 55 })));
  await sleep(700);
  const mon = await api('GET', `/api/devices/${ID}/monitor-data`);
  const got = mon.json && mon.json.data && mon.json.data.pressure1;
  step(Number(got) === 55, `monitor-data 读到 pressure1=55 (实得 ${got})`);

  const inv = await api('POST', `/api/devices/${ID}/capabilities/shock/actions/start`,
                        { input: { voltage: 22 } });
  step(inv.status === 200, `下发 shock/start (HTTP ${inv.status})`);
  await sleep(700);

  const cmd = received.map((r) => { try { return JSON.parse(r); } catch (_) { return {}; } })
                      .find((m) => m.shock === 1);
  step(!!cmd, `设备侧收到下行电击报文 (共 ${received.length} 条)`);
  step(cmd && Number(cmd.voltage) === 22, `电压透传正确 (${cmd && cmd.voltage})`);

  const props = D.parseCommand(received.find((r) => r.includes('shock')) || '');
  const applied = props ? D.applyCommand(state, props) : null;
  step(applied && applied.state.shock === 1 && applied.events.some((e) => e.type === 'shock_start'),
       '页面逻辑据此点亮电击状态');

  // 跳蛋强度：strength/set -> power，页面的紫色卡片读的就是它
  const setv = await api('POST', `/api/devices/${ID}/capabilities/strength/actions/set`,
                         { input: { value: 180 } });
  step(setv.status === 200, `下发 strength/set value=180 (HTTP ${setv.status})`);
  await sleep(700);

  const pcmd = received.map((r) => { try { return JSON.parse(r); } catch (_) { return {}; } })
                       .find((m) => m.power !== undefined);
  step(pcmd && Number(pcmd.power) === 180, `设备侧收到 power=180 (实得 ${pcmd && pcmd.power})`);

  const vapplied = pcmd ? D.applyCommand(state, D.parseCommand(pcmd)) : null;
  step(vapplied && vapplied.state.power === 180
       && vapplied.events.some((e) => e.type === 'power' && e.value === 180),
       '页面逻辑据此显示强度 180（71%）');

  await api('DELETE', `/api/devices/${ID}`);
  client.end(true);
  console.log(failed ? '\n有失败项' : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('异常:', e.message); process.exit(1); });
