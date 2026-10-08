/**
 * 心率测量帧（HRS 0x2A37）解析测试。
 * 用例数值取自 tools/hrm-c3-mock 固件实际发送的帧型。
 */
const hrs = require('../brands/protocols/hrs');

describe('hrs 帧解析', () => {
  test('8 位心率 + 接触位（固件默认帧）', () => {
    // flags=0x06（支持+已接触）, hr=72
    const parsed = hrs.parseMeasurement(Buffer.from([0x06, 72]));
    expect(parsed.heartRate).toBe(72);
    expect(parsed.contactSupported).toBe(true);
    expect(parsed.contactDetected).toBe(true);
    expect(parsed.energyKj).toBeUndefined();
    expect(parsed.rrIntervals).toBeUndefined();
  });

  test('16 位心率（flags bit0）', () => {
    const buf = Buffer.alloc(3);
    buf[0] = 0x01;
    buf.writeUInt16LE(310, 1);
    expect(hrs.parseMeasurement(buf).heartRate).toBe(310);
  });

  test('能量消耗与多组 RR 间期', () => {
    // flags=0x1e：支持/已接触 + 能量 + RR；hr=150, energy=7kJ, RR=410/409
    const buf = Buffer.from([0x1e, 150, 0x07, 0x00, 0x9a, 0x01, 0x99, 0x01]);
    const parsed = hrs.parseMeasurement(buf);
    expect(parsed.heartRate).toBe(150);
    expect(parsed.energyKj).toBe(7);
    // 410 / 1024 * 1000 ≈ 400ms
    expect(parsed.rrIntervals).toEqual([400, 399]);
    expect(parsed.rrInterval).toBe(399);
  });

  test('接触未检测：flags 只有支持位，心率 0', () => {
    const parsed = hrs.parseMeasurement(Buffer.from([0x02, 0]));
    expect(parsed.contactSupported).toBe(true);
    expect(parsed.contactDetected).toBe(false);
    expect(hrs.statusFromMeasurement(parsed)).toBe('no_contact');
  });

  test('不带接触检测位时状态为 ok', () => {
    const parsed = hrs.parseMeasurement(Buffer.from([0x00, 88]));
    expect(parsed.contactSupported).toBeUndefined();
    expect(hrs.statusFromMeasurement(parsed)).toBe('ok');
  });

  test('帧过短 / 字段缺失抛错', () => {
    expect(() => hrs.parseMeasurement(Buffer.from([0x06]))).toThrow(/过短/);
    expect(() => hrs.parseMeasurement(Buffer.from([0x01, 0x01]))).toThrow(/心率字段/);
    expect(() => hrs.parseMeasurement(Buffer.from([0x08, 72]))).toThrow(/能量消耗/);
    expect(() => hrs.parseMeasurement(Buffer.from([0x10, 72]))).toThrow(/RR/);
  });

  test('RR 换算：1/1024 秒 → 毫秒', () => {
    expect(hrs.rrToMs(1024)).toBe(1000);
    expect(hrs.rrToMs(614)).toBe(600);
  });
});

describe('hrs 属性映射', () => {
  test('完整帧映射为设备属性', () => {
    const props = hrs.toProps(hrs.parseMeasurement(Buffer.from([0x1e, 120, 0x02, 0x00, 0x66, 0x01])));
    expect(props).toEqual({
      heart_rate: 120,
      hr_status: 'ok',
      hr_contact: 1,
      energy: 2,
      rr_interval: 350,
    });
  });

  test('无接触帧：心率 0 + no_contact + hr_contact=0', () => {
    expect(hrs.toProps(hrs.parseMeasurement(Buffer.from([0x02, 0])))).toEqual({
      heart_rate: 0,
      hr_status: 'no_contact',
      hr_contact: 0,
    });
  });

  test('不支持接触检测时不写 hr_contact', () => {
    const props = hrs.toProps(hrs.parseMeasurement(Buffer.from([0x00, 90])));
    expect(props).toEqual({ heart_rate: 90, hr_status: 'ok' });
    expect('hr_contact' in props).toBe(false);
  });
});
