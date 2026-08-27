// 生成真机对拍用的测试帧 JSON（直接调用 ycy.js 的权威构造器，零漂移）。
const path = require('path');
const ycy = require('/Users/apple/WorkBuddy/2026-08-24-15-31-30/control-panel/backend/brands/protocols/ycy.js');
const fs = require('fs');

const hex = (b) => Buffer.isBuffer(b) ? b.toString('hex').toUpperCase() : Buffer.from(b, 'hex').toString('hex').toUpperCase();

const frames = [
  { label: 'motorStop',    hex: hex(ycy.buildMotor({ speed: 0 })), withResponse: false },
  { label: 'motorSpeed10', hex: hex(ycy.buildMotor({ speed: 10 })), withResponse: false },
  { label: 'emsHandshake', hex: hex(ycy.buildEmsHandshake()), withResponse: false },
  { label: 'emsStop',      hex: hex(ycy.buildEmsStop()), withResponse: false },
  // 泵 v1（AES-128-ECB 密文，16 字节）—— 密钥/模式已确凿，命令字节语义待对拍
  { label: 'pumpV1_add',  hex: hex(ycy.buildPumpEncrypted({ protocol: 'v1', scene: 'add',  ss: 0 })), withResponse: false },
  { label: 'pumpV1_cut',  hex: hex(ycy.buildPumpEncrypted({ protocol: 'v1', scene: 'cut',  ss: 0 })), withResponse: false },
  { label: 'pumpV1_guan', hex: hex(ycy.buildPumpEncrypted({ protocol: 'v1', scene: 'guan', ss: 0 })), withResponse: false },
  { label: 'pumpV1_stop', hex: hex(ycy.buildPumpEncrypted({ protocol: 'v1', scene: 'stop', ss: 0 })), withResponse: false },
  // 泵 v3（明文 35 12 族）
  { label: 'pumpV3_add',  hex: hex(ycy.buildPumpV3({ scene: 'add' })),  withResponse: false },
  { label: 'pumpV3_stop', hex: hex(ycy.buildPumpV3({ scene: 'stop' })), withResponse: false },
  // 查询帧（0x71）：35 71 00 + 校验和(0xA6)，看设备是否回状态
  { label: 'query_0x71', hex: '357100A6', withResponse: false },
];

fs.writeFileSync('/tmp/ycy_frames.json', JSON.stringify(frames, null, 2));
console.log('wrote', frames.length, 'frames to /tmp/ycy_frames.json');
frames.forEach((f) => console.log(' ', f.label.padEnd(14), f.hex));
