#!/usr/bin/env node
/** 真机：扫描 YCY-FJB-03，写 6 字节 FJB 帧。 */
const path = require('path');
const ycy = require(path.join(__dirname, '../backend/brands/protocols/ycy'));
const { NobleBle } = require(path.join(__dirname, '../backend/brands/nobleBle'));

(async () => {
  const ble = new NobleBle();
  console.log('scan ycy...');
  const found = await ble.scan({ brand: 'ycy', timeoutMs: 8000 });
  console.log('found', found);
  const hit = found.find((d) => /FJB/i.test(d.name)) || found[0];
  if (!hit) {
    console.error('NO_DEVICE');
    process.exit(2);
  }
  const info = await ble.connect(hit.address);
  console.log('connected', info);
  const frame = ycy.buildFjb03({ stroke: 8, vibe: 4, axis: 0 });
  const out = await ble.write(hit.address, frame);
  console.log('wrote', out);
  await ble.disconnect(hit.address);
  console.log('OK');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
