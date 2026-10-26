// 远程输出上限（被控端 B 在「远程连接」里自己设）：远控游戏与远程手动设备控制共用一份。
// A（主控端）改不了它：只有本机回环 REST 可写，远程命令白名单里没有对应命令，
// 详见 ADR-2026-09-23-remote-game-client-control「游戏开始设置属于远控范围，其他设置不纳入」。
const fs = require('fs');
const path = require('path');
const outputGuard = require('./remoteOutputGuard');

const FILE_NAME = 'remote-output-settings.json';
const DEFAULT_LIMITS = outputGuard.DEFAULT_REMOTE_LIMITS;
// 持有方只能调电压上限：默认 20，范围 0–100（= 硬上限）。
const DEFAULT_VOLTAGE = DEFAULT_LIMITS.voltage;
const MIN_VOLTAGE = 0;
const MAX_VOLTAGE = outputGuard.HARD_LIMITS.voltage;

let memory;

function filePath() {
  if (process.env.REMOTE_OUTPUT_SETTINGS_PATH) {
    return path.resolve(process.env.REMOTE_OUTPUT_SETTINGS_PATH);
  }
  const root = process.env.BACKEND_DATA_DIR
    ? path.resolve(process.env.BACKEND_DATA_DIR)
    : path.join(__dirname, '..', 'data');
  return path.join(root, FILE_NAME);
}

function clampVoltage(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_VOLTAGE, Math.max(MIN_VOLTAGE, Math.round(n)));
}

function empty() {
  return { voltage: DEFAULT_VOLTAGE };
}

function load() {
  if (memory !== undefined) return memory;
  try {
    const saved = JSON.parse(fs.readFileSync(filePath(), 'utf8')) || {};
    const voltage = clampVoltage(saved.voltage);
    memory = { voltage: voltage === null ? DEFAULT_VOLTAGE : voltage };
  } catch {
    memory = empty();
  }
  return memory;
}

function persist() {
  const dest = filePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify({ voltage: load().voltage }, null, 2) + '\n', 'utf8');
}

/**
 * 安全层实际生效的上限：电压就是持有方设的那个值。
 * intensity 是品牌 0–100 刻度上限，不能低于电压上限，否则电压调多大都会被默认的 50
 * 压回去（electricCap = min(voltage, intensity)）；默认 20 时它仍是 50，行为不变。
 */
function getLimits() {
  const voltage = load().voltage;
  return {
    voltage,
    power: DEFAULT_LIMITS.power,
    intensity: Math.max(DEFAULT_LIMITS.intensity, voltage),
  };
}

function status() {
  return {
    limits: getLimits(),
    voltage: load().voltage,
    range: { min: MIN_VOLTAGE, max: MAX_VOLTAGE },
    defaults: { ...DEFAULT_LIMITS },
  };
}

/** 持有方设置电压上限；超范围夹到 0–100（与安全层 normalizeLimits 同一口径）。 */
function setVoltage(value) {
  const next = clampVoltage(value);
  if (next === null) {
    const error = new Error('电压上限必须是数字');
    error.code = 'OUTPUT_LIMIT_INVALID';
    throw error;
  }
  memory = { voltage: next };
  persist();
  return status();
}

// 测试用：丢掉内存缓存，下次从磁盘重读
function resetCache() {
  memory = undefined;
}

module.exports = {
  FILE_NAME,
  DEFAULT_VOLTAGE,
  MIN_VOLTAGE,
  MAX_VOLTAGE,
  getLimits,
  status,
  setVoltage,
  resetCache,
};
