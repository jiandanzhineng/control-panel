const v3 = require('../brands/protocols/dglabV3');

function hex(arr) {
  return Buffer.from(arr).toString('hex').toUpperCase();
}

describe('DG-LAB V3 协议', () => {
  test('官方 No.1 向量：不改强度、A 通道波形', () => {
    const frame = v3.packB0({
      seq: 0,
      interpretA: v3.INTERPRET.none,
      interpretB: v3.INTERPRET.none,
      a: 0,
      b: 0,
      waveA: { freq: [10, 10, 10, 10], intensity: [0, 10, 20, 30] },
      waveB: { freq: [0, 0, 0, 0], intensity: [0, 0, 0, 101] },
    });
    expect(frame).toHaveLength(20);
    expect(hex(frame)).toBe('B00000000A0A0A0A000A141E0000000000000065');
  });

  test('相对增加 A：seq=0 interpret=0b0100', () => {
    const frame = v3.packB0({
      seq: 0,
      interpretA: v3.INTERPRET.inc,
      interpretB: v3.INTERPRET.none,
      a: 5,
      b: 0,
      waveA: { freq: [10, 10, 10, 10], intensity: [0, 10, 20, 30] },
      waveB: { freq: [0, 0, 0, 0], intensity: [0, 0, 0, 101] },
    });
    expect(hex(frame)).toBe('B00405000A0A0A0A000A141E0000000000000065');
  });

  test('BF 默认软上限 200/200', () => {
    expect(hex(v3.packBf())).toBe('BFC8C880808080');
    expect(v3.packBf()).toHaveLength(7);
  });

  test('UI 0–100 映射到 0–200', () => {
    expect(v3.uiToHwStrength(0)).toBe(0);
    expect(v3.uiToHwStrength(50)).toBe(100);
    expect(v3.uiToHwStrength(100)).toBe(200);
  });

  test('47L 是 3.0，写特征 150A', () => {
    expect(v3.isV3Name('47L121000')).toBe(true);
    expect(v3.isV3Name('D-LAB ESTIM01')).toBe(false);
    expect(v3.isV3WriteUuid('150a')).toBe(true);
    expect(v3.isV3WriteUuid('0000150a-0000-1000-8000-00805f9b34fb')).toBe(true);
    expect(v3.isV3WriteUuid('2a00')).toBe(false);
  });

  test('setPattern/stopPattern 更新强度状态', () => {
    const on = v3.applyCommand({ a: 0, b: 0 }, { cmd: 'setPattern', intensity: 50 });
    expect(on).toEqual({ a: 100, b: 100 });
    expect(v3.applyCommand(on, { cmd: 'stopPattern' })).toEqual({ a: 0, b: 0 });
  });

  test('setEstim 分通道保留另一通道', () => {
    const a = v3.applyCommand({ a: 0, b: 40 }, { cmd: 'setEstim', channel: 'A', intensity: 128 });
    expect(a).toEqual({ a: 100, b: 40 });
    const b = v3.applyCommand(a, { cmd: 'setEstim', channel: 'B', intensity: 0 });
    expect(b).toEqual({ a: 100, b: 0 });
  });

  test('nextB0 绝对强度且停机通道静音', () => {
    const frame = v3.nextB0({ a: 40, b: 0 });
    expect(frame[0]).toBe(0xB0);
    expect(frame[1]).toBe(0x0F);
    expect(frame[2]).toBe(40);
    expect(frame[3]).toBe(0);
    expect(frame.slice(16, 20)).toEqual([0, 0, 0, 101]);
  });
});
