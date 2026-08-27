/**
 * DG-LAB 原版 V2（Coyote / 郊狼 2.0）蓝牙直连（Web Bluetooth）协议实现。
 *
 * 协议来源 / 参考：
 *   - DG-LAB-OPENSOURCE / open-DGLAB 公开仓库（V2 蓝牙 GATT 定义）
 *   - coyote2.py（社区 Python 直连实现，作为字节序 / 位布局的经验参考）
 *
 * GATT 服务与特征（Base UUID：955Axxxx-0FE2-F5AA-A094-84B8D4F3E8AD）：
 *   - 服务        : 955A180B-0FE2-F5AA-A094-84B8D4F3E8AD
 *   - 电量        : 955A1500-...            （读 / notify，单字节 0–100%）
 *   - PWM_AB2     : 955A1504-...            A/B 总强度（24bit，每通道 0–2047）
 *   - PWM_A34     : 955A1505-...            通道 A 波形（24bit，X5 / Y10 / Z5）
 *   - PWM_B34     : 955A1506-...            通道 B 波形（24bit，X5 / Y10 / Z5）
 *
 * 强度（S）范围 0–2047，App 端显示强度 = S / 7。
 * 波形（PWM_A34 / PWM_B34）中 频率 = X + Y。
 *
 * ⚠️ 重要（待真机标定）：
 *   官方文档与社区 coyote2.py 对 PWM_AB2 的位布局描述不一致：
 *     - 官方文档：bit10–0 = A 强度，bit21–11 = B 强度
 *     - coyote2.py：A = data >> 13，B = (data >> 2) & 0x3FF（小端 24bit）
 *   本模块默认采用 coyote2.py 的经验布局（STRENGTH_LAYOUT = 'coyote2'），
 *   并将位布局抽成常量，便于在真机上标定后一键切换为 'official'。
 *   字节序统一为小端（little-endian），与 coyote2.py 一致。
 *
 * 本模块为纯函数，无 Electron / 网络依赖，可被后端、渲染进程与测试共同复用。
 */

const BASE_UUID = '955axxxx-0fe2-f5aa-a094-84b8d4f3e8ad';
const SERVICE_SHORT = '180b'; // 0x180B
const HANDLE = {
  battery: '1500', // 0x180A / 0x1500  电量
  pwmAB2: '1504', // 0x180B / 0x1504  A/B 总强度
  pwmA34: '1505', // 0x180B / 0x1505  通道 A 波形
  pwmB34: '1506', // 0x180B / 0x1506  通道 B 波形
};

function expand(shortHandle) {
  return BASE_UUID.replace('xxxx', shortHandle);
}

const V2_UUIDS = Object.freeze({
  service: expand(SERVICE_SHORT),
  battery: expand(HANDLE.battery),
  pwmAB2: expand(HANDLE.pwmAB2),
  pwmA34: expand(HANDLE.pwmA34),
  pwmB34: expand(HANDLE.pwmB34),
});

// 短名 → 完整 UUID 的查表（供渲染进程按短名写 GATT 特征）
const V2_CHAR_BY_NAME = Object.freeze({
  battery: V2_UUIDS.battery,
  pwmAB2: V2_UUIDS.pwmAB2,
  pwmA34: V2_UUIDS.pwmA34,
  pwmB34: V2_UUIDS.pwmB34,
});

const V2_SERVICE = V2_UUIDS.service;

// 原版 V2 设备广播名关键字（Web Bluetooth 发现阶段用于过滤）
const DGLAB_V2_NAMES = ['D-LAB', 'DG-LAB', 'COYOTE', 'YSKJ', 'ESTIM'];

// 数值范围常量
const STRENGTH_HW_MAX = 2047; // 每通道硬件强度上限（S，0–2047）
const WAVE_X_MAX = 31; // 5 bit
const WAVE_Y_MAX = 1023; // 10 bit
const WAVE_Z_MAX = 31; // 5 bit
const BATTERY_MAX = 100;

// 位布局：'coyote2'（默认，经验参考）/ 'official'（官方文档，待标定）
// 运行时可通过 setStrengthLayout() 切换（标定用），env DGLAV2_STRENGTH_LAYOUT 作为初始值。
let STRENGTH_LAYOUT = (process.env.DGLAV2_STRENGTH_LAYOUT === 'official') ? 'official' : 'coyote2';
let WAVE_LAYOUT = 'xLow'; // 'xLow'：x 在低 5 位；'xHigh'：x 在高 5 位

