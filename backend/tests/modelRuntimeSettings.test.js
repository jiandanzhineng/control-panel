const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-settings-'));
process.env.BACKEND_DATA_DIR = dir;
const settings = require('../model-runtime/settings');

afterAll(() => {
  delete process.env.BACKEND_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('model runtime settings', () => {
  beforeEach(() => settings.resetForTests());

  test('keeps the task map prototype-free', () => {
    settings.update('asr', { localEnabled: true });
    expect(Object.getPrototypeOf(settings.all())).toBeNull();
    expect(settings.all().__proto__).toBeUndefined();
  });

  test('rejects prototype-pollution task names', () => {
    for (const task of ['__proto__', '../evil', 'bad name']) {
      expect(() => settings.update(task, { localEnabled: true }))
        .toThrow(expect.objectContaining({ code: 'INVALID_TASK' }));
      expect(settings.get(task)).toMatchObject({ localEnabled: false });
    }
    expect({}.localEnabled).toBeUndefined();
  });

  test('ignores malformed tasks loaded from disk', () => {
    settings.resetForTests();
    fs.writeFileSync(
      path.join(dir, 'model-runtime-settings.json'),
      '{"tasks":{"asr":{"localEnabled":true},"__proto__":{"localEnabled":true},"bad name":{"localEnabled":true}}}',
    );
    expect(settings.get('asr').localEnabled).toBe(true);
    expect(Object.keys(settings.all())).toEqual(['asr']);
  });
});
