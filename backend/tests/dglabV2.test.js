/**
 * DG-LAB V2（Web Bluetooth 直连）协议纯函数测试。
 * 仅依赖纯模块，验证强度 / 波形打包解包往返一致与品牌命令翻译。
 */
const v2 = require('../brands/protocols/dglabV2');

describe('DG-LAB V2 协议（纯函数）', () => {
  test('强度打包/解包（coyote2 布局）往返一致', () => {
    const cases = [
      { a: 0, b: 0 },
      { a: 2047, b: 0 },
      { a: 0, b: 2047 },
      { a: 1024, b: 512 },
      { a: 100, b: 200 },
    ];
    for (const c of cases) {
      const bytes = v2.packStrength(c);
      expect(bytes).toHaveLength(3);
      expect(v2.unpackStrength(bytes)).toEqual(c);
    }
  });

  test('强度范围被钳制到 0–2047', () => {
    const r = v2.unpackStrength(v2.packStrength({ a: 9999, b: -50 }));
    expect(r.a).toBe(2047);
    expect(r.b).toBe(0);
  });

  test('波形打包/解包（xLow 布局）往返一致', () => {
    const cases = [
      { x: 0, y: 0, z: 0 },
      { x: 31, y: 1023, z: 31 },
      { x: 5, y: 200, z: 0 },
      { x: 10, y: 500, z: 15 },
    ];
    for (const c of cases) {
      const bytes = v2.packWaveform(c);
      expect(bytes).toHaveLength(3);
      expect(v2.unpackWaveform(bytes)).toEqual(c);
    }
  });

  test('官方布局与经验布局均为合法往返（标定切换可用）', () => {
    const a = v2.packStrength({ a: 123, b: 456 }, 'official');
    expect(v2.unpackStrength(a, 'official')).toEqual({ a: 123, b: 456 });
    const c = v2.packWaveform({ x: 7, y: 321, z: 9 }, 'xHigh');
    expect(v2.unpackWaveform(c, 'xHigh')).toEqual({ x: 7, y: 321, z: 9 });
  });

  test('UI ↔ 硬件强度换算', () => {
    expect(v2.uiToHwStrength(100)).toBe(2047);
    expect(v2.uiToHwStrength(0)).toBe(0);
    expect(v2.uiToHwStrength(50)).toBe(1024);
    expect(v2.hwToUiStrength(2047)).toBe(100);
    expect(v2.hwStrengthToDisplay(140)).toBe(20);
    expect(v2.hwStrengthToDisplay(2047)).toBe(292);
  });

  test('toGattOps 将品牌命令翻译为 GATT 操作', () => {
    expect(v2.toGattOps({ brand: 'dglab', cmd: 'v2_setStrength', a: 100, b: 50 }))
      .toEqual([{ characteristic: 'pwmAB2', value: v2.packStrength({ a: 100, b: 50 }) }]);
    expect(v2.toGattOps({ brand: 'dglab', cmd: 'v2_setWaveform', channel: 'B', x: 5, y: 200, z: 0 }))
      .toEqual([{ characteristic: 'pwmB34', value: v2.packWaveform({ x: 5, y: 200, z: 0 }) }]);
    expect(v2.toGattOps({ brand: 'dglab', cmd: 'v2_stop' }))
      .toEqual([{ characteristic: 'pwmAB2', value: v2.packStrength({ a: 0, b: 0 }) }]);
    expect(v2.toGattOps({ brand: 'dglab', cmd: 'v2_readBattery' }))
      .toEqual([{ characteristic: 'battery', read: true }]);
  });

  test('toGattOps 对未知指令抛错', () => {
    expect(() => v2.toGattOps({ cmd: 'nope' })).toThrow();
  });

  test('导出 V2 服务 UUID 与广播名关键字', () => {
    expect(v2.V2_UUIDS.service).toBe('955a180b-0fe2-f5aa-a094-84b8d4f3e8ad');
    expect(v2.V2_UUIDS.pwmAB2).toBe('955a1504-0fe2-f5aa-a094-84b8d4f3e8ad');
    expect(v2.DGLAB_V2_NAMES.some((k) => k.includes('D-LAB'))).toBe(true);
  });

  test('App 高层命令 setPattern/stopPattern 翻译为 V2 GATT 操作', () => {
    const set = v2.toGattOps({ cmd: 'setPattern', intensity: 50 });
    expect(set).toHaveLength(3);
    expect(set[0].characteristic).toBe('pwmAB2');
    const s = v2.uiToHwStrength(50);
    expect(set[0].value).toEqual(v2.packStrength({ a: s, b: s }));
    expect(set[1].characteristic).toBe('pwmA34');
    expect(set[2].characteristic).toBe('pwmB34');
    const stop = v2.toGattOps({ cmd: 'stopPattern' });
    expect(stop).toEqual([{ characteristic: 'pwmAB2', value: v2.packStrength({ a: 0, b: 0 }) }]);
  });
});

describe('DG-LAB V2 强度位布局（运行时标定）', () => {
  const v2 = require('../brands/protocols/dglabV2');
  afterEach(() => { v2.setStrengthLayout('coyote2'); }); // 还原默认

  test('setStrengthLayout 在 official/coyote2 间切换并影响打包', () => {
    v2.setStrengthLayout('official');
    expect(v2.getStrengthLayout()).toBe('official');
    const officialBytes = v2.packStrength({ a: 100, b: 50 });
    v2.setStrengthLayout('coyote2');
    expect(v2.getStrengthLayout()).toBe('coyote2');
    const coyoteBytes = v2.packStrength({ a: 100, b: 50 });
    // 两种布局产生的字节应不同（证明位排布确实切换）
    expect(coyoteBytes).not.toEqual(officialBytes);
    // 各自往返一致
    expect(v2.unpackStrength(officialBytes, 'official')).toEqual({ a: 100, b: 50 });
    expect(v2.unpackStrength(coyoteBytes, 'coyote2')).toEqual({ a: 100, b: 50 });
  });

  test('非法布局被忽略且保持原值', () => {
    v2.setStrengthLayout('coyote2');
    expect(v2.setStrengthLayout('bogus')).toBe('coyote2');
  });
});