/** 运行时切换强度位布局（'official' | 'coyote2'），返回当前值。未知值忽略。 */
function setStrengthLayout(layout) {
  if (layout === 'official' || layout === 'coyote2') {
    STRENGTH_LAYOUT = layout;
  }
  return STRENGTH_LAYOUT;
}

function getStrengthLayout() {
  return STRENGTH_LAYOUT;
}

// ============ 基础字节工具 ============

function clampInt(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function toLittleEndian24(value) {
  const v = value & 0xffffff;
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
}

function fromLittleEndian24(bytes) {
  if (!bytes || bytes.length < 3) return 0;
  const b = Array.from(bytes).slice(0, 3);
  return (b[0] | (b[1] << 8) | (b[2] << 16)) & 0xffffff;
}

// ============ 强度（PWM_AB2）打包 / 解包 ============

function packStrength({ a = 0, b = 0 } = {}, layout = STRENGTH_LAYOUT) {
  const va = clampInt(a, 0, STRENGTH_HW_MAX);
  const vb = clampInt(b, 0, STRENGTH_HW_MAX);
  let data = 0;
  if (layout === 'official') {
    // 官方文档：bit10–0 = A，bit21–11 = B
    data = ((vb & 0x7ff) << 11) | (va & 0x7ff);
  } else {
    // coyote2.py 经验布局：A = data>>13，B = (data>>2)&0x3FF
    data = ((va & 0x7ff) << 13) | ((vb & 0x7ff) << 2);
  }
  return toLittleEndian24(data);
}

function unpackStrength(bytes, layout = STRENGTH_LAYOUT) {
  const data = fromLittleEndian24(bytes);
  if (layout === 'official') {
    return { a: data & 0x7ff, b: (data >> 11) & 0x7ff };
  }
  return { a: (data >> 13) & 0x7ff, b: (data >> 2) & 0x7ff };
}

// ============ 波形（PWM_A34 / PWM_B34）打包 / 解包 ============
// 24bit = X(5) + Y(10) + Z(5)，默认 xLow：bit4–0 = X，bit14–5 = Y，bit19–15 = Z
// 频率 = X + Y

function packWaveform({ x = 5, y = 200, z = 0 } = {}, layout = WAVE_LAYOUT) {
  const vx = clampInt(x, 0, WAVE_X_MAX);
  const vy = clampInt(y, 0, WAVE_Y_MAX);
  const vz = clampInt(z, 0, WAVE_Z_MAX);
  let data = 0;
  if (layout === 'xHigh') {
    // x 在高 5 位：bit22–18 = X，bit17–8 = Y，bit7–3 = Z（留 3bit 空闲，待标定）
    data = ((vx & 0x1f) << 18) | ((vy & 0x3ff) << 8) | ((vz & 0x1f) << 3);
  } else {
    // xLow：bit4–0 = X，bit14–5 = Y，bit19–15 = Z
    data = ((vz & 0x1f) << 15) | ((vy & 0x3ff) << 5) | (vx & 0x1f);
  }
  return toLittleEndian24(data);
}

function unpackWaveform(bytes, layout = WAVE_LAYOUT) {
  const data = fromLittleEndian24(bytes);
  if (layout === 'xHigh') {
    return { x: (data >> 18) & 0x1f, y: (data >> 8) & 0x3ff, z: (data >> 3) & 0x1f };
  }
  return { x: data & 0x1f, y: (data >> 5) & 0x3ff, z: (data >> 15) & 0x1f };
}

// ============ UI ↔ 硬件 强度换算 ============

function uiToHwStrength(uiValue, uiMax = 100, hwMax = STRENGTH_HW_MAX) {
  const n = Number(uiValue);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(0, Math.min(uiMax, n)) / uiMax * hwMax);
}

function hwToUiStrength(hwValue, uiMax = 100, hwMax = STRENGTH_HW_MAX) {
  const n = Number(hwValue);
  if (!Number.isFinite(n)) return 0;
  return Math.round((Math.max(0, Math.min(hwMax, n)) / hwMax) * uiMax);
}

// App 显示强度 = S / 7
function hwStrengthToDisplay(hwValue) {
  return Math.round(clampInt(hwValue, 0, STRENGTH_HW_MAX) / 7);
}

// ============ 品牌命令 → GATT 操作 ============
// 返回操作数组：{ characteristic: 'pwmAB2'|'pwmA34'|'pwmB34'|'battery', value?: number[], read?: boolean }
//
// 同时接受两套命令，使同一 DGLAB 设备类型（被玩法 / 设备映射复用）既能驱动
// App「娱乐模式」WebSocket 路径，也能驱动原版 V2 蓝牙直连路径：
//   - 高层 App 命令：setPattern / stopPattern（intensity 0–100）
//   - V2 专用命令：  v2_setStrength / v2_setWaveform / v2_stop / v2_readBattery

