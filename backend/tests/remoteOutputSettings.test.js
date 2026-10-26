const fs = require('fs');
const os = require('os');
const path = require('path');

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// 远程输出上限（持有方/B 端自设）：默认 20V、范围 0–100、持久化，
// 且真的能改变安全层的钳制结果（60V 通过，120V 夹到 100）。
describe('remote output settings', () => {
  let tempDir;
  let previousPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-output-settings-'));
    previousPath = process.env.REMOTE_OUTPUT_SETTINGS_PATH;
    process.env.REMOTE_OUTPUT_SETTINGS_PATH = path.join(tempDir, 'remote-output-settings.json');
    jest.resetModules();
  });

  afterEach(() => {
    restoreEnv('REMOTE_OUTPUT_SETTINGS_PATH', previousPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const load = () => require('../services/remoteOutputSettingsService');

  test('defaults to 20V and leaves the other caps untouched', () => {
    const settings = load();
    expect(settings.status()).toMatchObject({
      voltage: 20,
      range: { min: 0, max: 100 },
      limits: { voltage: 20, power: 128, intensity: 50 },
    });
    expect(fs.existsSync(process.env.REMOTE_OUTPUT_SETTINGS_PATH)).toBe(false);
  });

  test('persists the voltage cap and reloads it from disk', () => {
    const settings = load();
    expect(settings.setVoltage(60).voltage).toBe(60);
    expect(JSON.parse(fs.readFileSync(process.env.REMOTE_OUTPUT_SETTINGS_PATH, 'utf8')))
      .toEqual({ voltage: 60 });
    settings.resetCache();
    expect(settings.getLimits()).toEqual({ voltage: 60, power: 128, intensity: 60 });
  });

  test('clamps the setting to 0–100 and rejects non-numbers', () => {
    const settings = load();
    expect(settings.setVoltage(120).voltage).toBe(100);
    expect(settings.setVoltage(-5).voltage).toBe(0);
    expect(settings.setVoltage('96.6').voltage).toBe(97);
    expect(() => settings.setVoltage('abc')).toThrow(/数字/);
  });

  test('keeps the brand intensity scale at least as high as the voltage cap', () => {
    const settings = load();
    expect(settings.setVoltage(45).limits).toMatchObject({ voltage: 45, intensity: 50 });
    expect(settings.setVoltage(70).limits).toMatchObject({ voltage: 70, intensity: 70 });
  });

  test('the saved cap is what the guard clamps against: 60 passes, 120 becomes 100', () => {
    const settings = load();
    const guard = require('../services/remoteOutputGuard');
    settings.setVoltage(60);
    const shock = (voltage) => guard.sanitizeCapabilityInvoke({
      device: { type: 'CUNZHI01' },
      capability: 'shock',
      action: 'start',
      input: { voltage },
      limits: settings.getLimits(),
    });
    expect(shock(60)).toEqual({ ok: true, input: { voltage: 60 } });
    settings.setVoltage(120);
    expect(shock(120)).toEqual({ ok: true, input: { voltage: 100 } });
  });
});
