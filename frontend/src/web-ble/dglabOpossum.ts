/**
 * 负鼠振动控制器（DG-LAB 47L127000）前端帧构造（本地副本，与后端 dglabOpossum.js 同源）。
 * 事实来源：dungeonlab-open/dglab-bluetooth-protocol → opossum-vibrate-controller（2026-08-26 对齐）。
 * 与郊狼3.0 共用 GATT（服务 0x180C / 写 0x150A / 通知 0x150B）；写特征不写死，
 * 由桥缓存的真实写特征下发（dglabBridge.send(frame) 不传 write）。
 */
const BASE = '0000xxxx-0000-1000-8000-00805f9b34fb';
function expand(short: string): string {
  return BASE.replace('xxxx', short);
}
export const OPOSSUM_UUIDS = {
  serviceCmd: expand('180c'),
  WRITE: expand('150a'),
  NOTIFY: expand('150b'),
  serviceInfo: expand('180a'),
  BATTERY: expand('1500'),
} as const;
export const OPOSSUM_NAMES = ['47L127000'];
const MAX_STRENGTH = 200;
export function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}
function clampStrength(v: number): number {
  v = Math.round(Number(v) || 0);
  if (v < 0) return 0;
  if (v > MAX_STRENGTH) return MAX_STRENGTH;
  return v;
}
/** B3 通道强度：0xB3 + A(0-200) + B(0-200)，0xFF 表示不修改该通道。 */
export function buildB3Frame({ a = 0, b = 0 }: { a?: number; b?: number } = {}): number[] {
  const av = a === null || a === undefined || a === 0xff ? 0xff : clampStrength(a);
  const bv = b === null || b === undefined || b === 0xff ? 0xff : clampStrength(b);
  return [0xb3, av & 0xff, bv & 0xff];
}
export type OpossumCommand = { cmd: 'op_setStrength'; a: number; b: number };
export function toGattOps(command: OpossumCommand): { write: string; frame: string } {
  switch (command.cmd) {
    case 'op_setStrength':
      return { write: OPOSSUM_UUIDS.WRITE, frame: bytesToHex(buildB3Frame({ a: command.a, b: command.b })) };
    default:
      throw new Error('[opossum] 未支持指令');
  }
}