// 默认波形（与「经典」模式近似）：频率 X+Y，Z 为占空微调
const DEFAULT_WAVE = { x: 5, y: 200, z: 0 };

function normalizeWaveform(wave) {
  if (wave == null || wave === '') return null;
  if (typeof wave === 'object') {
    if (wave.x === undefined || wave.y === undefined) {
      const error = new Error('DG-LAB V2 波形需要 x/y/z 参数');
      error.code = 'DGLAB_WAVEFORM_INVALID';
      throw error;
    }
    return { x: wave.x, y: wave.y, z: wave.z ?? 0 };
  }
  // V2 GATT 接收的是已编码的 x/y/z，不接受 YCY 那种 1..16 预设编号。
  const error = new Error('DG-LAB V2 不支持波形预设编号，请传入 { x, y, z }');
  error.code = 'DGLAB_WAVE_PRESET_UNSUPPORTED';
  throw error;
}

function toGattOps(brandCommand) {
  const cmd = brandCommand?.cmd;
  switch (cmd) {
    case 'v2_setStrength':
      return [{
        characteristic: 'pwmAB2',
        value: packStrength({ a: brandCommand.a, b: brandCommand.b }),
      }];
    case 'v2_setWaveform': {
      const name = brandCommand.channel === 'B' ? 'pwmB34' : 'pwmA34';
      return [{
        characteristic: name,
        value: packWaveform({ x: brandCommand.x, y: brandCommand.y, z: brandCommand.z }),
      }];
    }
    case 'v2_stop':
      return [{ characteristic: 'pwmAB2', value: packStrength({ a: 0, b: 0 }) }];
    case 'v2_readBattery':
      return [{ characteristic: 'battery', read: true }];
    case 'setEstim': {
      const a = brandCommand.a !== undefined
        ? brandCommand.a
        : uiToHwStrength(brandCommand.intensity, 255, STRENGTH_HW_MAX);
      const b = brandCommand.b !== undefined
        ? brandCommand.b
        : uiToHwStrength(brandCommand.intensity, 255, STRENGTH_HW_MAX);
      const ops = [{ characteristic: 'pwmAB2', value: packStrength({ a, b }) }];
      const wave = normalizeWaveform(brandCommand.wave);
      if (wave) {
        const channel = String(brandCommand.channel || 'ab').toLowerCase();
        if (channel === 'a' || channel === 'ab') ops.push({ characteristic: 'pwmA34', value: packWaveform(wave) });
        if (channel === 'b' || channel === 'ab') ops.push({ characteristic: 'pwmB34', value: packWaveform(wave) });
      }
      return ops;
    }
    // —— 高层 App 命令：娱乐模式与 V2 蓝牙共用同一设备类型 ——
    case 'setPattern': {
      // intensity 0–100 → 硬件强度（A/B 同步），波形取默认
      const s = uiToHwStrength(Number(brandCommand.intensity) || 0, 100, STRENGTH_HW_MAX);
      return [
        { characteristic: 'pwmAB2', value: packStrength({ a: s, b: s }) },
        { characteristic: 'pwmA34', value: packWaveform(DEFAULT_WAVE) },
        { characteristic: 'pwmB34', value: packWaveform(DEFAULT_WAVE) },
      ];
    }
    case 'stopPattern':
      return [{ characteristic: 'pwmAB2', value: packStrength({ a: 0, b: 0 }) }];
    default:
      throw new Error(`未知的 DG-LAB V2 指令: ${cmd}`);
  }
}

module.exports = {
  BASE_UUID,
  V2_UUIDS,
  V2_SERVICE,
  V2_CHAR_BY_NAME,
  DGLAB_V2_NAMES,
  STRENGTH_HW_MAX,
  WAVE_X_MAX,
  WAVE_Y_MAX,
  WAVE_Z_MAX,
  BATTERY_MAX,
  STRENGTH_LAYOUT,
  WAVE_LAYOUT,
  setStrengthLayout,
  getStrengthLayout,
  clampInt,
  toLittleEndian24,
  fromLittleEndian24,
  packStrength,
  unpackStrength,
  packWaveform,
  unpackWaveform,
  uiToHwStrength,
  hwToUiStrength,
  hwStrengthToDisplay,
  normalizeWaveform,
  toGattOps,
};
